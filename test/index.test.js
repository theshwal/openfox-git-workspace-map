/**
 * Unit tests for src/index.js — exercise the register() surface against a
 * fake PluginRegistry. We do not import the host or run a server.
 *
 * Run: `npm test` (node --test) or `npx vitest run`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { register, resolveContext, readLastContext, writeLastContext, __INTERNAL__ } from '../src/index.js'
import * as gitState from '../src/git-state.js'

/* ------------------------------------------------------------------ */
/* Fake registry                                                       */
/* ------------------------------------------------------------------ */

function createRegistry() {
  const calls = {}
  const record = (key) => (value) => { calls[key] = [...(calls[key] ?? []), value] }
  const storage = new Map()
  const registry = {
    runtime: { mode: 'production', configDirectory: '/tmp' },
    context: {
      id: __INTERNAL__.PLUGIN_ID,
      version: '1.0.0',
      runtime: { mode: 'production', configDirectory: '/tmp' },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      storage: {
        get: (k) => storage.get(k),
        set: (k, v) => { storage.set(k, v) },
      },
      settings: () => ({}),
      notify: vi.fn(),
      publish: vi.fn(),
    },
    registerAuth: record('auth'),
    registerTransport: record('transport'),
    registerPreset: record('preset'),
    registerModelMetadataProvider: record('modelMetadata'),
    registerTool: record('tool'),
    registerCommand: record('command'),
    registerSkillSource: record('skillSource'),
    registerSettings: record('settings'),
    registerSettingsTab: record('settingsTab'),
    registerUiAction: record('uiAction'),
    registerUiBadge: record('uiBadge'),
    registerUiPanel: record('uiPanel'),
    registerUiComponent: record('uiComponent'),
    registerUiOverride: record('uiOverride'),
    registerHook: (event, handler) => record(`hook:${event}`)(handler),
    registerTransitionHandler: (name, handler) => record(`transition:${name}`)(handler),
    registerRpc: (method, handler) => record(`rpc:${method}`)(handler),
    registerAsset: record('asset'),
  }
  return { registry, calls, storage }
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('register()', () => {
  it('declares the expected contribution points', () => {
    const { registry, calls } = createRegistry()
    register(registry)
    expect(calls.tool).toHaveLength(1)
    expect(calls.uiAction).toHaveLength(1)
    expect(calls.uiBadge).toHaveLength(1)
    expect(calls.uiPanel).toHaveLength(1)
    expect(calls.asset).toEqual(['git-workspace.html'])
    expect(calls['hook:session.created']).toHaveLength(1)
    expect(calls['hook:turn.completed']).toHaveLength(1)
    expect(Object.keys(calls).filter((k) => k.startsWith('rpc:')).sort()).toEqual([
      'rpc:badge',
      'rpc:checkoutBranch',
      'rpc:checkoutNew',
      'rpc:createBranch',
      'rpc:createWorkspace',
      'rpc:deleteWorkspace',
      'rpc:fetch',
      'rpc:listBranches',
      'rpc:listSessions',
      'rpc:listWorkspaces',
      'rpc:observe',
      'rpc:resolveContext',
      'rpc:switchWorkspace',
    ])
  })

  it('declares the badge with an rpc source', () => {
    const { registry, calls } = createRegistry()
    register(registry)
    const badge = calls.uiBadge[0]
    expect(badge.slot).toBe('session.header.badges')
    expect(badge.source).toEqual({ kind: 'rpc', method: 'badge' })
    expect(badge.id).toBe('git-map-badge')
  })

  it('declares the action with openPanel activation', () => {
    const { registry, calls } = createRegistry()
    register(registry)
    const action = calls.uiAction[0]
    expect(action.slot).toBe('session.header.actions')
    expect(action.onActivate).toEqual({ kind: 'openPanel', panelId: 'git-workspace' })
  })

  it('declares the iframe panel with the asset url', () => {
    const { registry, calls } = createRegistry()
    register(registry)
    const panel = calls.uiPanel[0]
    expect(panel.kind).toBe('iframe')
    expect(panel.url).toBe('git-workspace.html')
  })

  it('registers the asset exactly once', () => {
    const { registry, calls } = createRegistry()
    register(registry)
    expect(calls.asset).toEqual(['git-workspace.html'])
  })
})

describe('context resolution', () => {
  it('prefers live RPC context over cache', () => {
    const storage = new Map()
    writeLastContext({ set: (k, v) => storage.set(k, v) }, { sessionId: 'cached', workdir: '/cached' })
    const result = resolveContext({ sessionId: 'live', workdir: '/live' }, { get: (k) => storage.get(k) })
    // Live wins for sessionId/workdir; projectId is taken from cache.
    expect(result.sessionId).toBe('live')
    expect(result.workdir).toBe('/live')
  })

  it('falls back to cache when RPC context is empty', () => {
    const storage = new Map()
    writeLastContext({ set: (k, v) => storage.set(k, v) }, { sessionId: 'cached', workdir: '/cached', projectId: 'px' })
    const result = resolveContext({}, { get: (k) => storage.get(k) })
    expect(result).toMatchObject({ sessionId: 'cached', workdir: '/cached', projectId: 'px' })
  })

  it('falls back to process.cwd() when nothing else is known', () => {
    const result = resolveContext({}, { get: () => undefined })
    expect(result.workdir).toBe(process.cwd())
    expect(result.sessionId).toBe('')
  })

  it('round-trips storage values', () => {
    const fakeStore = { get: vi.fn(), set: vi.fn() }
    writeLastContext(fakeStore, { sessionId: 'a', workdir: '/b' })
    expect(fakeStore.set).toHaveBeenCalledTimes(1)
    const [key, value] = fakeStore.set.mock.calls[0]
    expect(key).toBe(__INTERNAL__.STORAGE_LAST_CONTEXT)
    expect(typeof value).toBe('string')
    const parsed = JSON.parse(value)
    expect(parsed.sessionId).toBe('a')
    expect(parsed.workdir).toBe('/b')
    // writeLastContext does not stamp a timestamp — only mirrorContext does.
    expect(parsed.timestamp).toBeUndefined()
    fakeStore.get.mockReturnValue(JSON.stringify({ sessionId: 'a', workdir: '/b' }))
    expect(readLastContext(fakeStore)).toMatchObject({ sessionId: 'a', workdir: '/b' })
  })

  it('mirrorContext stamps an ISO timestamp in the cached payload', () => {
    const { registry, calls, storage } = createRegistry()
    register(registry)
    const handler = calls['hook:session.created'][0]
    handler({ event: 'session.created', sessionId: 's1', projectId: 'p1', timestamp: '', data: {} })
    const cached = JSON.parse(storage.get(__INTERNAL__.STORAGE_LAST_CONTEXT))
    expect(typeof cached.timestamp).toBe('string')
    expect(new Date(cached.timestamp).toString()).not.toBe('Invalid Date')
  })

  it('falls back to process.cwd() when no workdir is provided', () => {
    const result = resolveContext({ sessionId: 's' }, { get: () => undefined })
    expect(result.workdir).toBe(process.cwd())
  })
})

describe('tool: git_workspace_inspect', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns "Not a git repository" outside a work tree', async () => {
    vi.spyOn(gitState, 'isGitRepository').mockResolvedValue(false)
    const { registry, calls } = createRegistry()
    register(registry)
    const tool = calls.tool[0]
    const result = await tool.execute({}, { sessionId: 's', workdir: '/no/git' })
    expect(result.success).toBe(true)
    expect(result.output).toMatch(/Not a git repository/)
  })

  it('reports branch, upstream and dirty state for a real repo', async () => {
    vi.spyOn(gitState, 'observe').mockResolvedValue({
      ok: true,
      value: {
        isRepository: true,
        cwd: '/repo',
        toplevel: '/repo',
        commonDir: '/repo',
        branch: 'feat/x',
        headSha: 'abcdef',
        upstream: 'origin/feat/x',
        ahead: 1,
        behind: 0,
        dirty: { clean: false, modified: 2, files: ['a.ts', 'b.ts'], porcelain: ' M a.ts\n M b.ts' },
        remotes: [{ name: 'origin', fetchUrl: 'https://example/x.git', pushUrl: 'https://example/x.git' }],
        branches: [],
      },
    })
    const { registry, calls } = createRegistry()
    register(registry)
    const tool = calls.tool[0]
    const result = await tool.execute({ includeFiles: true }, { sessionId: 's', workdir: '/repo' })
    expect(result.success).toBe(true)
    expect(result.output).toMatch(/Branch: feat\/x → origin\/feat\/x/)
    expect(result.output).toMatch(/HEAD: abcdef/)
    expect(result.output).toMatch(/Ahead\/behind: ↑1 ↓0/)
    expect(result.output).toMatch(/2 modified file/)
    expect(result.output).toMatch(/Files: a\.ts, b\.ts/)
  })

  it('surfaces observation errors', async () => {
    vi.spyOn(gitState, 'observe').mockResolvedValue({ ok: false, error: 'boom' })
    const { registry, calls } = createRegistry()
    register(registry)
    const tool = calls.tool[0]
    const result = await tool.execute({}, { sessionId: 's', workdir: '/repo' })
    expect(result.success).toBe(false)
    expect(result.error).toBe('boom')
  })
})

