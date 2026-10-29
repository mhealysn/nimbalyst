import type { TrackerSnapshot } from '@nimbalyst/extension-sdk';

export const DEFAULT_JIRA_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
export interface JiraCredentials { siteUrl: string; email: string; apiToken: string }
export interface JiraProjectSettings { jql: string; autoSyncMinutes: number; acceptanceCriteriaFieldIds?: string[] }
export interface JiraSyncResult { created: number; refreshed: number; skipped: number; errors: string[] }
/** Only these deliberately sanitized errors may be surfaced by the sync coordinator. */
export class JiraError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}
interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: AdfNode[];
}

function safeLink(value: unknown): string {
  const url = String(value ?? '');
  return /^(https?:|mailto:)/i.test(url) ? url.replace(/[()\s]/g, (c) => encodeURIComponent(c)) : '';
}

/** Preserve text even for ADF node types this renderer does not yet recognize. */
export function adfToMarkdown(value: unknown): string {
  function render(node: AdfNode): string {
    const children = (node.content ?? []).map(render).join('');
    switch (node.type) {
      case 'text': {
        let text = (node.text ?? '').replace(/([\\`*_\[\]<>])/g, '\\$1');
        for (const mark of node.marks ?? []) {
          if (mark.type === 'strong') text = `**${text}**`;
          if (mark.type === 'em') text = `*${text}*`;
          if (mark.type === 'strike') text = `~~${text}~~`;
          if (mark.type === 'code') text = `\`${(node.text ?? '').replace(/`/g, '\\`')}\``;
          if (mark.type === 'link' && safeLink(mark.attrs?.href)) text = `[${text}](${safeLink(mark.attrs?.href)})`;
        }
        return text;
      }
      case 'hardBreak': return '  \n';
      case 'paragraph': return `${children}\n\n`;
      case 'heading': return `${'#'.repeat(Math.max(1, Math.min(6, Number(node.attrs?.level) || 1)))} ${children}\n\n`;
      case 'bulletList':
      case 'orderedList': return (node.content ?? []).map((item, index) => {
        const lines = render(item).trimEnd().split('\n');
        const prefix = node.type === 'bulletList' ? '- ' : `${Number(node.attrs?.order ?? 1) + index}. `;
        return prefix + lines.join(`\n${' '.repeat(prefix.length)}`);
      }).join('\n') + '\n\n';
      case 'blockquote': return children.trimEnd().split('\n').map(line => `> ${line}`).join('\n') + '\n\n';
      case 'codeBlock': {
        const raw = (nodes: AdfNode[]): string => nodes.map(n => n.text ?? raw(n.content ?? [])).join('');
        const code = raw(node.content ?? []);
        const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map(m => m[0].length + 1)));
        return `${fence}${String(node.attrs?.language ?? '').replace(/[^\w+-]/g, '')}\n${code}\n${fence}\n\n`;
      }
      case 'rule': return '---\n\n';
      case 'mention': return String(node.attrs?.text ?? node.attrs?.id ?? '');
      case 'emoji': return String(node.attrs?.text ?? node.attrs?.shortName ?? '');
      case 'status': return String(node.attrs?.text ?? '');
      case 'date': {
        const date = new Date(Number(node.attrs?.timestamp));
        return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
      }
      case 'inlineCard':
      case 'blockCard': return safeLink(node.attrs?.url);
      case 'media': return `[Attachment: ${String(node.attrs?.alt ?? node.attrs?.id ?? 'attachment')}]`;
      case 'table': return (node.content ?? []).map(row => '| ' + (row.content ?? []).map(cell => render(cell).trim().replace(/\n+/g, '<br>').replace(/\|/g, '\\|')).join(' | ') + ' |').map((row, i) => i === 0 ? row + '\n| ' + (node.content?.[0]?.content ?? []).map(() => '---').join(' | ') + ' |' : row).join('\n') + '\n\n';
      default: return children;
    }
  }
  return value && typeof value === 'object' ? render(value as AdfNode).trim() : typeof value === 'string' ? value : '';
}

export function normalizeJiraSite(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a valid Jira HTTPS site URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Enter the Jira HTTPS site URL without a path or credentials.');
  }
  return url.origin;
}

export interface JiraIssue { key: string; names?: Record<string, string>; fields: { summary: string; description?: unknown; [field: string]: unknown } }
interface JiraComment { id?: string; author?: { displayName?: string; accountId?: string }; created: string; updated?: string; body?: unknown }

function availability(error: unknown): string {
  return error instanceof JiraError && (error.status === 401 || error.status === 403 || error.status === 404)
    ? 'inaccessible (authentication, permission, or issue visibility)'
    : 'request failed (not evidence of absence)';
}

function fieldEvidence(fields: Record<string, unknown>, id: string): string {
  if (!Object.hasOwn(fields, id)) return '(Unavailable: field omitted by Jira; access or applicability unknown.)';
  const value = fields[id];
  if (value == null || value === '') return '(Absent: Jira returned an empty field.)';
  return adfToMarkdown(value) || JSON.stringify(value);
}

export class JiraClient {
  readonly siteUrl: string;
  constructor(private credentials: JiraCredentials, private fetcher: typeof fetch = fetch, private acceptanceCriteriaFieldIds: string[] = []) {
    this.siteUrl = normalizeJiraSite(credentials.siteUrl);
  }

