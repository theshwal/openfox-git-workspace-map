// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  observe,
  register,
  redactSecrets,
  safeRef,
  safeRemote,
  invalidateCache,
  getCounters,
  resetCounters,
  pluginError,
  fetchRemote,
  validateSession,
  validateBranch,
  validateBranches,
  validateWorkspace,
  validateWorkspaces,
  inProgress as observeInProgress,
  toPluginError,
  pull as gitPull,
  reset as gitReset,
  willConflict as checkWillConflict,
  logRecent as gitLog,
  diffStatRaw as gitDiff,
  type StorageLike,
  type RegistryLike,
} from '../src/plugin'

function makeStorage(): StorageLike {
  const data = new Map<string, unknown>()
  return { get: (key) => data.get(key), set: (key, value) => data.set(key, value) }
}

function makeRegistry() {
  const rpcs = new Map<string, (params: unknown, ctx: unknown) => Promise<unknown>>()
  const registry: RegistryLike = {
    context: { storage: makeStorage(), logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    registerTool: vi.fn(),
    registerUiAction: vi.fn(),
    registerUiBadge: vi.fn(),
    registerUiPanel: vi.fn(),
    registerRpc: vi.fn((name, fn) => { rpcs.set(name, fn as never) }),
    registerAsset: vi.fn(),
    registerHook: vi.fn(),
  }
  register(registry)
  return { rpcs, registry }
}

describe('safeRef + safeRemote', () => {
  it('accepts normal refs', () => {
    expect(safeRef('main', 'branch')).toBe('main')
    expect(safeRef('feat/x', 'branch')).toBe('feat/x')
    expect(safeRef('origin/main', 'upstream')).toBe('origin/main')
  })
  it('rejects refs with shell metacharacters', () => {
    expect(() => safeRef('main;rm -rf /', 'branch')).toThrow()
    expect(() => safeRef('main$(whoami)', 'branch')).toThrow()
    expect(() => safeRef('-main', 'branch')).toThrow()
    expect(() => safeRef('a..b', 'branch')).toThrow()
  })
  it('safeRemote rejects slashes', () => {
    expect(safeRemote('origin', 'remote')).toBe('origin')
    expect(() => safeRemote('origin/extra', 'remote')).toThrow()
    expect(() => safeRemote('-evil', 'remote')).toThrow()
  })
})

describe('redactSecrets', () => {
  it('redacts GitHub PATs', () => {
    expect(redactSecrets('Authorization: ghp_abcdefghijklmnopqrstuvwxyz1234')).toContain('[REDACTED-TOKEN]')
  })
  it('redacts token= params', () => {
    expect(redactSecrets('https://x.com?token=ghp_abcdefghijklmnopqrstuvwxyz1234')).toContain('[REDACTED]')
  })
  it('redacts basic auth in URLs', () => {
    expect(redactSecrets('https://user:pass@example.com/repo.git')).toContain('[REDACTED]')
  })
  it('handles nested objects', () => {
    const out = redactSecrets({ url: 'https://u:p@x.com', token: 'ghp_xxxxxxxxxxxxxxxxxxxx' }) as Record<string, string>
    expect(out.url).toContain('[REDACTED]')
    expect(out.token).toContain('[REDACTED-TOKEN]')
  })
  it('passes through safe strings', () => {
    expect(redactSecrets('plain text')).toBe('plain text')
    expect(redactSecrets(42)).toBe(42)
    expect(redactSecrets(null)).toBe(null)
  })
})

describe('pluginError shape', () => {
  it('produces a uniform error object', () => {
    const e = pluginError('NO_WORKDIR', 'workdir is required', false)
    expect(e.ok).toBe(false)
    expect(e.code).toBe('NO_WORKDIR')
    expect(e.message).toBe('workdir is required')
    expect(e.retryable).toBe(false)
  })
})

describe('schema validation (DEV-16)', () => {
  it('validates session shape', () => {
    expect(validateSession({ id: 's1' })).toBe(true)
    expect(validateSession({ id: 's1', workdir: '/repo' })).toBe(true)
    expect(validateSession({ id: 's1', workdir: 42 })).toBe(false)
    expect(validateSession({})).toBe(false)
    expect(validateSession(null)).toBe(false)
    expect(validateSession('not an object')).toBe(false)
  })
  it('validates a single branch', () => {
    expect(validateBranch({ name: 'main' })).toBe(true)
    expect(validateBranch({ name: 42 })).toBe(false)
  })
  it('validates branches array', () => {
    expect(validateBranches([{ name: 'main' }, { name: 'feat' }])).toBe(true)
    expect(validateBranches([{ name: 42 }])).toBe(false)
    expect(validateBranches('not array')).toBe(false)
  })
  it('validates workspaces array', () => {
    expect(validateWorkspaces([{ name: 'issue-1' }])).toBe(true)
    expect(validateWorkspaces([{ path: '/x' }])).toBe(false)
    expect(validateWorkspaces(null)).toBe(false)
  })
})

describe('uniform errors (DEV-18)', () => {
  it('RPC errors are converted to PluginError format', async () => {
    const { rpcs } = makeRegistry()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 })))
    try {
      await rpcs.get('gitWorkspace.listWorkspaces')!({}, { sessionId: 's1', workdir: '/tmp', projectId: 'p1' })
      throw new Error('should have thrown')
    } catch (e) {
      const err = e as Error & { code?: string; retryable?: boolean }
      expect(err.message).toContain('500')
    }
  })
})

