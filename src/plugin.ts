import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve as resolvePath, isAbsolute } from 'node:path'
import { existsSync } from 'node:fs'

const execFile = promisify(execFileCb)
const DEFAULT_TIMEOUT = 15_000
const HTTP_TIMEOUT = 10_000
const CACHE_TTL_MS = 5_000
const STORAGE_LAST_CONTEXT = 'lastActiveContext'

export interface RpcContext { sessionId?: string; workdir?: string; projectId?: string }
export interface ActiveContext { sessionId: string; workdir: string; projectId?: string }
export interface StorageLike { get(key: string): unknown; set(key: string, value: string | number | boolean): void }
export interface RegistryLike {
  context: { storage: StorageLike; logger: { debug(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void; error(message: string, meta?: unknown): void } }
  registerTool(value: unknown): void
  registerUiAction(value: unknown): void
  registerUiBadge(value: unknown): void
  registerUiPanel(value: unknown): void
  registerRpc(name: string, handler: (params: unknown, context: RpcContext) => Promise<unknown>): void
  registerAsset(path: string): void
  registerHook(event: string, handler: (payload: Record<string, unknown>) => unknown): void
}
export interface RemoteInfo { name: string; fetchUrl: string; pushUrl: string }
export interface BranchInfo { name: string; sha: string; upstream: string | null; current: boolean }
export interface Workspace { name: string; path?: string; branch?: string }
export interface StashInfo { index: number; branch: string; message: string; sha: string }
export interface TagInfo { name: string; sha: string; annotated: boolean }
export interface CommitInfo { sha: string; author: string; date: string; subject: string }
export interface DirtyState { clean: boolean; modified: number; files: string[]; porcelain: string; _error?: string; _truncated?: boolean; _omitted?: number }
export interface InProgressState { merge: boolean; rebase: boolean; cherryPick: boolean; revert: boolean; bisect: boolean }
export interface RepoState {
  isRepository: boolean
  cwd: string
  toplevel?: string | null
  commonDir?: string | null
  branch?: string | null
  headSha?: string | null
  upstream?: string | null
  ahead?: number
  behind?: number
  dirty?: DirtyState
  remotes?: RemoteInfo[]
  branches?: BranchInfo[]
  inProgress?: InProgressState
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export interface PluginError { ok: false; code: string; message: string; retryable: boolean }
export interface PluginOk<T> { ok: true; value: T }

function ok<T>(value: T): Result<T> { return { ok: true, value } }
function fail<T = never>(error: unknown): Result<T> { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
export function pluginError(code: string, message: string, retryable = false): PluginError { return { ok: false, code, message, retryable } }

export function toPluginError(err: unknown): PluginError {
  if (err && typeof err === 'object' && 'ok' in err && (err as { ok: unknown }).ok === false && 'code' in err) return err as PluginError
  if (err instanceof HttpError) {
    const status = err.status
    return pluginError(status >= 500 ? 'HTTP_RETRYABLE' : 'HTTP_FAILED', `HTTP ${status}: ${err.message}`, status >= 500)
  }
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('workdir is required')) return pluginError('NO_WORKDIR', message, false)
  if (message.includes('safe git ref')) return pluginError('UNSAFE_REF', message, false)
  if (message.includes('safe git remote')) return pluginError('UNSAFE_REMOTE', message, false)
  if (message.includes('required') || message.includes('No active session') || message.includes('No project context')) return pluginError('BAD_REQUEST', message, false)
  return pluginError('RPC_FAILED', message, false)
}

const SAFE_REF = /^[A-Za-z0-9._\-/]+$/
const SAFE_REMOTE = /^[A-Za-z0-9._\-]+$/

export function safeRef(value: string, label: string): string {
  if (!value || !SAFE_REF.test(value) || value.includes('..') || value.startsWith('-')) throw new Error(`${label} is not a safe git ref: ${value}`)
  return value
}
export function safeRemote(value: string, label: string): string {
  if (!value || !SAFE_REMOTE.test(value) || value.startsWith('-')) throw new Error(`${label} is not a safe git remote: ${value}`)
  return value
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bghp_[A-Za-z0-9]{20,}/g, '[REDACTED-TOKEN]'],
  [/\bx-access-token:[^\s]+/g, 'x-access-token:[REDACTED]'],
  [/\bpassword=[^\s&]+/g, 'password=[REDACTED]'],
  [/\btoken=[^\s&]+/g, 'token=[REDACTED]'],
  [/https:\/\/[^@/\s]+:[^@/\s]+@/g, 'https://[REDACTED]@'],
]

export function redactSecrets(input: unknown): unknown {
  if (typeof input === 'string') {
    let s = input
    for (const [re, sub] of SECRET_PATTERNS) s = s.replace(re, sub)
    return s
  }
  if (Array.isArray(input)) return input.map(redactSecrets)
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[k] = redactSecrets(v)
    return out
  }
  return input
}