describe('RPC: badge', () => {
  it('returns "no-git" outside a repository', async () => {
    vi.spyOn(gitState, 'observe').mockResolvedValue({ ok: true, value: { isRepository: false } })
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:badge'][0]
    await expect(handler({}, { sessionId: 's', workdir: '/x' })).resolves.toBe('no-git')
  })

  it('returns branch + dirty + ahead/behind when valid', async () => {
    vi.spyOn(gitState, 'observe').mockResolvedValue({
      ok: true,
      value: {
        isRepository: true,
        branch: 'main',
        dirty: { modified: 3, clean: false, files: [], porcelain: '' },
        ahead: 1,
        behind: 2,
      },
    })
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:badge'][0]
    await expect(handler({}, { sessionId: 's', workdir: '/x' })).resolves.toBe('main ±3 ↑1↓2')
  })

  it('returns "" when workdir is missing', async () => {
    // Stub the observer to throw so we can verify the badge short-circuits
    // when process.cwd() somehow resolves to a non-repo path. The actual
    // no-workdir short-circuit happens in the host (the badge slot simply
    // isn't rendered outside a session).
    vi.spyOn(gitState, 'observe').mockResolvedValue({ ok: true, value: { isRepository: false } })
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:badge'][0]
    // No live workdir, no cached workdir → resolveContext falls back to
    // process.cwd(), and observe reports "not a git repository" → 'no-git'.
    await expect(handler({}, {})).resolves.toBe('no-git')
  })
})