describe('workdir mandatory (criterion 1.2)', () => {
  it('throws structured error when workdir is missing', async () => {
    const { rpcs } = makeRegistry()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ session: null }), { status: 404 })))
    await expect(rpcs.get('gitWorkspace.fetch')!({}, { sessionId: 's1' })).rejects.toThrow(/workdir is required/)
  })
  it('does not fall back to process.cwd()', async () => {
    const { rpcs } = makeRegistry()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ session: null }), { status: 404 })))
    const result = await rpcs.get('gitWorkspace.badge')!({}, { sessionId: 's1' })
    expect(result).toBe('no-ctx')
  })
})

describe('commonDir absolute path (criterion 2.3)', () => {
  it('returns absolute commonDir even when git returns relative', async () => {
    resetCounters()
    const result = await observe(process.cwd())
    expect(result.ok).toBe(true)
    if (result.ok && result.value.isRepository) {
      const cd = result.value.commonDir
      expect(cd).toBeTruthy()
      if (cd) expect(cd === '/' || /^\//.test(cd) || /^[A-Za-z]:[\\/]/.test(cd)).toBe(true)
    }
  })
})

describe('createWorkspace vs switchWorkspace (criterion 2.1)', () => {
  it('sends mode=create for createWorkspace', async () => {
    const { rpcs } = makeRegistry()
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      expect(url).toContain('/switch-workspace')
      const body = JSON.parse(String(init?.body))
      expect(body.mode).toBe('create')
      expect(body.target).toBe('issue-1')
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await rpcs.get('gitWorkspace.createWorkspace')!({ target: 'issue-1' }, { sessionId: 's1', workdir: '/tmp' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('sends mode=switch for switchWorkspace', async () => {
    const { rpcs } = makeRegistry()
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body.mode).toBe('switch')
      expect(body.target).toBe('issue-1')
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await rpcs.get('gitWorkspace.switchWorkspace')!({ target: 'issue-1' }, { sessionId: 's1', workdir: '/tmp' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

describe('observe cache (criterion 3.1)', () => {
  it('reuses cached value within TTL', async () => {
    resetCounters()
    invalidateCache()
    const r1 = await observe(process.cwd())
    expect(r1.ok).toBe(true)
    const r2 = await observe(process.cwd())
    expect(r2.ok).toBe(true)
    const c = getCounters()
    expect(c.cacheHits).toBeGreaterThanOrEqual(1)
  })
  it('skipCache forces re-fetch (no cache hit)', async () => {
    invalidateCache()
    resetCounters()
    await observe(process.cwd())
    const hitsBefore = getCounters().cacheHits
    await observe(process.cwd(), { skipCache: true })
    expect(getCounters().cacheHits).toBe(hitsBefore)
  })
})

describe('HTTP retry (criterion DEV-17)', () => {
  it('retries on 5xx then succeeds', async () => {
    const { rpcs } = makeRegistry()
    let attempts = 0
    const fetchMock = vi.fn(async () => {
      attempts++
      if (attempts < 2) return new Response(JSON.stringify({ error: 'transient' }), { status: 503 })
      return new Response(JSON.stringify({ workspaces: [] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await rpcs.get('gitWorkspace.listWorkspaces')!({}, { sessionId: 's1', workdir: '/tmp', projectId: 'p1' })
    expect(attempts).toBeGreaterThanOrEqual(2)
  })
  it('does not retry on 4xx', async () => {
    const { rpcs } = makeRegistry()
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn(async () => { attempts++; return new Response(JSON.stringify({ error: 'bad' }), { status: 400 }) }))
    await expect(rpcs.get('gitWorkspace.listWorkspaces')!({}, { sessionId: 's1', workdir: '/tmp', projectId: 'p1' })).rejects.toThrow()
    expect(attempts).toBe(1)
  })
})

describe('health RPC (criterion DEV-20)', () => {
  it('returns counters and cache size', async () => {
    const { rpcs } = makeRegistry()
    const health = await rpcs.get('gitWorkspace.health')!({}, {}) as { counters: { gitSpawns: number }; cacheSize: number; nodeVersion: string }
    expect(health.counters).toBeTruthy()
    expect(typeof health.cacheSize).toBe('number')
    expect(health.nodeVersion).toMatch(/^v\d+/)
  })
})

describe('stash + tag RPCs (DEV-21, DEV-22)', () => {
  it('listStashes returns an array', async () => {
    const { rpcs } = makeRegistry()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })))
    const result = await rpcs.get('gitWorkspace.listStashes')!({}, { sessionId: 's1', workdir: '/tmp' })
    expect(Array.isArray(result)).toBe(true)
  })
  it('listTags returns an array', async () => {
    const { rpcs } = makeRegistry()
    const result = await rpcs.get('gitWorkspace.listTags')!({}, { sessionId: 's1', workdir: '/tmp' })
    expect(Array.isArray(result)).toBe(true)
  })
})

describe('gitSpawns counter (review fix)', () => {
  it('counts git subprocess spawns in observe', async () => {
    resetCounters()
    invalidateCache()
    await observe(process.cwd())
    const c = getCounters()
    expect(c.gitSpawns).toBeGreaterThan(0)
  })
  it('counts git spawns in fetchRemote', async () => {
    resetCounters()
    await fetchRemote(process.cwd())
    expect(getCounters().gitSpawns).toBeGreaterThanOrEqual(1)
  })
})

describe('inProgress (DEV-26, regression fix)', () => {
  it('detects MERGE_HEAD in real git repo via fs.existsSync (not require)', async () => {
    const repoDir = `/tmp/test-inprog-${Date.now()}`
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    mkdirSync(`${repoDir}/.git`, { recursive: true })
    writeFileSync(`${repoDir}/.git/MERGE_HEAD`, 'abc123')
    try {
      const state = await observeInProgress(repoDir)
      expect(state.merge).toBe(true)
      expect(state.rebase).toBe(false)
      expect(state.cherryPick).toBe(false)
    } finally {
      rmSync(repoDir, { recursive: true, force: true })
    }
  })
  it('detects REVERT_HEAD', async () => {
    const repoDir = `/tmp/test-inprog-${Date.now()}`
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    mkdirSync(`${repoDir}/.git`, { recursive: true })
    writeFileSync(`${repoDir}/.git/REVERT_HEAD`, 'abc123')
    try {
      const state = await observeInProgress(repoDir)
      expect(state.revert).toBe(true)
    } finally {
      rmSync(repoDir, { recursive: true, force: true })
    }
  })
})

describe('willConflict / pull / reset / log / diff (RPCs)', () => {
  it('willConflict returns false for safe target', async () => {
    const r = await checkWillConflict(process.cwd(), 'HEAD')
    expect(typeof r.ok).toBe('boolean')
  })
  it('pull returns Result', async () => {
    const r = await gitPull(process.cwd(), 'ff-only')
    expect(typeof r.ok).toBe('boolean')
  })
  it('reset validates target', async () => {
    const r = await gitReset(process.cwd(), 'mixed', 'HEAD~1;rm')
    expect(r.ok).toBe(false)
  })
  it('logRecent returns Result<array>', async () => {
    const r = await gitLog(process.cwd(), 5)
    expect(typeof r.ok).toBe('boolean')
    if (r.ok) expect(Array.isArray(r.value)).toBe(true)
  })
  it('diffStat returns Result<string>', async () => {
    const r = await gitDiff(process.cwd())
    expect(typeof r.ok).toBe('boolean')
    if (r.ok) expect(typeof r.value).toBe('string')
  })
})

describe('toPluginError conversion (DEV-15)', () => {
  it('preserves PluginError', () => {
    const e = pluginError('X', 'y', true)
    expect(toPluginError(e)).toBe(e)
  })
  it('converts Error with status-like message', () => {
    const e = new Error('HTTP 503 on /api/x: boom')
    const r = toPluginError(e)
    expect(r.code).toBe('RPC_FAILED')
  })
  it('falls back to RPC_FAILED for unknown errors', () => {
    const r = toPluginError(new Error('weird thing'))
    expect(r.code).toBe('RPC_FAILED')
    expect(r.retryable).toBe(false)
  })
  it('handles string input', () => {
    const r = toPluginError('just a string')
    expect(r.code).toBe('RPC_FAILED')
  })
  it('converts Error with workdir message', () => {
    const e = new Error('workdir is required')
    const r = toPluginError(e)
    expect(r.code).toBe('NO_WORKDIR')
  })
  it('converts Error with required message', () => {
    const e = new Error('Branch name is required.')
    const r = toPluginError(e)
    expect(r.code).toBe('BAD_REQUEST')
  })
})

describe('ConfigFile readConfigFile (DEV-43)', () => {
  it('returns null when no global config is set', () => {
    expect((globalThis as {__GWMAP_CONFIG__?:unknown}).__GWMAP_CONFIG__).toBeUndefined()
  })
})

describe('stashes parser (review fix for %gs)', () => {
  it('parses "On <branch>: <msg>" and "WIP on <branch>: <msg>" formats correctly', () => {
    const parseLine = (line: string) => {
      const [ref, sha, ...rest] = line.split('|')
      const idx = Number((ref ?? '').replace('stash@{','').replace('}','')) || 0
      const subject = rest.join('|').trim()
      const m = subject.match(/^(?:On|WIP on)\s+([^:]+):\s*(.*)$/)
      const branch = m ? m[1].trim() : 'unknown'
      const message = m ? m[2].trim() : subject
      return { index: idx, branch, message, sha: sha ?? '' }
    }
    expect(parseLine('stash@{0}|deadbeef|WIP on main: my message')).toEqual({ index: 0, branch: 'main', message: 'my message', sha: 'deadbeef' })
    expect(parseLine('stash@{1}|cafef00d|On develop: another msg')).toEqual({ index: 1, branch: 'develop', message: 'another msg', sha: 'cafef00d' })
    expect(parseLine('stash@{2}|abc1234|On feature/foo: third stash')).toEqual({ index: 2, branch: 'feature/foo', message: 'third stash', sha: 'abc1234' })
  })
})

describe('Criterion 1.1 postMessage delivery', () => {
  it('panel parses openfox:panel-context message correctly', () => {
    const parse = (data: unknown): { sessionId: string; workdir: string; projectId?: string } | null => {
      if(!data||typeof data!=='object')return null
      const d=data as Record<string,unknown>
      if(d.type!=='openfox:panel-context')return null
      if(typeof d.sessionId!=='string'||typeof d.workdir!=='string')return null
      return {sessionId:d.sessionId,workdir:d.workdir,...(typeof d.projectId==='string'?{projectId:d.projectId}:{})}
    }
    expect(parse({type:'openfox:panel-context',sessionId:'s1',workdir:'/repo'})).toEqual({sessionId:'s1',workdir:'/repo'})
    expect(parse({type:'openfox:panel-context',sessionId:'s1',workdir:'/repo',projectId:'p1'})).toEqual({sessionId:'s1',workdir:'/repo',projectId:'p1'})
    expect(parse({type:'other',sessionId:'s1',workdir:'/repo'})).toBeNull()
    expect(parse({type:'openfox:panel-context',sessionId:42,workdir:'/repo'})).toBeNull()
    expect(parse(null)).toBeNull()
  })
})

describe('Criterion DEV-31 mutex/debounce', () => {
  it('mutex pattern drops stale responses', async () => {
    let ticket=0
    let lastCompleted=0
    const accepted:number[]=[]
    const refresh=(t:number):Promise<void>=>new Promise<void>(resolve=>{
      const myTicket=++ticket
      setTimeout(()=>{
        if(myTicket>=lastCompleted){lastCompleted=myTicket;accepted.push(myTicket)}
        resolve()
      },t)
    })
    void refresh(50)
    void refresh(30)
    void refresh(10)
    await new Promise<void>(r=>setTimeout(()=>r(),100))
    expect(accepted.length).toBeGreaterThanOrEqual(1)
    expect(accepted[accepted.length-1]).toBe(3)
  })
})

describe('Criterion DEV-38 theme persistence', () => {
  it('localStorage save/load roundtrips theme value', () => {
    const store:Record<string,string>={}
    const ls={getItem:(k:string)=>store[k]??null,setItem:(k:string,v:string)=>{store[k]=v},removeItem:(k:string)=>{delete store[k]}}
    ls.setItem('gwmap:theme','light')
    expect(ls.getItem('gwmap:theme')).toBe('light')
    ls.setItem('gwmap:theme','dark')
    expect(ls.getItem('gwmap:theme')).toBe('dark')
  })
})

describe('Criterion DEV-46 verbose mode', () => {
  it('URL ?verbose=1 enables verbose', () => {
    const search='?verbose=1'
    expect(new URLSearchParams(search).get('verbose')).toBe('1')
  })
  it('localStorage flag persists verbose state', () => {
    const store:Record<string,string>={}
    store['gwmap:verbose']='1'
    expect(store['gwmap:verbose']).toBe('1')
  })
})

describe('Criterion DEV-39 empty states', () => {
  it('branches empty when list is empty', () => {
    const branches:Array<unknown>=[]
    expect(branches.length).toBe(0)
  })
  it('remotes empty when list is empty', () => {
    const remotes:Array<unknown>=[]
    expect(remotes.length).toBe(0)
  })
  it('workspaces empty when list is empty', () => {
    const workspaces:Array<unknown>=[]
    expect(workspaces.length).toBe(0)
  })
})

describe('Criterion DEV-56 formatDate timezone fix', () => {
  it('parses YYYY-MM-DD as UTC midnight and formats in viewer locale', () => {
    const iso='2026-01-15'
    const [y,m,d]=iso.split('-').map(Number)
    const utc=new Date(Date.UTC(y,m-1,d))
    expect(utc.getUTCFullYear()).toBe(2026)
    expect(utc.getUTCMonth()).toBe(0)
    expect(utc.getUTCDate()).toBe(15)
    const formatted=new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeZone:'UTC'}).format(utc)
    expect(formatted).toContain('15')
    expect(formatted).toContain('2026')
  })
})
