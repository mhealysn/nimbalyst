// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), prepare: vi.fn(), services: new Map() }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: (key: string, fn: (...args: any[]) => any) => h.handlers.set(key, fn) }));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn() } } }));
vi.mock('../../utils/systemShell', () => ({ systemShell: {} }));
vi.mock('../../window/WindowManager', () => ({ documentServices: h.services }));
vi.mock('../../services/tracker/TrackerImporterRegistry', () => ({ getTrackerImporterRegistry: () => ({}) }));
vi.mock('../../services/tracker/TrackerImportService', () => ({ getTrackerImportService: () => ({}) }));
vi.mock('../../services/tracker/prepareJiraLaunch', () => ({ prepareJiraLaunch: h.prepare }));
import { registerTrackerImporterHandlers } from '../TrackerImporterHandlers';

describe('tracker launch IPC', () => {
  it('persists an immutable private continuation readable by an agent outside its source worktree', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'jira-launch-'));
    const fullContent = '## Acceptance criteria\n- All behavior\n\n```ts\nconst x = 1;\n```\n' + 'Comment\n'.repeat(3000);
    try {
      registerTrackerImporterHandlers();
      h.services.set(workspace, { getTrackerItemById: vi.fn(), getTrackerItemContent: vi.fn() });
      h.prepare.mockImplementationOnce(async (_workspace: string, _id: string, deps: { saveContinuation(content: string): Promise<string> }) => ({ evidence: await deps.saveContinuation(fullContent) }));
      const { evidence: filePath } = await h.handlers.get('tracker:prepare-jira-launch')!(null, { workspacePath: workspace, itemId: 'task' });
      expect(isAbsolute(filePath)).toBe(true);
      expect(await readFile(filePath, 'utf8')).toBe(fullContent);
      if (process.platform !== 'win32') expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    } finally {
      h.services.delete(workspace);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('requires an explicit loaded workspace and forwards the stable item id', async () => {
    registerTrackerImporterHandlers();
    const invoke = h.handlers.get('tracker:prepare-jira-launch')!;
    await expect(invoke(null, { workspacePath: '', itemId: 'task' })).rejects.toThrow('workspacePath');
    await expect(invoke(null, { workspacePath: '/missing', itemId: 'task' })).rejects.toThrow('project');
    h.services.set('/repo', { getTrackerItemById: vi.fn(), getTrackerItemContent: vi.fn() });
    h.prepare.mockResolvedValue({ evidence: 'Full context' });
    expect(await invoke(null, { workspacePath: '/repo', itemId: 'task' })).toEqual({ evidence: 'Full context' });
    expect(h.prepare).toHaveBeenCalledWith('/repo', 'task', expect.objectContaining({ getItem: expect.any(Function), getContent: expect.any(Function) }));
  });
});
