import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { JIRA_LAUNCH_INSTRUCTIONS, type PreparedJiraLaunchContext } from '../../../shared/jiraLaunchContext';
import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import {
  getRecordFieldStr,
  getRecordPriority,
  getRecordStatus,
  getRecordTitle,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';

const MAX_WORKTREE_NAME_LENGTH = 64;

export interface TrackerLaunchContext {
  workspacePath: string | undefined;
  trackerLinkId: string;
  draftInput: string;
  worktreeName: string;
  sourceRepoPath?: string;
}

type LaunchInvoke = (channel: string, ...args: any[]) => Promise<any>;

export async function linkTrackerLaunchSession(context: TrackerLaunchContext, sessionId: string, invoke: LaunchInvoke): Promise<void> {
  const result = await invoke('tracker:link-session', { trackerId: context.trackerLinkId, sessionId });
  if (!result?.success) throw new Error(result?.error || 'The tracker-session link could not be saved.');
}

/** Execution still requires the user's normal draft submission. */
export async function createTrackerSession(context: TrackerLaunchContext, activeWorkspacePath: string | null, model: string | undefined, invoke: LaunchInvoke): Promise<string> {
  if (!isTrackerLaunchForWorkspace(context, activeWorkspacePath)) throw new Error('The active project changed. Start the session from the original project.');
  const result = await invoke('sessions:create', {
    session: { id: crypto.randomUUID(), provider: (model ? ModelIdentifier.tryParse(model) : null)?.provider || 'claude-code', model, title: 'New Session' },
    workspaceId: context.workspacePath,
  });
  if (!result?.success || !result?.id) throw new Error(result?.error || 'Session was not created.');
  await linkTrackerLaunchSession(context, result.id, invoke);
  await invoke('ai:saveDraftInput', result.id, context.draftInput, context.workspacePath);
  return result.id;
}

/**
 * Whether a pending worktree launch still belongs to the project on screen. The
 * tracker view stays mounted across a rail switch, so without this the branch
 * picker would stay open and list the new project's branches for the old item.
 */
export function isTrackerLaunchForWorkspace(
  context: TrackerLaunchContext | null,
  workspacePath: string | null | undefined,
): context is TrackerLaunchContext {
  return !!context && !!context.workspacePath && context.workspacePath === workspacePath;
}

/** Validate at submission: the project can change while the branch picker is open. */
export async function createTrackerWorktreeSession(
  context: TrackerLaunchContext,
  activeWorkspacePath: string | null,
  options: { baseBranch: string; name?: string },
  createSession: (options: { baseBranch: string; name?: string; initialDraft: string }) => Promise<string | undefined>,
  activeRepoPath?: string | null,
): Promise<string | undefined> {
  if (!context.workspacePath || context.workspacePath !== activeWorkspacePath) {
    throw new Error('The active project changed. Cancel and start the worktree from the original project.');
  }
  if (context.sourceRepoPath && context.sourceRepoPath !== activeRepoPath) throw new Error('The selected repository changed. Start the worktree launch again.');
  // Invoke synchronously after the check so creation captures the same active project.
  return createSession({ ...options, initialDraft: context.draftInput });
}

function slugifyWorktreeName(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function deriveTrackerWorktreeName(itemId: string, title: string): string {
  const itemSlug = slugifyWorktreeName(itemId) || 'tracker-item';
  const titleSlug = slugifyWorktreeName(title);
  const combined = titleSlug && titleSlug !== itemSlug
    ? `${itemSlug}-${titleSlug}`
    : itemSlug;

  return combined
    .slice(0, MAX_WORKTREE_NAME_LENGTH)
    .replace(/-+$/g, '');
}

/**
 * Refuse a launch whose item belongs to another project. A board that shows
 * another project's items (#1822) would otherwise start the agent in the
 * board's folder with a prompt about the other project.
 */
export function assertTrackerItemInWorkspace(
  trackerItem: TrackerRecord | undefined,
  workspacePath: string | null | undefined,
): asserts trackerItem is TrackerRecord {
  if (!trackerItem) {
    throw new Error('The tracker item is not loaded in this project.');
  }
  if (trackerItem.system.workspace !== workspacePath) {
    throw new Error(
      `This item belongs to ${trackerItem.system.workspace}, not ${workspacePath ?? 'this project'}.`,
    );
  }
}

export function buildTrackerLaunchContext(
  trackerItemId: string,
  trackerItem?: TrackerRecord,
  jiraContext?: PreparedJiraLaunchContext,
): TrackerLaunchContext {
  const title = trackerItem ? getRecordTitle(trackerItem) : trackerItemId;
  const itemId = trackerItem?.issueKey || trackerItemId;
  const lines: string[] = [jiraContext ? 'Implement the Jira ticket in the evidence below.' : `implement tracker item ${itemId}: ${title}`];

  if (trackerItem) {
    const status = getRecordStatus(trackerItem);
    const priority = getRecordPriority(trackerItem);
    const description = getRecordFieldStr(trackerItem, 'description');
    const meta: string[] = [];
    if (trackerItem.primaryType) meta.push(`type: ${trackerItem.primaryType}`);
    if (status) meta.push(`status: ${status}`);
    if (priority) meta.push(`priority: ${priority}`);
    if (meta.length > 0) lines.push(meta.join(', '));
    if (jiraContext) lines.push(`\n${JIRA_LAUNCH_INSTRUCTIONS}\n\n--- BEGIN TICKET EVIDENCE ---\n${jiraContext.evidence}\n--- END TICKET EVIDENCE ---`);
    else if (description) lines.push(`\n${description}`);
    if (trackerItem.system.documentPath) {
      lines.push(`\nSource: @${trackerItem.system.documentPath}`);
    }
  }

  lines.push(jiraContext
    ? `\nLocal tracker reference: tracker_update id "${trackerItemId}". Follow repository workflow and report blockers; launching does not authorize Jira writes.`
    : `\nUpdate this tracker item's status when done using tracker_update with id "${itemId}".`);

  return {
    workspacePath: trackerItem?.system.workspace,
    trackerLinkId: trackerItem?.system.documentPath
      ? `file:${trackerItem.system.documentPath}`
      : trackerItemId,
    draftInput: lines.join('\n'),
    worktreeName: deriveTrackerWorktreeName(itemId, title),
  };
}

export async function prepareTrackerLaunchContext(trackerItemId: string, trackerItem: TrackerRecord, prepare: (args: { workspacePath: string; itemId: string }) => Promise<PreparedJiraLaunchContext>): Promise<TrackerLaunchContext> {
  const origin = trackerItem.system.origin;
  const jiraContext = origin?.kind === 'external' && origin.external.providerId === 'jira'
    ? await prepare({ workspacePath: trackerItem.system.workspace, itemId: trackerItemId })
    : undefined;
  return buildTrackerLaunchContext(trackerItemId, trackerItem, jiraContext);
}