describe('RPC: observe', () => {
  it('returns ok=false when the observer fails', async () => {
    vi.spyOn(gitState, 'observe').mockResolvedValue({ ok: false, error: 'fail' })
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:observe'][0]
    const result = await handler({}, { sessionId: 's', workdir: '/x' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('fail')
  })

  it('returns the full repo payload', async () => {
    vi.spyOn(gitState, 'observe').mockResolvedValue({
      ok: true,
      value: {
        isRepository: true,
        branch: 'main',
        ahead: 0,
        behind: 0,
        dirty: { clean: true, modified: 0, files: [], porcelain: '' },
        remotes: [],
        branches: [],
      },
    })
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:observe'][0]
    const result = await handler({}, { sessionId: 's', workdir: '/x' })
    expect(result.ok).toBe(true)
    expect(result.repo.branch).toBe('main')
    expect(result.context.workdir).toBe('/x')
  })
})

describe('RPC: fetch', () => {
  it('delegates to gitState.fetch with no remote when none provided', async () => {
    const spy = vi.spyOn(gitState, 'fetch').mockResolvedValue({ ok: true, value: { remote: '*' } })
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:fetch'][0]
    const result = await handler({}, { sessionId: 's', workdir: '/x' })
    expect(spy).toHaveBeenCalledWith('/x', null)
    expect(result).toEqual({ ok: true, remote: '*' })
  })

  it('passes the remote name when provided', async () => {
    const spy = vi.spyOn(gitState, 'fetch').mockResolvedValue({ ok: true, value: { remote: 'origin' } })
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:fetch'][0]
    await handler({ remote: 'origin' }, { sessionId: 's', workdir: '/x' })
    expect(spy).toHaveBeenCalledWith('/x', 'origin')
  })

  it('throws when gitState returns ok=false', async () => {
    vi.spyOn(gitState, 'fetch').mockResolvedValue({ ok: false, error: 'no network' })
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:fetch'][0]
    await expect(handler({}, { sessionId: 's', workdir: '/x' })).rejects.toThrow('no network')
  })
})

describe('RPC: createBranch / checkoutBranch / checkoutNew', () => {
  it('createBranch requires a name', async () => {
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:createBranch'][0]
    await expect(handler({}, { sessionId: 's', workdir: '/x' })).rejects.toThrow(/name is required/)
  })

  it('createBranch throws without session', async () => {
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:createBranch'][0]
    await expect(handler({ name: 'a' }, {})).rejects.toThrow(/active session/)
  })

  it('checkoutBranch requires branch', async () => {
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:checkoutBranch'][0]
    await expect(handler({}, { sessionId: 's', workdir: '/x' })).rejects.toThrow(/name is required/)
  })

  it('checkoutNew requires projectId', async () => {
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:checkoutNew'][0]
    await expect(handler({ name: 'a' }, { sessionId: 's', workdir: '/x' })).rejects.toThrow(/project context/)
  })
})

describe('RPC: switchWorkspace / deleteWorkspace / createWorkspace', () => {
  it('switchWorkspace requires a target', async () => {
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:switchWorkspace'][0]
    await expect(handler({}, { sessionId: 's', workdir: '/x' })).rejects.toThrow(/target is required/)
  })

  it('deleteWorkspace surfaces retryWithForce for "in use" errors', async () => {
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:deleteWorkspace'][0]
    // Stub global fetch to simulate the host's 409 response.
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ error: 'Workspace in use by other sessions' }),
    })
    try {
      const result = await handler({ target: 'foo' }, { sessionId: 's', workdir: '/x' })
      expect(result.ok).toBe(false)
      expect(result.retryWithForce).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('deleteWorkspace returns ok on success', async () => {
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:deleteWorkspace'][0]
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ session: { id: 's' } }),
    })
    try {
      const result = await handler({ target: 'foo', force: true }, { sessionId: 's', workdir: '/x' })
      expect(result.session.id).toBe('s')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('createWorkspace delegates to switchWorkspace', async () => {
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:createWorkspace'][0]
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ session: { id: 's' } }),
    })
    try {
      const result = await handler({ target: 'new-ws' }, { sessionId: 's', workdir: '/x' })
      expect(result.session.id).toBe('s')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('RPC: listBranches / listWorkspaces / listSessions / resolveContext', () => {
  it('listBranches requires a session', async () => {
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:listBranches'][0]
    await expect(handler({}, {})).rejects.toThrow(/active session/)
  })

  it('listWorkspaces requires a projectId', async () => {
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:listWorkspaces'][0]
    await expect(handler({}, {})).rejects.toThrow(/project context/)
  })

  it('resolveContext returns the resolved context', async () => {
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['rpc:resolveContext'][0]
    const result = await handler({}, { sessionId: 's', workdir: '/x' })
    expect(result).toMatchObject({ sessionId: 's', workdir: '/x' })
  })

  it('listSessions returns whatever fetch returns', async () => {
    const { registry, calls } = createRegistry()
    register(registry)
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ sessions: [{ id: 's1' }] }),
    })
    try {
      const handler = calls['rpc:listSessions'][0]
      const result = await handler({}, {})
      expect(result.sessions).toEqual([{ id: 's1' }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('hooks', () => {
  it('mirrors sessionId/projectId into storage on session.created', () => {
    const { registry, calls, storage } = createRegistry()
    register(registry)
    const handler = calls['hook:session.created'][0]
    handler({ event: 'session.created', sessionId: 's1', projectId: 'p1', timestamp: '', data: {} })
    const cached = JSON.parse(storage.get(__INTERNAL__.STORAGE_LAST_CONTEXT))
    expect(cached).toMatchObject({ sessionId: 's1', projectId: 'p1' })
  })

  it('turn.completed hook is a noop', () => {
    const { registry, calls } = createRegistry()
    register(registry)
    const handler = calls['hook:turn.completed'][0]
    expect(() => handler({ event: 'turn.completed', sessionId: 's', timestamp: '', data: {} })).not.toThrow()
  })
})