export function isString(v: unknown): v is string { return typeof v === 'string' }
export function isObject(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v) }
export function isArrayOf<T>(v: unknown, guard: (x: unknown) => x is T): v is T[] { return Array.isArray(v) && v.every(guard) }

export interface SessionShape { id: string; projectId?: string; workdir?: string; workspace?: string | null }
export function validateSession(value: unknown): value is SessionShape {
  if (!isObject(value)) return false
  if (!isString(value.id)) return false
  if ('projectId' in value && !isString(value.projectId)) return false
  if ('workdir' in value && !isString(value.workdir)) return false
  if ('workspace' in value && value.workspace !== null && !isString(value.workspace)) return false
  return true
}

export function validateBranch(value: unknown): value is BranchInfo {
  if (!isObject(value)) return false
  return isString(value.name)
}
export function validateBranches(value: unknown): value is BranchInfo[] {
  return isArrayOf<BranchInfo>(value, validateBranch)
}

export function validateWorkspace(value: unknown): value is Workspace {
  if (!isObject(value)) return false
  return isString(value.name)
}
export function validateWorkspaces(value: unknown): value is Workspace[] {
  return isArrayOf<Workspace>(value, validateWorkspace)
}

export function validateSessionResponse(value: unknown): Record<string, unknown> | null {
  if (!isObject(value)) return null
  if ('session' in value && !validateSession(value.session)) return null
  return value
}

