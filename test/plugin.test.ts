// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { observe, register, resolveContext, writeLastContext } from '../src/plugin'

function makeStorage() {
  const data = new Map<string, unknown>()
  return {
    get: (key: string) => data.get(key),
    set: (key: string, value: string | number | boolean) => data.set(key, value),
  }
}

function makeRegistry() {
  const rpcs = new Map<string, (params: unknown, ctx: unknown) => Promise<unknown>>()
  const registrations = {
    tools: 0,
    actions: [] as Array<Record<string, unknown>>,
    badges: [] as Array<Record<string, unknown>>,
    panels: 0,
    assets: [] as string[],
    hooks: [] as string[],
  }
  const registry = {
    context: { storage: makeStorage(), logger: { debug: vi.fn() } },
    registerTool: vi.fn(() => { registrations.tools++ }),
    registerUiAction: vi.fn((value: Record<string, unknown>) => { registrations.actions.push(value) }),
    registerUiBadge: vi.fn((value: Record<string, unknown>) => { registrations.badges.push(value) }),
    registerUiPanel: vi.fn(() => { registrations.panels++ }),
    registerRpc: vi.fn((name: string, fn: (params: unknown, ctx: unknown) => Promise<unknown>) => rpcs.set(name, fn)),
    registerAsset: vi.fn((path: string) => registrations.assets.push(path)),
    registerHook: vi.fn((event: string) => registrations.hooks.push(event)),
  }
  register(registry as never)
  return { rpcs, registrations }
}

describe('TypeScript plugin contract', () => {
  it('registers OpenFox v2 surfaces', () => {
    const value = makeRegistry()
    expect(value.registrations.tools).toBe(1)
    expect(value.registrations.actions).toHaveLength(1)
    expect(value.registrations.actions[0]?.slot).toBe('composer.actions')
    expect(value.registrations.badges).toHaveLength(1)
    expect(value.registrations.badges[0]?.slot).toBe('session.row.badges')
    expect(value.registrations.panels).toBe(1)
    expect(value.registrations.assets).toEqual(['dist/ui/git-workspace.html'])
    expect(value.registrations.hooks).toEqual(expect.arrayContaining(['session.created', 'turn.completed']))
    expect([...value.rpcs.keys()]).toEqual(expect.arrayContaining([
      'resolveContext','badge','observe','fetch','listBranches','createBranch',
      'checkoutBranch','checkoutNew','listWorkspaces','listSessions',
      'switchWorkspace','createWorkspace','deleteWorkspace'
    ]))
  })

  it('prefers live context over matching cached context', () => {
    const storage = makeStorage()
    writeLastContext(storage, { sessionId: 'same', workdir: '/old', projectId: 'p1' })
    expect(resolveContext({ sessionId: 'same', workdir: '/new' }, storage)).toEqual({
      sessionId: 'same', workdir: '/new', projectId: 'p1'
    })
  })

  it('never leaks a cached workdir into another session', () => {
    const storage = makeStorage()
    writeLastContext(storage, { sessionId: 'old-session', workdir: '/wrong/repo', projectId: 'p1' })
    expect(resolveContext({ sessionId: 'new-session', projectId: 'p2' }, storage)).toEqual({
      sessionId: 'new-session', workdir: '', projectId: 'p2'
    })
  })

  it('creates a branch through session checkout-new', async () => {
    const value = makeRegistry()
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toContain('/api/sessions/s1/checkout-new')
      expect(JSON.parse(String(init?.body))).toEqual({ name: 'feat/test', sourceBranch: 'main' })
      return new Response(JSON.stringify({ branch: 'feat/test' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await value.rpcs.get('createBranch')!({ name: 'feat/test', sourceBranch: 'main' }, { sessionId: 's1', workdir: '/tmp' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('keeps force-delete conflict metadata', async () => {
    const value = makeRegistry()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'Workspace in use', conflictingSessionIds: ['a','b'] }),
      { status: 409 }
    )))
    const result = await value.rpcs.get('deleteWorkspace')!({ target: 'issue-7' }, { sessionId: 's1', workdir: '/tmp' })
    expect(result).toEqual({
      ok: false, error: 'Workspace in use', retryWithForce: true, conflictingSessionIds: ['a','b']
    })
  })

  it('observes non-repository paths safely', async () => {
    const result = await observe('/tmp')
    expect(typeof result.ok).toBe('boolean')
  })
})
