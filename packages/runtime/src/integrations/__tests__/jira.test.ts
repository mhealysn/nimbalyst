// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { adfToMarkdown, JiraClient, DEFAULT_JIRA_JQL } from '../jira';

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('Jira Cloud', () => {
  it('converts structured descriptions without losing unsupported node children', () => {
    expect(adfToMarkdown({ type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Details' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [doc('first').content[0]] }] },
      { type: 'panel', content: [doc('Important').content[0]] },
      { type: 'paragraph', content: [{ type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] },
    ] })).toContain('## Details\n\n- first\n\nImportant\n\n[docs](https://example.com)');
  });

  it('paginates search and all comments and builds native task snapshots', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ issues: [{ key: 'APP-1', fields: { summary: 'First', description: doc('Full details') } }], nextPageToken: 'next' }))
      .mockResolvedValueOnce(response({ comments: [{ author: { displayName: 'Alice' }, created: '2026-01-01', body: doc('Hello') }], total: 2 }))
      .mockResolvedValueOnce(response({ comments: [{ author: { displayName: 'Bob' }, created: '2026-01-02', body: doc('Second') }], total: 2 }))
      .mockResolvedValueOnce(response({ issues: [], isLast: true }));
    const client = new JiraClient({ siteUrl: 'https://team.atlassian.net/', email: 'me@example.com', apiToken: 'secret' }, fetcher);
    const snapshots = [];
    for await (const issue of client.search(DEFAULT_JIRA_JQL)) snapshots.push(await client.snapshot(issue));
    expect(snapshots[0]).toMatchObject({ primaryType: 'task', title: 'APP-1 First', external: { externalId: 'APP-1', url: 'https://team.atlassian.net/browse/APP-1' } });
    expect(snapshots[0].body).toContain('Full details');
    expect(snapshots[0].body).toContain('Alice — 2026-01-01');
    expect(snapshots[0].body).toContain('Bob — 2026-01-02');
    expect(JSON.parse(fetcher.mock.calls[3][1].body).nextPageToken).toBe('next');
    expect(fetcher.mock.calls[2][0]).toContain('startAt=1');
  });

  it.each([[401, 'credentials'], [403, 'permission'], [400, 'JQL'], [429, 'rate limit'], [500, 'unavailable']])('reports HTTP %s without echoing server secrets', async (status, message) => {
    const client = new JiraClient({ siteUrl: 'https://team.atlassian.net', email: 'me', apiToken: 'secret' }, vi.fn().mockResolvedValue(response({ errorMessages: ['secret'] }, status)));
    await expect(client.request('/rest/api/3/search/jql')).rejects.toThrow(message);
  });

  it('sanitizes transport errors and refuses unsafe site URLs', async () => {
    const client = new JiraClient({ siteUrl: 'https://team.atlassian.net', email: 'me', apiToken: 'secret' }, vi.fn().mockRejectedValue(new Error('secret')));
    await expect(client.request('/rest/api/3/myself')).rejects.toThrow('network');
    expect(() => new JiraClient({ siteUrl: 'http://team.atlassian.net', email: 'me', apiToken: 'secret' })).toThrow('HTTPS');
  });

  it('preserves code, table cells, mentions, and nested lists in ADF', () => {
    const markdown = adfToMarkdown({ type: 'doc', content: [
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const x = `value`;' }] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [doc('Name').content[0]] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [doc('A|B').content[0]] }] }] },
      { type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@Alice' } }, { type: 'hardBreak' }, { type: 'status', attrs: { text: 'Review' } }] },
      { type: 'orderedList', attrs: { order: 3 }, content: [{ type: 'listItem', content: [doc('Parent').content[0], { type: 'bulletList', content: [{ type: 'listItem', content: [doc('Child').content[0]] }] }] }] },
    ] });
    expect(markdown).toContain('```ts\nconst x = `value`;\n```');
    expect(markdown).toContain('| Name |\n| --- |\n| A\\|B |');
    expect(markdown).toContain('@Alice  \nReview');
    expect(markdown).toContain('3. Parent\n   \n   - Child');
  });

  it('does not forward credentials through redirects and detects non-progressing pages', async () => {
    const fetcher = vi.fn().mockImplementation(async () => response({ issues: [], nextPageToken: 'same' }));
    const client = new JiraClient({ siteUrl: 'https://team.atlassian.net', email: 'me', apiToken: 'secret' }, fetcher);
    await expect(async () => { for await (const _issue of client.search('mine')) { /* consume */ } }).rejects.toThrow('repeated search page');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: `Basic ${btoa('me:secret')}` } });
    fetcher.mockImplementation(async () => response({ comments: [], total: 1 }));
    const partial = await client.snapshot({ key: 'APP-1', fields: { summary: 'First' } });
    expect(partial.body).toContain('Partial/unavailable comments');
    expect(partial.body).toContain('startAt=0');
  });

  it.each(['customfield_10017', 'customfield_29999'])('discovers acceptance criteria from site field %s and keeps embedded criteria', async fieldId => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ key: 'APP-1', names: { [fieldId]: 'Acceptance Criteria' }, fields: { summary: 'First', description: doc('Acceptance criteria: preserve links'), [fieldId]: doc('All checks pass') } }))
      .mockResolvedValueOnce(response({ comments: [], total: 0 }));
    const snapshot = await new JiraClient({ siteUrl: 'https://team.atlassian.net', email: 'me', apiToken: 'secret' }, fetcher).fetchSnapshot('APP-1');
    expect(fetcher.mock.calls[0][0]).toContain('fields=*all&expand=names');
    expect(snapshot.body).toContain('Acceptance criteria: preserve links');
    expect(snapshot.body).toContain(`Acceptance Criteria (${fieldId})`);
    expect(snapshot.body).toContain('All checks pass');
    expect(snapshot.body).toContain('Absent: no comments');
  });

  it('distinguishes absent fields, omitted fields, inaccessible comments, and failed pages', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({}, 403));
    const client = new JiraClient({ siteUrl: 'https://team.atlassian.net', email: 'me', apiToken: 'secret' }, fetcher);
    const snapshot = await client.snapshot({ key: 'APP-1', names: { customfield_7: 'Acceptance Criteria' }, fields: { summary: 'First', description: null } });
    expect(snapshot.body).toContain('Absent: Jira returned an empty field');
    expect(snapshot.body).toContain('Unavailable: field omitted by Jira');
    expect(snapshot.body).toContain('inaccessible');
    fetcher.mockResolvedValueOnce(response({ comments: [{ id: 'c1', author: { displayName: 'Alice' }, created: '2026-10-29T12:00:00Z', body: doc('Retained comment') }], total: 3 })).mockResolvedValueOnce(response({}, 503));
    const partial = await client.snapshot({ key: 'APP-1', fields: { summary: 'First', description: doc('Details') } });
    expect(partial.body).toContain('Alice — 2026-10-29T12:00:00Z');
    expect(partial.body).toContain('Retained comment');
    expect(partial.body).toContain('request failed');
    expect(partial.body).toContain('retained 1 accessible comments');
    expect(partial.body).toContain('startAt=1');
  });

  it('stops repeated comment pages and keeps unique accessible comments', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ comments: [{ id: 'c1', created: '2026-10-29', body: doc('Only once') }], total: 5 }));
    const snapshot = await new JiraClient({ siteUrl: 'https://team.atlassian.net', email: 'me', apiToken: 'secret' }, fetcher).snapshot({ key: 'APP-1', fields: { summary: 'First' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(snapshot.body?.match(/Only once/g)).toHaveLength(1);
    expect(snapshot.body).toContain('Partial/unavailable');
  });

  it('uses configured fields without discovery metadata', async () => {
    const client = new JiraClient({ siteUrl: 'https://team.atlassian.net', email: 'me', apiToken: 'secret' }, vi.fn().mockResolvedValue(response({ comments: [], total: 0 })), ['customfield_42']);
    const snapshot = await client.snapshot({ key: 'APP-1', fields: { summary: 'First', description: null, customfield_42: doc('Custom completion criteria') } });
    expect(snapshot.body).toContain('Configured acceptance criteria (customfield_42)');
    expect(snapshot.body).toContain('Custom completion criteria');
  });

  it('preserves search-level custom-field discovery metadata', async () => {
    const client = new JiraClient({ siteUrl: 'https://team.atlassian.net', email: 'me', apiToken: 'secret' }, vi.fn().mockResolvedValue(response({ names: { customfield_8: 'Acceptance Criteria' }, issues: [{ key: 'APP-1', fields: { summary: 'First', customfield_8: doc('Required') } }], isLast: true })));
    const issues = [];
    for await (const issue of client.search('mine')) issues.push(issue);
    expect(issues[0].names).toEqual({ customfield_8: 'Acceptance Criteria' });
  });
});