export async function runGit(cwd: string, args: string[]): Promise<string> {
  counters.gitSpawns++
  const { stdout } = await execFile('git', args, { cwd, timeout: DEFAULT_TIMEOUT, maxBuffer: 8 * 1024 * 1024 })
  return stdout.trimEnd()
}
export async function gitRepository(cwd: string): Promise<boolean> { try { return (await runGit(cwd, ['rev-parse','--is-inside-work-tree'])) === 'true' } catch { return false } }
export async function best(cwd: string, args: string[]): Promise<string | null> { try { return (await runGit(cwd, args)) || null } catch { return null } }
export async function dirty(cwd: string): Promise<DirtyState> {
  try {
    const porcelain = await runGit(cwd, ['status','--porcelain','--untracked-files=all'])
    const lines = porcelain.split('\n').filter(Boolean)
    const MAX_FILES = 500
    const MAX_PORCELAIN_BYTES = 100 * 1024
    const truncated = porcelain.length > MAX_PORCELAIN_BYTES || lines.length > MAX_FILES
    const visibleLines = truncated ? lines.slice(0, MAX_FILES) : lines
    return {
      clean: !lines.length,
      modified: lines.length,
      files: visibleLines.map(line => line.slice(3)),
      porcelain: truncated ? porcelain.slice(0, MAX_PORCELAIN_BYTES) : porcelain,
      _truncated: truncated || undefined,
      _omitted: truncated ? lines.length - visibleLines.length : undefined,
    }
  } catch (error) { return { clean: true, modified: 0, files: [], porcelain: '', _error: error instanceof Error ? error.message : String(error) } }
}
export async function remotes(cwd: string): Promise<RemoteInfo[]> {
  try {
    const map = new Map<string, Partial<RemoteInfo> & { name: string }>()
    for (const line of (await runGit(cwd, ['remote','-v'])).split('\n')) {
      const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/); if (!m) continue
      const [, name, url, kind] = m; const item = map.get(name) ?? { name }; if (kind === 'fetch') item.fetchUrl = url; else item.pushUrl = url; map.set(name, item)
    }
    return [...map.values()].map(r => ({ name: r.name, fetchUrl: r.fetchUrl ?? '', pushUrl: r.pushUrl ?? '' }))
  } catch { return [] }
}
export async function branches(cwd: string): Promise<BranchInfo[]> {
  try {
    const format = ['%(HEAD)','%(refname:short)','%(objectname:short)','%(upstream:short)'].join('%00')
    return (await runGit(cwd, ['for-each-ref',`--format=${format}`,'refs/heads'])).split('\n').filter(Boolean).map(line => {
      const [head,name,sha,upstream] = line.split('\0'); return { name: name ?? '', sha: sha ?? '', upstream: upstream || null, current: head === '*' }
    }).filter(b => b.name)
  } catch { return [] }
}
export async function stashes(cwd: string): Promise<StashInfo[]> {
  try {
    const out = await runGit(cwd, ['stash','list','--format=%gd|%H|%s'])
    return out.split('\n').filter(Boolean).map(line => {
      const [ref, sha, ...rest] = line.split('|')
      const idx = Number((ref ?? '').replace('stash@{','').replace('}','')) || 0
      const subject = rest.join('|').trim()
      const m = subject.match(/^(?:On|WIP on)\s+([^:]+):\s*(.*)$/)
      const branch = m ? m[1].trim() : 'unknown'
      const message = m ? m[2].trim() : subject
      return { index: idx, branch, message, sha: sha ?? '' }
    })
  } catch { return [] }
}
export async function tags(cwd: string): Promise<TagInfo[]> {
  try {
    const out = await runGit(cwd, ['for-each-ref','--format=%(refname:short)|%(objectname)|%(*objectname)','refs/tags'])
    return out.split('\n').filter(Boolean).map(line => {
      const [name, sha, peeled] = line.split('|')
      return { name: name ?? '', sha: (peeled || sha) ?? '', annotated: !!peeled }
    }).filter(t => t.name)
  } catch { return [] }
}
export async function log(cwd: string, limit = 10): Promise<CommitInfo[]> {
  try {
    const fmt = ['%H','%an','%ad','%s'].join('%00')
    const out = await runGit(cwd, ['log',`-n`,String(limit),`--format=${fmt}`, '--date=short'])
    return out.split('\n').filter(Boolean).map(line => {
      const [sha, author, date, ...subjectParts] = line.split('\0')
      return { sha: sha ?? '', author: author ?? '', date: date ?? '', subject: subjectParts.join('\0') }
    })
  } catch { return [] }
}
export async function diffStat(cwd: string): Promise<string> {
  try { return await runGit(cwd, ['diff','--stat','--no-color']) } catch { return '' }
}
export async function inProgress(cwd: string): Promise<InProgressState> {
  const is = (p: string) => { try { return existsSync(`${cwd}/.git/${p}`) } catch { return false } }
  return {
    merge: is('MERGE_HEAD'),
    rebase: is('rebase-merge') || is('rebase-apply'),
    cherryPick: is('CHERRY_PICK_HEAD'),
    revert: is('REVERT_HEAD'),
    bisect: is('BISECT_LOG'),
  }
}
export async function mergeTreeWouldConflict(cwd: string, target: string): Promise<boolean> {
  try {
    const out = await runGit(cwd, ['merge-tree', safeRef(target, 'target'), 'HEAD'])
    return /\b(?:CONFLICT|conflict)/.test(out)
  } catch { return true }
}

interface CacheEntry<T> { value: T; expires: number; hits: number }
const cache = new Map<string, CacheEntry<unknown>>()
const counters = { cacheHits: 0, cacheMisses: 0, gitSpawns: 0, errors: 0 }

export function invalidateCache(key?: string): void { if (key) cache.delete(key); else cache.clear() }
export function getCounters(): typeof counters { return { ...counters } }
export function resetCounters(): void { Object.assign(counters, { cacheHits: 0, cacheMisses: 0, gitSpawns: 0, errors: 0 }) }

async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expires > now) { hit.hits++; counters.cacheHits++; return hit.value as T }
  counters.cacheMisses++
  const value = await fn()
  cache.set(key, { value, expires: now + ttl, hits: 0 })
  return value
}

