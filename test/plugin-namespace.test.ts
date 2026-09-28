// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { register, RPC_NAMESPACE, type RegistryLike, type StorageLike } from '../src/plugin'

function makeStorage(): StorageLike {
  return {
    get: () => undefined,
    set: () => undefined,
  }
}

function makeRegistry() {
  const rpcs = new Map<string, (params: unknown, ctx: unknown) => Promise<unknown>>()
  const badges: Array<{ id: string; slot: string; source?: { kind: string; method: string } }> = []
  const registry: RegistryLike = {
    context: { storage: makeStorage(), logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    registerTool: vi.fn(),
    registerUiAction: vi.fn(),
    registerUiBadge: vi.fn((badge) => { badges.push(badge as { id: string; slot: string; source?: { kind: string; method: string } }) }),
    registerUiPanel: vi.fn(),
    registerRpc: vi.fn((name, fn) => { rpcs.set(name, fn as never) }),
    registerAsset: vi.fn(),
    registerHook: vi.fn(),
  }
  register(registry)
  return { rpcs, badges, registry }
}

describe('RPC namespacing (criterion DEV-78)', () => {
  it('exports the RPC_NAMESPACE constant', () => {
    expect(RPC_NAMESPACE).toBe('gitWorkspace.')
  })

  it('namespaces every registered RPC with the gitWorkspace. prefix', () => {
    const { rpcs } = makeRegistry()
    const names = [...rpcs.keys()]
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(name.startsWith('gitWorkspace.')).toBe(true)
    }
  })

  it('does not register any of the legacy generic RPC names', () => {
    const { rpcs } = makeRegistry()
    const legacy = [
      'resolveContext', 'badge', 'observe', 'fetch', 'listBranches', 'createBranch',
      'checkoutBranch', 'checkoutNew', 'listWorkspaces', 'listSessions',
      'switchWorkspace', 'createWorkspace', 'deleteWorkspace',
      'listStashes', 'applyStash', 'popStash', 'dropStash',
      'listTags', 'createTag', 'deleteTag', 'logRecent', 'diffStat',
      'willConflict', 'pull', 'reset', 'health',
    ]
    for (const name of legacy) {
      expect(rpcs.has(name)).toBe(false)
    }
  })

  it('registers gitWorkspace.health and returns counters/cacheSize/nodeVersion/uptime', async () => {
    const { rpcs } = makeRegistry()
    const handler = rpcs.get('gitWorkspace.health')
    expect(handler).toBeDefined()
    const health = (await handler!({}, {})) as { counters: unknown; cacheSize: number; uptime: number; nodeVersion: string }
    expect(health.counters).toBeTruthy()
    expect(typeof health.cacheSize).toBe('number')
    expect(typeof health.uptime).toBe('number')
    expect(health.nodeVersion).toMatch(/^v\d+/)
  })

  it('points the git badge source.method at gitWorkspace.badge', () => {
    const { badges } = makeRegistry()
    const badge = badges.find((b) => b.id === 'git-map-badge')
    expect(badge).toBeDefined()
    expect(badge?.source).toEqual({ kind: 'rpc', method: 'gitWorkspace.badge' })
  })

  it('preserves the namespaced key shape for every previously documented RPC', () => {
    const { rpcs } = makeRegistry()
    const expected = [
      'gitWorkspace.resolveContext', 'gitWorkspace.badge', 'gitWorkspace.observe',
      'gitWorkspace.fetch', 'gitWorkspace.listBranches', 'gitWorkspace.createBranch',
      'gitWorkspace.checkoutBranch', 'gitWorkspace.checkoutNew',
      'gitWorkspace.listWorkspaces', 'gitWorkspace.listSessions',
      'gitWorkspace.switchWorkspace', 'gitWorkspace.createWorkspace', 'gitWorkspace.deleteWorkspace',
      'gitWorkspace.listStashes', 'gitWorkspace.applyStash', 'gitWorkspace.popStash', 'gitWorkspace.dropStash',
      'gitWorkspace.listTags', 'gitWorkspace.createTag', 'gitWorkspace.deleteTag',
      'gitWorkspace.logRecent', 'gitWorkspace.diffStat', 'gitWorkspace.willConflict',
      'gitWorkspace.pull', 'gitWorkspace.reset', 'gitWorkspace.health',
    ]
    for (const name of expected) {
      expect(rpcs.has(name)).toBe(true)
    }
  })
})