  async request<T>(path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.siteUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Basic ${btoa(Array.from(new TextEncoder().encode(`${this.credentials.email}:${this.credentials.apiToken}`), byte => String.fromCharCode(byte)).join(''))}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new JiraError('Jira network request failed. Check your connection and site URL.'); }
    if (!response.ok) {
      if (response.status === 401) throw new JiraError('Jira credentials were rejected. Check your email and API token.', 401);
      if (response.status === 403) throw new JiraError('Jira permission denied. Check your token and issue access.', 403);
      if (response.status === 400) throw new JiraError('Jira rejected the request. Check your JQL in project settings.', 400);
      if (response.status === 429) throw new JiraError('Jira rate limit reached. Try again later.', 429);
      throw new JiraError(`Jira is unavailable or the issue cannot be read (HTTP ${response.status}).`, response.status);
    }
    try { return await response.json() as T; } catch { throw new JiraError('Jira returned an invalid response.'); }
  }

  async *search(jql: string): AsyncGenerator<JiraIssue> {
    let nextPageToken: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.request<{ issues: JiraIssue[]; names?: Record<string, string>; nextPageToken?: string; isLast?: boolean }>('/rest/api/3/search/jql', {
        jql, maxResults: 100, fields: ['*all'], expand: ['names'], ...(nextPageToken ? { nextPageToken } : {}),
      });
      if (!Array.isArray(page.issues)) throw new JiraError('Jira returned an invalid search page.');
      for (const issue of page.issues) yield { ...issue, names: issue.names ?? page.names };
      nextPageToken = page.isLast ? undefined : page.nextPageToken;
      if (nextPageToken && seen.has(nextPageToken)) throw new JiraError('Jira returned a repeated search page. Retry sync.');
      if (nextPageToken) seen.add(nextPageToken);
    } while (nextPageToken);
  }

  async fetchSnapshot(key: string): Promise<TrackerSnapshot> {
    if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(key)) throw new JiraError('Invalid Jira issue key.');
    return this.snapshot(await this.request<JiraIssue>(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=*all&expand=names`));
  }

  async snapshot(issue: JiraIssue): Promise<TrackerSnapshot> {
    if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(issue?.key) || typeof issue.fields?.summary !== 'string') throw new JiraError('Jira returned an invalid issue.');
    const comments: JiraComment[] = [];
    const seenComments = new Set<string>();
    let startAt = 0;
    let commentAvailability = '';
    try {
      while (true) {
        const page = await this.request<{ comments: JiraComment[]; total: number; startAt?: number }>(`/rest/api/3/issue/${encodeURIComponent(issue.key)}/comment?startAt=${startAt}&maxResults=100&orderBy=created`);
        if (!Array.isArray(page.comments) || !Number.isInteger(page.total) || page.total < 0 || (page.startAt !== undefined && page.startAt !== startAt)) throw new JiraError('Jira returned an invalid comment page.');
        let added = 0;
        for (const comment of page.comments) {
          const id = comment.id ?? JSON.stringify(comment);
          if (!seenComments.has(id)) { comments.push(comment); seenComments.add(id); added++; }
        }
        if (added !== page.comments.length) throw new JiraError('Jira returned repeated comments; completeness is unknown.');
        startAt += page.comments.length;
        if (startAt >= page.total) {
          commentAvailability = `${comments.length ? 'Retrieved all' : 'Absent: no'} comments visible to the Jira account (${comments.length}). Restricted comments not disclosed by Jira cannot be enumerated.`;
          break;
        }
        if (!added) throw new JiraError('Jira comments pagination stopped before all comments were read.');
      }
    } catch (error) {
      commentAvailability = `Partial/unavailable comments: ${availability(error)}; retained ${comments.length} accessible comments. Continuation: ${this.siteUrl}/rest/api/3/issue/${encodeURIComponent(issue.key)}/comment?startAt=${startAt}&maxResults=100&orderBy=created (requires authorized Jira access).`;
    }
    const title = `${issue.key} ${issue.fields.summary}`;
    const url = `${this.siteUrl}/browse/${issue.key}`;
    const discoveredFields = Object.entries(issue.names ?? {}).filter(([, name]) => /\bacceptance[\s_-]*(criteria|conditions|tests)\b/i.test(name)).map(([id]) => id);
    const acceptanceFields = [...new Set([...this.acceptanceCriteriaFieldIds, ...discoveredFields])];
    const criteria = acceptanceFields.length
      ? acceptanceFields.map(id => `### ${issue.names?.[id] ?? 'Configured acceptance criteria'} (${id})\n\n${fieldEvidence(issue.fields, id)}`).join('\n\n')
      : issue.names
        ? 'No acceptance-criteria custom field was discoverable in Jira field names for this account. Acceptance criteria may be embedded in the description; undisclosed fields are unknown.'
        : 'Custom-field mapping unavailable: Jira did not return field names. Acceptance criteria may be in the description; custom-field completeness is unknown.';
    const body = [`[${issue.key}](${url})`, '## Description', fieldEvidence(issue.fields, 'description'), '## Acceptance criteria', criteria, '## Jira comments', commentAvailability,
      ...comments.map(c => `### ${c.author?.displayName ?? c.author?.accountId ?? 'Unknown author'} — ${c.created}${c.updated && c.updated !== c.created ? ` (updated ${c.updated})` : ''}\n\n${fieldEvidence(c as unknown as Record<string, unknown>, 'body')}`)].join('\n\n');
    return { primaryType: 'task', title, body, status: 'open', external: { providerId: 'jira', externalId: issue.key, urn: `jira://${new URL(this.siteUrl).host}/${issue.key}`, url, titleSnapshot: title, stateSnapshot: 'open' } };
  }
}