export async function observe(cwd: string, options: { skipCache?: boolean } = {}): Promise<Result<RepoState>> {
  if (!cwd) return fail(new Error('cwd is required'))
  if (!(await gitRepository(cwd))) return ok({ isRepository: false, cwd })

  const work = async () => {
    const [toplevel, commonDirRaw, branch, headSha, upstream, dirtyState, remoteList, branchList, progress] = await Promise.all([
      best(cwd,['rev-parse','--show-toplevel']),
      best(cwd,['rev-parse','--git-common-dir']),
      best(cwd,['symbolic-ref','--quiet','--short','HEAD']),
      best(cwd,['rev-parse','--short','HEAD']),
      best(cwd,['rev-parse','--abbrev-ref','--symbolic-full-name','@{u}']),
      dirty(cwd),
      remotes(cwd),
      branches(cwd),
      inProgress(cwd),
    ])
    const commonDir = commonDirRaw ? (isAbsolute(commonDirRaw) ? commonDirRaw : resolvePath(cwd, commonDirRaw)) : null
    const toplevelAbs = toplevel ? (isAbsolute(toplevel) ? toplevel : resolvePath(cwd, toplevel)) : null
    let ahead = 0, behind = 0
    if (upstream) try {
      const [a,b] = (await runGit(cwd,['rev-list','--left-right','--count',`HEAD...${upstream}`])).split(/\s+/); ahead = Number(a)||0; behind = Number(b)||0
    } catch { /* best effort */ }
    return { isRepository: true, cwd, toplevel: toplevelAbs, commonDir, branch, headSha, upstream, ahead, behind, dirty: dirtyState, remotes: remoteList, branches: branchList, inProgress: progress } as RepoState
  }

  try {
    const value = options.skipCache ? await work() : await cached(`observe:${cwd}`, CACHE_TTL_MS, work)
    return ok(value)
  } catch (error) { counters.errors++; return fail(error) }
}

export async function fetchRemote(cwd: string, remote?: string): Promise<Result<{ remote: string }>> {
  try {
    if (remote) safeRemote(remote, 'remote')
    await runGit(cwd, remote ? ['fetch','--prune', remote] : ['fetch','--all','--prune'])
    invalidateCache(`observe:${cwd}`)
    return ok({ remote: remote ?? '*' })
  } catch (error) { counters.errors++; return fail(error) }
}

export async function stashList(cwd: string): Promise<Result<StashInfo[]>> { try { return ok(await stashes(cwd)) } catch (error) { counters.errors++; return fail(error) } }
export async function stashApply(cwd: string, index = 0): Promise<Result<{ applied: number }>> {
  try { await runGit(cwd, ['stash','apply',`stash@{${index}}`]); return ok({ applied: index }) } catch (error) { counters.errors++; return fail(error) }
}
export async function stashPop(cwd: string, index = 0): Promise<Result<{ popped: number }>> {
  try { await runGit(cwd, ['stash','pop',`stash@{${index}}`]); return ok({ popped: index }) } catch (error) { counters.errors++; return fail(error) }
}
export async function stashDrop(cwd: string, index = 0): Promise<Result<{ dropped: number }>> {
  try { await runGit(cwd, ['stash','drop',`stash@{${index}}`]); return ok({ dropped: index }) } catch (error) { counters.errors++; return fail(error) }
}
export async function tagList(cwd: string): Promise<Result<TagInfo[]>> { try { return ok(await tags(cwd)) } catch (error) { counters.errors++; return fail(error) } }
export async function tagCreate(cwd: string, name: string, message?: string): Promise<Result<{ name: string }>> {
  try {
    safeRef(name, 'tag')
    const args = message && message.trim() ? ['tag','-a',name,'-m',message] : ['tag',name]
    await runGit(cwd, args)
    invalidateCache(`observe:${cwd}`)
    return ok({ name })
  } catch (error) { counters.errors++; return fail(error) }
}
export async function tagDelete(cwd: string, name: string): Promise<Result<{ name: string }>> {
  try { await runGit(cwd, ['tag','-d', safeRef(name, 'tag')]); invalidateCache(`observe:${cwd}`); return ok({ name }) } catch (error) { counters.errors++; return fail(error) }
}
export async function logRecent(cwd: string, limit = 10): Promise<Result<CommitInfo[]>> { try { return ok(await log(cwd, limit)) } catch (error) { counters.errors++; return fail(error) } }
export async function diffStatRaw(cwd: string): Promise<Result<string>> { try { return ok(await diffStat(cwd)) } catch (error) { counters.errors++; return fail(error) } }
export async function willConflict(cwd: string, target: string): Promise<Result<{ conflict: boolean }>> {
  try { return ok({ conflict: await mergeTreeWouldConflict(cwd, target) }) } catch (error) { counters.errors++; return fail(error) }
}
export type PullMode = 'ff-only' | 'rebase' | 'merge'
export async function pull(cwd: string, mode: PullMode = 'ff-only', remote?: string, branch?: string): Promise<Result<{ mode: PullMode }>> {
  try {
    if (remote) safeRemote(remote, 'remote')
    if (branch) safeRef(branch, 'branch')
    const args = ['pull']
    if (mode === 'ff-only') args.push('--ff-only')
    else if (mode === 'rebase') args.push('--rebase')
    if (remote) args.push(remote)
    if (branch) args.push(branch)
    await runGit(cwd, args)
    invalidateCache(`observe:${cwd}`)
    return ok({ mode })
  } catch (error) { counters.errors++; return fail(error) }
}
export type ResetMode = 'soft' | 'mixed' | 'hard'
export async function reset(cwd: string, mode: ResetMode, target: string): Promise<Result<{ mode: ResetMode; target: string }>> {
  try {
    safeRef(target, 'target')
    await runGit(cwd, ['reset',`--${mode}`, target])
    invalidateCache(`observe:${cwd}`)
    return ok({ mode, target })
  } catch (error) { counters.errors++; return fail(error) }
}

