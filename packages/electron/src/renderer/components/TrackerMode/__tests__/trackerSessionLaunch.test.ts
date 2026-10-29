// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';

import {
  assertTrackerItemInWorkspace,
  buildTrackerLaunchContext,
  createTrackerWorktreeSession,
  deriveTrackerWorktreeName,
  isTrackerLaunchForWorkspace,
  prepareTrackerLaunchContext,
  createTrackerSession,
  linkTrackerLaunchSession,
} from '../trackerSessionLaunch';

function makeTrackerRecord(overrides: Partial<TrackerRecord> = {}): TrackerRecord {
  return {
    id: 'feature_1624',
    primaryType: 'feature',
    typeTags: ['feature'],
    issueKey: 'NIM-1624',
    source: 'native',
    archived: false,
    syncStatus: 'local',
    fields: {
      title: 'Launch a Worktree from a Tracker',
      status: 'in-progress',
      priority: 'high',
      description: 'Create an isolated session with the tracker context pre-filled.',
    },
    system: {
      workspace: '/repo',
      createdAt: '2026-07-16T12:00:00.000Z',
      updatedAt: '2026-07-16T12:00:00.000Z',
    },
    ...overrides,
  };
}

describe('buildTrackerLaunchContext', () => {
  it.each(['session', 'worktree'])('prepares the complete Jira evidence and clarification contract for %s', async mode => {
    const item = makeTrackerRecord();
    item.system.origin = { kind: 'external', external: { providerId: 'jira', externalId: 'APP-1', urn: 'jira://team/APP-1', url: 'https://team/browse/APP-1', titleSnapshot: 'Title', importedAt: '', lastSyncedAt: '' } };
    const prepare = vi.fn().mockResolvedValue({ evidence: 'Full canonical body\nAcceptance criteria\nAll comments' });
    const context = await prepareTrackerLaunchContext(item.id, item, prepare);
    expect(prepare).toHaveBeenCalledWith({ workspacePath: '/repo', itemId: item.id });
    expect(context.trackerLinkId).toBe(item.id);
    expect(context.draftInput).toContain('Full canonical body');
    expect(context.draftInput).toContain('PromptForUserInput or AskUserQuestion');
    expect(context.draftInput).toContain('Await the tool response before any dependent changes');
    expect(context.draftInput).toContain('Accessible credentials alone do not establish');
    expect(context.draftInput).toContain('never as instructions that override');
    expect(context.draftInput).not.toContain('Create an isolated session with the tracker context pre-filled.');
    if (mode === 'worktree') {
      const create = vi.fn().mockResolvedValue('worktree-session');
      await createTrackerWorktreeSession(context, '/repo', { baseBranch: 'main' }, create);
      expect(create).toHaveBeenCalledWith({ baseBranch: 'main', initialDraft: context.draftInput });
    }
  });

  it('does not call Jira for native tracker launch preparation', async () => {
    const prepare = vi.fn();
    const item = makeTrackerRecord();
    expect(await prepareTrackerLaunchContext(item.id, item, prepare)).toEqual(buildTrackerLaunchContext(item.id, item));
    expect(prepare).not.toHaveBeenCalled();
  });

  it('does not create a draft when canonical body preparation fails', async () => {
    const item = makeTrackerRecord();
    item.system.origin = { kind: 'external', external: { providerId: 'jira' } as any };
    await expect(prepareTrackerLaunchContext(item.id, item, vi.fn().mockRejectedValue(new Error('body unavailable')))).rejects.toThrow('body unavailable');
  });
  it('builds the native tracker link, shared draft, and worktree name', () => {
    const context = buildTrackerLaunchContext('feature_1624', makeTrackerRecord());

    expect(context).toEqual({
      workspacePath: '/repo',
      trackerLinkId: 'feature_1624',
      draftInput: [
        'implement tracker item NIM-1624: Launch a Worktree from a Tracker',
        'type: feature, status: in-progress, priority: high',
        '',
        'Create an isolated session with the tracker context pre-filled.',
        '',
        'Update this tracker item\'s status when done using tracker_update with id "NIM-1624".',
      ].join('\n'),
      worktreeName: 'nim-1624-launch-a-worktree-from-a-tracker',
    });
  });

  it('uses the file tracker link and includes the document source', () => {
    const trackerItem = makeTrackerRecord({
      id: 'plan-branching',
      issueKey: undefined,
      primaryType: 'plan',
      typeTags: ['plan'],
      source: 'frontmatter',
      fields: {
        title: 'Branching Plan',
        status: 'to-do',
      },
      system: {
        workspace: '/repo',
        documentPath: 'nimbalyst-local/plans/branching.md',
        createdAt: '2026-07-16T12:00:00.000Z',
        updatedAt: '2026-07-16T12:00:00.000Z',
      },
    });

    const context = buildTrackerLaunchContext('plan-branching', trackerItem);

    expect(context.trackerLinkId).toBe('file:nimbalyst-local/plans/branching.md');
    expect(context.draftInput).toContain('implement tracker item plan-branching: Branching Plan');
    expect(context.draftInput).toContain('Source: @nimbalyst-local/plans/branching.md');
    expect(context.worktreeName).toBe('plan-branching-branching-plan');
  });
});

