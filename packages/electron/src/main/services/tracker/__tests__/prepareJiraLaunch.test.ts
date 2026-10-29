// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { prepareJiraLaunch } from '../prepareJiraLaunch';
import { JiraError } from '@nimbalyst/runtime/integrations/jira';

function fixture() {
  const item = { id: 'task', workspace: '/repo', title: 'Local title', content: 'preview', customFields: { origin: { kind: 'external', external: { providerId: 'jira', externalId: 'APP-1', urn: 'jira://team.atlassian.net/APP-1', url: 'https://team.atlassian.net/browse/APP-1', lastSyncedAt: '2026-01-01' } } } };
  return {
    getItem: vi.fn().mockResolvedValue(item),
    getContent: vi.fn().mockResolvedValue('Canonical body with local additions'),
    fetchSnapshot: vi.fn().mockResolvedValue({ title: 'APP-1 Upstream title', body: 'Latest description\n\n## Acceptance criteria\n- Works', external: item.customFields.origin.external }),
    saveContinuation: vi.fn().mockResolvedValue('/repo/nimbalyst-local/jira-launch/context.md'),
  };
}

describe('prepareJiraLaunch', () => {
  it('refreshes upstream separately from the canonical local body without writing to the tracker', async () => {
    const deps = fixture();
    const result = await prepareJiraLaunch('/repo', 'task', deps);
    expect(deps.getContent).toHaveBeenCalledWith('task');
    expect(deps.fetchSnapshot).toHaveBeenCalledWith('/repo', 'jira', 'APP-1');
    expect(result.evidence).toContain('Canonical body with local additions');
    expect(result.evidence).toContain('Latest description');
    expect(result.evidence).not.toContain('preview');
    expect(result.evidence).toContain('Local tracker body');
    expect(result.evidence).toContain('Upstream Jira');
    expect(deps.saveContinuation).not.toHaveBeenCalled();
  });

  it('labels failed refresh and stale cache rather than claiming fields are absent', async () => {
    const deps = fixture();
    deps.fetchSnapshot.mockRejectedValue(new Error('credential-secret'));
    const result = await prepareJiraLaunch('/repo', 'task', deps);
    expect(result.evidence).toContain('stale');
    expect(result.evidence).toContain('2026-01-01');
    expect(result.evidence).toContain('Canonical body');
    expect(result.evidence).not.toContain('credential-secret');
  });

  it('stores every character of oversized evidence and provides a retrievable continuation', async () => {
    const deps = fixture();
    const longBody = 'full code and comments\n'.repeat(3000) + 'LAST ACCEPTANCE CRITERION';
    deps.getContent.mockResolvedValue(longBody);
    const result = await prepareJiraLaunch('/repo', 'task', deps);
    expect(deps.saveContinuation.mock.calls[0][0]).toContain(longBody);
    expect(result.evidence).toContain('/repo/nimbalyst-local/jira-launch/context.md');
    expect(result.evidence).toContain('Read the entire');
    expect(result.evidence.length).toBeLessThan(20_000);
  });

  it('rejects the wrong workspace before fetching context', async () => {
    const deps = fixture();
    await expect(prepareJiraLaunch('/other', 'task', deps)).rejects.toThrow('project');
    expect(deps.fetchSnapshot).not.toHaveBeenCalled();
  });

  it('does not substitute the preview if the canonical body request fails', async () => {
    const deps = fixture();
    deps.getContent.mockRejectedValue(new Error('body unavailable'));
    await expect(prepareJiraLaunch('/repo', 'task', deps)).rejects.toThrow('body unavailable');
  });

  it('rejects context from a different Jira site', async () => {
    const deps = fixture();
    deps.fetchSnapshot.mockResolvedValue({ body: 'Wrong project secret', external: { urn: 'jira://other.atlassian.net/APP-1' } });
    const result = await prepareJiraLaunch('/repo', 'task', deps);
    expect(result.evidence).toContain('stale');
    expect(result.evidence).not.toContain('Wrong project secret');
  });

  it('distinguishes access denial from a failed request while retaining stale evidence', async () => {
    const deps = fixture();
    deps.fetchSnapshot.mockRejectedValue(new JiraError('Permission denied', 403));
    expect((await prepareJiraLaunch('/repo', 'task', deps)).evidence).toContain('Refresh inaccessible (HTTP 403');
  });
});