class HttpError extends Error { constructor(public status: number, public body: Record<string, unknown>, message: string) { super(message) } }

function host(): string { return process.env.OPENFOX_HOST || 'http://127.0.0.1:10369' }
function sessionToken(): string { return process.env.OPENFOX_SESSION_TOKEN || '' }

async function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

async function httpJSONWithRetry(path: string, options: { method?: string; body?: unknown; maxRetries?: number } = {}): Promise<unknown> {
  const maxRetries = options.maxRetries ?? 2
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await httpJSON(path, options)
    } catch (error) {
      lastError = error
      const retryable = error instanceof HttpError ? error.status >= 500 : true
      if (!retryable || attempt === maxRetries) throw error
      await sleep(2 ** attempt * 200)
    }
  }
  throw lastError
}

async function httpJSON(path: string, options: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const url = new URL(path, host()); const token = sessionToken(); if (token) url.searchParams.set('token', token)
  const headers: Record<string,string> = { Accept:'application/json','Accept-Encoding':'gzip, deflate' }; if (token) headers['x-session-token'] = token; if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT)
  try {
    const response = await fetch(url, { method: options.method ?? 'GET', headers, signal: controller.signal, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) })
    const text = await response.text(); let body: Record<string,unknown> = {}; try { body = text ? JSON.parse(text) as Record<string,unknown> : {} } catch { throw new Error(`Non-JSON response from ${path}`) }
    if (!response.ok) throw new HttpError(response.status, body, typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
    return body
  } finally { clearTimeout(timer) }
}

export function readLastContext(storage: StorageLike): ActiveContext | null {
  const raw = storage.get(STORAGE_LAST_CONTEXT); if (typeof raw !== 'string') return null
  try { const p = JSON.parse(raw) as Partial<ActiveContext>; if (typeof p.workdir === 'string') return { sessionId: p.sessionId ?? '', workdir: p.workdir, ...(p.projectId ? { projectId:p.projectId } : {}) } } catch { /* ignore */ }
  return null
}
export function writeLastContext(storage: StorageLike, value: ActiveContext): void { try { storage.set(STORAGE_LAST_CONTEXT, JSON.stringify(value)) } catch { /* ignore */ } }
export function resolveContext(live: RpcContext | undefined, storage: StorageLike): ActiveContext {
  const cached = readLastContext(storage)
  const liveSessionId = live?.sessionId ?? ''
  const matchingCached = !liveSessionId || cached?.sessionId === liveSessionId ? cached : null
  const projectId = live?.projectId ?? matchingCached?.projectId
  return {
    sessionId: liveSessionId || matchingCached?.sessionId || '',
    workdir: live?.workdir ?? matchingCached?.workdir ?? '',
    ...(projectId ? { projectId } : {}),
  }
}

