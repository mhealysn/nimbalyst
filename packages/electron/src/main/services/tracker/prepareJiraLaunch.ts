import type { TrackerSnapshot } from '@nimbalyst/extension-sdk';
import type { PreparedJiraLaunchContext } from '../../../shared/jiraLaunchContext';
import { JiraError } from '@nimbalyst/runtime/integrations/jira';

interface LaunchItem {
  id: string;
  workspace?: string;
  title?: string;
  origin?: unknown;
  customFields?: Record<string, unknown>;
}

interface Dependencies {
  getItem(id: string): Promise<LaunchItem | null>;
  getContent(id: string): Promise<unknown>;
  fetchSnapshot(workspace: string, provider: string, externalId: string): Promise<TrackerSnapshot>;
  /** Must persist an immutable, private file readable from regular and worktree sessions. */
  saveContinuation(content: string): Promise<string>;
}

const INLINE_CONTEXT_BUDGET = 20_000;

/** Read-only preparation: the canonical body and upstream snapshot are never merged or written back. */
export async function prepareJiraLaunch(workspace: string, itemId: string, deps: Dependencies): Promise<PreparedJiraLaunchContext> {
  if (!workspace || !itemId) throw new Error('Jira launch requires project and item ID.');
  const item = await deps.getItem(itemId);
  if (!item || item.workspace !== workspace) throw new Error('The tracker item is not loaded in this project.');
  const origin = (item.origin ?? item.customFields?.origin) as { kind?: string; external?: Record<string, string> } | undefined;
  if (origin?.kind !== 'external' || origin.external?.providerId !== 'jira') throw new Error('The tracker item is not a Jira import.');
  const external = origin.external;
  // Explicit content read: the description in the row/list can be an incomplete preview.
  const content = await deps.getContent(item.id);
  const localBody = typeof content === 'string' ? content
    : typeof (content as { markdown?: unknown })?.markdown === 'string' ? (content as { markdown: string }).markdown
    : content == null ? '(Canonical local body is absent.)'
    : `Canonical serialized rich body (preserved in full):\n${JSON.stringify(content)}`;
  const identity = `Jira key: ${external.externalId}\nLocal title: ${item.title ?? ''}\nJira URL: ${external.url}\nTracker ID: ${item.id}\nRepository: ${workspace}`;
  let upstream: string;
  try {
    const snapshot = await deps.fetchSnapshot(workspace, 'jira', external.externalId);
    if (snapshot.external.urn !== external.urn) throw new Error('Jira source changed.');
    upstream = `Refresh retrieved at ${new Date().toISOString()}. Field/comment availability is recorded below.\nUpstream title: ${snapshot.title}\n\n${snapshot.body ?? '(Upstream body absent.)'}`;
  } catch (error) {
    // Do not expose credentials or raw server errors. Failure is not evidence of empty fields.
    const status = error instanceof JiraError ? error.status : undefined;
    const failure = status === 401 || status === 403 || status === 404
      ? `Refresh inaccessible (HTTP ${status}; authentication, permission, or issue visibility).`
      : 'Refresh request failed or configured source changed.';
    upstream = `${failure} Cached local context is stale; last successful import: ${external.lastSyncedAt ?? 'unknown'}. Upstream fields and comment completeness are unknown, not absent. Retry relevant authorized read-only investigation before relying on missing requirements.`;
  }
  const evidence = `${identity}\n\n## Upstream Jira evidence\n${upstream}\n\n## Local tracker body (may include cached upstream text and local additions)\n${localBody}\n\n## Local tracker comments\n${JSON.stringify(item.customFields?.comments ?? [])}`;
  if (evidence.length <= INLINE_CONTEXT_BUDGET) return { evidence };
  // All content goes into the continuation, avoiding broken code fences or partial criteria in a preview.
  const filePath = await deps.saveContinuation(evidence);
  return { evidence: `Jira key: ${external.externalId}\nTracker ID: ${item.id}\n\nContext exceeds the inline budget (${evidence.length} characters). Nothing was discarded. Read the entire immutable context file at ${JSON.stringify(filePath)} using file-reading tools, in consecutive pages through EOF, before implementation. It contains ticket identity and URL, upstream freshness/availability, the full local body, acceptance criteria, and comments.` };
}