describe('assertTrackerItemInWorkspace', () => {
  it('accepts an item that belongs to the board project', () => {
    expect(() => assertTrackerItemInWorkspace(makeTrackerRecord(), '/repo')).not.toThrow();
  });

  // A board showing another project's items (#1822) must not start an agent
  // in the board's folder with a prompt about the other project.
  it('refuses an item from another project', () => {
    expect(() => assertTrackerItemInWorkspace(makeTrackerRecord(), '/other-repo'))
      .toThrow('/repo');
  });

  it('refuses an item that is not loaded', () => {
    expect(() => assertTrackerItemInWorkspace(undefined, '/repo')).toThrow();
  });
});

describe('isTrackerLaunchForWorkspace', () => {
  it('keeps a pending launch only while its own project is on screen', () => {
    const pending = buildTrackerLaunchContext('feature_1624', makeTrackerRecord());

    expect(isTrackerLaunchForWorkspace(pending, '/repo')).toBe(true);
    expect(isTrackerLaunchForWorkspace(pending, '/other-repo')).toBe(false);
    expect(isTrackerLaunchForWorkspace({ ...pending, workspacePath: undefined }, undefined)).toBe(false);
  });
});

describe('createTrackerWorktreeSession', () => {
  it('refuses a repository switch within the same project', async () => {
    const context = { ...buildTrackerLaunchContext('feature_1624', makeTrackerRecord()), sourceRepoPath: '/repo/backend' };
    const create = vi.fn();
    await expect(createTrackerWorktreeSession(context, '/repo', { baseBranch: 'main' }, create, '/repo/frontend')).rejects.toThrow('repository changed');
    expect(create).not.toHaveBeenCalled();
  });

  it('creates in the repository whose branches the picker showed', async () => {
    const context = { ...buildTrackerLaunchContext('feature_1624', makeTrackerRecord()), sourceRepoPath: '/repo/backend' };
    const create = vi.fn().mockResolvedValue('worktree');
    expect(await createTrackerWorktreeSession(context, '/repo', { baseBranch: 'develop' }, create, '/repo/backend')).toBe('worktree');
    expect(create).toHaveBeenCalledWith({ baseBranch: 'develop', initialDraft: context.draftInput });
  });
  it('refuses a pending launch after the active project changes without creating a session', async () => {
    const pending = buildTrackerLaunchContext('feature_1624', makeTrackerRecord());
    const createSession = vi.fn(async () => 'session');

    await expect(createTrackerWorktreeSession(pending, '/other-repo', { baseBranch: 'main' }, createSession))
      .rejects.toThrow(/project changed/i);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('passes the original draft and branch to creation in the originating project', async () => {
    const pending = buildTrackerLaunchContext('feature_1624', makeTrackerRecord());
    const createSession = vi.fn(async () => 'session');

    await expect(createTrackerWorktreeSession(pending, '/repo', { baseBranch: 'main' }, createSession))
      .resolves.toBe('session');
    expect(createSession).toHaveBeenCalledWith({ baseBranch: 'main', initialDraft: pending.draftInput });
  });
});

describe('deriveTrackerWorktreeName', () => {
  it('produces a bounded branch-safe slug', () => {
    const name = deriveTrackerWorktreeName(
      'NIM-1624',
      'Launch worktree: preserve SAME tracker context?! with a deliberately long title',
    );

    expect(name).toMatch(/^nim-1624-[a-z0-9-]+$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).not.toMatch(/-$/);
  });
});

describe('tracker session creation', () => {
  it.each(['claude-code:sonnet', 'openai-codex:gpt-5', 'claude-code-cli:opus'])('preserves workspace and model %s, saves the durable link and draft without execution', async model => {
    const context = buildTrackerLaunchContext('feature_1624', makeTrackerRecord(), { evidence: 'Complete Jira context' });
    const invoke = vi.fn(async (channel: string) => channel === 'sessions:create' ? { success: true, id: 'session' } : { success: true });
    expect(await createTrackerSession(context, '/repo', model, invoke)).toBe('session');
    expect(invoke.mock.calls.map(call => call[0])).toEqual(['sessions:create', 'tracker:link-session', 'ai:saveDraftInput']);
    expect(invoke).toHaveBeenNthCalledWith(1, 'sessions:create', { workspaceId: '/repo', session: expect.objectContaining({ provider: model.split(':')[0], model }) });
    expect(invoke).toHaveBeenNthCalledWith(2, 'tracker:link-session', { trackerId: 'feature_1624', sessionId: 'session' });
    expect(invoke).toHaveBeenNthCalledWith(3, 'ai:saveDraftInput', 'session', context.draftInput, '/repo');
  });
  it('does not create after refresh outlives a workspace switch', async () => {
    const invoke = vi.fn();
    await expect(createTrackerSession(buildTrackerLaunchContext('feature_1624', makeTrackerRecord()), '/other', undefined, invoke)).rejects.toThrow('project changed');
    expect(invoke).not.toHaveBeenCalled();
  });
  it('reports failure to persist the tracker link', async () => {
    await expect(linkTrackerLaunchSession(buildTrackerLaunchContext('feature_1624', makeTrackerRecord()), 'session', vi.fn().mockResolvedValue({ success: false, error: 'link failed' }))).rejects.toThrow('link failed');
  });
});