async function hydrateSessionContext(context: ActiveContext): Promise<ActiveContext> {
  if (context.workdir || !context.sessionId) return context
  try {
    const body = validateSessionResponse(await httpJSON(`/api/sessions/${encodeURIComponent(context.sessionId)}`))
    if (!body) return context
    const session = isObject(body.session) ? body.session : {}
    const workspace = typeof session.workspace === 'string' ? session.workspace.trim() : ''
    const workdir = typeof session.workdir === 'string' ? session.workdir.trim() : ''
    const projectId = typeof session.projectId === 'string' ? session.projectId : context.projectId
    if (!workspace && !workdir) return context
    return {
      sessionId: context.sessionId,
      workdir: workspace || workdir,
      ...(projectId ? { projectId } : {}),
    }
  } catch {
    return context
  }
}
function record(value: unknown): Record<string,unknown> { return value && typeof value === 'object' ? value as Record<string,unknown> : {} }
function required(value: unknown, label: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`); return value.trim() }
function badgeDelta(ahead=0, behind=0): string { return `${ahead>0?` ↑${ahead}`:''}${behind>0?` ↓${behind}`:''}` }

export function register(registry: RegistryLike): void {
  const storage = registry.context.storage
  const logger = registry.context.logger

  const mirror = (ctx?: RpcContext) => {
    if (!ctx?.sessionId && !ctx?.workdir) return
    writeLastContext(storage, {
      sessionId: ctx.sessionId ?? '',
      workdir: ctx.workdir ?? '',
      ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    })
  }

  const requireWorkdir = (ctx: ActiveContext): string => {
    if (!ctx.workdir) {
      const err = pluginError('NO_WORKDIR', 'workdir is required for this RPC. Provide it via the active session context.', false)
      throw new Error(JSON.stringify(err))
    }
    return ctx.workdir
  }

  const wrap = (fn: (params: Record<string,unknown>, ctx: ActiveContext) => Promise<unknown>) => async (params: unknown, live: RpcContext) => {
    const resolved = await hydrateSessionContext(resolveContext(live, storage))
    mirror(resolved)
    const correlationId = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    logger.debug('git-workspace-map: rpc start', redactSecrets({ correlationId, sessionId: resolved.sessionId, workdir: resolved.workdir ? '[set]' : '[missing]' }))
    try {
      const out = await fn(record(params), resolved)
      logger.debug('git-workspace-map: rpc ok', redactSecrets({ correlationId }))
      return out
    } catch (error) {
      counters.errors++
      const message = error instanceof Error ? error.message : String(error)
      logger.error('git-workspace-map: rpc error', redactSecrets({ correlationId, error: message }))
      const err = toPluginError(error)
      throw err
    }
  }

  registry.registerTool({ name:'git_workspace_inspect', description:'Read-only Git workspace inspection for the active session.', parameters:{type:'object',properties:{includeFiles:{type:'boolean'}}}, execute:async(args:Record<string,unknown>,ctx:RpcContext)=>{
    const workdir = ctx.workdir ?? ''
    if (!workdir) return { success: false, error: 'workdir is required' }
    const result = await observe(workdir); if(!result.ok) return { success: false, error: result.error }
    const r = result.value; if(!r.isRepository) return { success: true, output: 'Not a git repository.' }
    const d = r.dirty!; const lines = [`Branch: ${r.branch??'(detached)'}${r.upstream?` → ${r.upstream}`:''}`,`HEAD: ${r.headSha??'—'}`,`Ahead/behind: ↑${r.ahead??0} ↓${r.behind??0}`,`Working tree: ${d.clean?'clean':`${d.modified} modified file(s)`}`,`Remotes: ${(r.remotes??[]).map(x=>`${x.name}→${x.fetchUrl}`).join(', ')||'(none)'}`]
    if(args.includeFiles===true && !d.clean) lines.push(`Files: ${d.files.join(', ')}`)
    return { success: true, output: lines.join('\n') }
  }})

  registry.registerUiAction({
    id:'git-map-open',
    slot:'composer.actions',
    label:{en:'Git Workspace Map',fr:'Carte Git / Workspaces'},
    icon:'folder',
    tooltip:{en:'Open Git data for this session',fr:'Ouvrir les données Git de cette session'},
    visibleWhen:{hasSession:true},
    onActivate:{kind:'openPanel',panelId:'git-workspace'}
  })
  registry.registerUiBadge({
    id:'git-map-badge',
    slot:'session.row.badges',
    label:{en:'git',fr:'git'},
    tone:'info',
    visibleWhen:{hasSession:true},
    source:{kind:'rpc',method:'badge'}
  })
  registry.registerUiPanel({ id:'git-workspace', title:{en:'Git Workspace Map',fr:'Carte Git / Workspaces'}, size:'lg', kind:'iframe', url:'dist/ui/git-workspace.html' })
  registry.registerAsset('dist/ui/git-workspace.html')

  registry.registerRpc('resolveContext', wrap(async (_p, c) => c))
  registry.registerRpc('badge', wrap(async (_p, c) => {
    if (!c.workdir) return 'no-ctx'
    const x = await observe(c.workdir); if (!x.ok) return '?'
    const r = x.value; if (!r.isRepository) return 'no-git'
    if (!r.branch) return 'detached'
    return `${r.branch}${r.dirty?.modified ? ` ±${r.dirty.modified}` : ''}${badgeDelta(r.ahead, r.behind)}`
  }))
  registry.registerRpc('observe', wrap(async (_p, c) => {
    if (!c.workdir) return { ok: false, context: c, error: 'workdir is required' }
    const x = await observe(c.workdir, { skipCache: true })
    return x.ok ? { ok: true, context: c, repo: x.value } : { ok: false, context: c, error: x.error }
  }))

  registry.registerRpc('fetch', wrap(async (p, c) => {
    requireWorkdir(c)
    const remote = typeof p.remote === 'string' ? p.remote : undefined
    const x = await fetchRemote(c.workdir, remote)
    if (!x.ok) throw new Error(x.error)
    return { ok: true, ...x.value }
  }))
  registry.registerRpc('listBranches', wrap(async (_p, c) => {
    requireWorkdir(c)
    const obs = await observe(c.workdir)
    if (!obs.ok) throw new Error(obs.error)
    return { branches: obs.value.branches ?? [] }
  }))
  registry.registerRpc('createBranch', wrap(async (p, c) => {
    if (!c.sessionId) throw new Error('No active session.')
    return httpJSONWithRetry(`/api/sessions/${encodeURIComponent(c.sessionId)}/checkout-new`, { method: 'POST', body: { name: required(p.name, 'Branch name'), ...(typeof p.sourceBranch === 'string' && p.sourceBranch.trim() ? { sourceBranch: p.sourceBranch.trim() } : {}) } })
  }))
  registry.registerRpc('checkoutBranch', wrap(async (p, c) => {
    if (!c.sessionId) throw new Error('No active session.')
    return httpJSONWithRetry(`/api/sessions/${encodeURIComponent(c.sessionId)}/checkout`, { method: 'POST', body: { branch: required(p.branch, 'Branch name') } })
  }))
  registry.registerRpc('checkoutNew', wrap(async (p, c) => {
    if (!c.projectId) throw new Error('No project context.')
    return httpJSONWithRetry(`/api/projects/${encodeURIComponent(c.projectId)}/checkout-new`, { method: 'POST', body: { name: required(p.name, 'Branch name'), ...(typeof p.sourceBranch === 'string' ? { sourceBranch: p.sourceBranch } : {}) } })
  }))
  registry.registerRpc('listWorkspaces', wrap(async (_p, c) => {
    if (!c.projectId) throw new Error('No project context.')
    return httpJSONWithRetry(`/api/projects/${encodeURIComponent(c.projectId)}/workspaces`)
  }))
  registry.registerRpc('listSessions', wrap(async (_p, c) => httpJSONWithRetry(`/api/sessions${c.projectId ? `?projectId=${encodeURIComponent(c.projectId)}&limit=100` : ''}`)))

  registry.registerRpc('switchWorkspace', wrap(async (p, c) => {
    if (!c.sessionId) throw new Error('No active session.')
    return httpJSONWithRetry(`/api/sessions/${encodeURIComponent(c.sessionId)}/switch-workspace`, { method: 'POST', body: { target: required(p.target, 'Workspace target'), mode: 'switch', ...(typeof p.branch === 'string' && p.branch ? { branch: p.branch } : {}), ...(typeof p.sourceBranch === 'string' && p.sourceBranch ? { sourceBranch: p.sourceBranch } : {}) } })
  }))
  registry.registerRpc('createWorkspace', wrap(async (p, c) => {
    if (!c.sessionId) throw new Error('No active session.')
    return httpJSONWithRetry(`/api/sessions/${encodeURIComponent(c.sessionId)}/switch-workspace`, { method: 'POST', body: { target: required(p.target, 'Workspace target'), mode: 'create', ...(typeof p.branch === 'string' && p.branch ? { branch: p.branch } : {}), ...(typeof p.sourceBranch === 'string' && p.sourceBranch ? { sourceBranch: p.sourceBranch } : {}) } })
  }))
  registry.registerRpc('deleteWorkspace', wrap(async (p, c) => {
    if (!c.sessionId) throw new Error('No active session.')
    try {
      return await httpJSONWithRetry(`/api/sessions/${encodeURIComponent(c.sessionId)}/delete-workspace`, { method: 'POST', body: { target: required(p.target, 'Workspace target'), force: p.force === true } })
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) return { ok: false, error: e.message, retryWithForce: true, conflictingSessionIds: e.body.conflictingSessionIds ?? [] }
      throw e
    }
  }))

  registry.registerRpc('listStashes', wrap(async (_p, c) => {
    requireWorkdir(c)
    const x = await stashList(c.workdir); if (!x.ok) throw new Error(x.error); return x.value
  }))
  registry.registerRpc('applyStash', wrap(async (p, c) => {
    requireWorkdir(c); const idx = typeof p.index === 'number' ? p.index : 0
    const x = await stashApply(c.workdir, idx); if (!x.ok) throw new Error(x.error); return x.value
  }))
  registry.registerRpc('popStash', wrap(async (p, c) => {
    requireWorkdir(c); const idx = typeof p.index === 'number' ? p.index : 0
    const x = await stashPop(c.workdir, idx); if (!x.ok) throw new Error(x.error); return x.value
  }))
  registry.registerRpc('dropStash', wrap(async (p, c) => {
    requireWorkdir(c); const idx = typeof p.index === 'number' ? p.index : 0
    const x = await stashDrop(c.workdir, idx); if (!x.ok) throw new Error(x.error); return x.value
  }))
  registry.registerRpc('listTags', wrap(async (_p, c) => {
    requireWorkdir(c)
    const x = await tagList(c.workdir); if (!x.ok) throw new Error(x.error); return x.value
  }))
  registry.registerRpc('createTag', wrap(async (p, c) => {
    requireWorkdir(c)
    const x = await tagCreate(c.workdir, required(p.name, 'Tag name'), typeof p.message === 'string' ? p.message : undefined)
    if (!x.ok) throw new Error(x.error); return x.value
  }))
  registry.registerRpc('deleteTag', wrap(async (p, c) => {
    requireWorkdir(c)
    const x = await tagDelete(c.workdir, required(p.name, 'Tag name'))
    if (!x.ok) throw new Error(x.error); return x.value
  }))
  registry.registerRpc('logRecent', wrap(async (p, c) => {
    requireWorkdir(c); const limit = typeof p.limit === 'number' ? Math.max(1, Math.min(50, p.limit)) : 10
    const x = await logRecent(c.workdir, limit); if (!x.ok) throw new Error(x.error); return x.value
  }))
  registry.registerRpc('diffStat', wrap(async (_p, c) => {
    requireWorkdir(c); const x = await diffStatRaw(c.workdir); if (!x.ok) throw new Error(x.error); return x.value
  }))
  registry.registerRpc('willConflict', wrap(async (p, c) => {
    requireWorkdir(c); const x = await willConflict(c.workdir, required(p.target, 'target branch'))
    return x.ok ? x.value : { conflict: true }
  }))
  registry.registerRpc('pull', wrap(async (p, c) => {
    requireWorkdir(c); const mode = (p.mode === 'rebase' || p.mode === 'merge') ? p.mode : 'ff-only'
    const remote = typeof p.remote === 'string' ? p.remote : undefined
    const branch = typeof p.branch === 'string' ? p.branch : undefined
    const x = await pull(c.workdir, mode, remote, branch); if (!x.ok) throw new Error(x.error); return x.value
  }))
  registry.registerRpc('reset', wrap(async (p, c) => {
    requireWorkdir(c); const mode: ResetMode = (p.mode === 'soft' || p.mode === 'hard') ? p.mode : 'mixed'
    const x = await reset(c.workdir, mode, required(p.target, 'target')); if (!x.ok) throw new Error(x.error); return x.value
  }))
  registry.registerRpc('health', wrap(async () => ({
    counters: getCounters(),
    cacheSize: cache.size,
    uptime: process.uptime(),
    nodeVersion: process.version,
  })))

  registry.registerHook('session.created', payload => {
    mirror({ sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined, projectId: typeof payload.projectId === 'string' ? payload.projectId : undefined, workdir: typeof payload.workdir === 'string' ? payload.workdir : undefined })
    logger.debug('git-workspace-map: session.created', redactSecrets({ sessionId: payload.sessionId }))
  })
  registry.registerHook('session.terminated', payload => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
    if (sessionId) invalidateCache()
    logger.debug('git-workspace-map: session.terminated', { sessionId })
  })
  registry.registerHook('turn.completed', () => undefined)
}

export const __INTERNAL__ = { STORAGE_LAST_CONTEXT, invalidateCache, getCounters, resetCounters }
