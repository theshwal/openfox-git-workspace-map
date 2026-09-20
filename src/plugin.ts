import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)
const DEFAULT_TIMEOUT = 15_000
const STORAGE_LAST_CONTEXT = 'lastActiveContext'

interface RpcContext { sessionId?: string; workdir?: string; projectId?: string }
interface ActiveContext { sessionId: string; workdir: string; projectId?: string }
interface StorageLike { get(key: string): unknown; set(key: string, value: string | number | boolean): void }
interface RegistryLike {
  context: { storage: StorageLike; logger: { debug(message: string, meta?: unknown): void } }
  registerTool(value: unknown): void
  registerUiAction(value: unknown): void
  registerUiBadge(value: unknown): void
  registerUiPanel(value: unknown): void
  registerRpc(name: string, handler: (params: unknown, context: RpcContext) => Promise<unknown>): void
  registerAsset(path: string): void
  registerHook(event: string, handler: (payload: Record<string, unknown>) => unknown): void
}
interface RemoteInfo { name: string; fetchUrl: string; pushUrl: string }
interface BranchInfo { name: string; sha: string; upstream: string | null; current: boolean }
interface DirtyState { clean: boolean; modified: number; files: string[]; porcelain: string; _error?: string }
interface RepoState { isRepository: boolean; cwd: string; toplevel?: string | null; commonDir?: string | null; branch?: string | null; headSha?: string | null; upstream?: string | null; ahead?: number; behind?: number; dirty?: DirtyState; remotes?: RemoteInfo[]; branches?: BranchInfo[] }
type Result<T> = { ok: true; value: T } | { ok: false; error: string }

function ok<T>(value: T): Result<T> { return { ok: true, value } }
function fail<T = never>(error: unknown): Result<T> { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
function safeRef(value: string, label: string): string {
  if (!value || !/^[A-Za-z0-9._\-/]+$/.test(value) || value.includes('..') || value.startsWith('-')) throw new Error(`${label} is not a safe git ref: ${value}`)
  return value
}
async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, timeout: DEFAULT_TIMEOUT, maxBuffer: 8 * 1024 * 1024 })
  return stdout.trimEnd()
}
async function gitRepository(cwd: string): Promise<boolean> { try { return (await runGit(cwd, ['rev-parse','--is-inside-work-tree'])) === 'true' } catch { return false } }
async function best(cwd: string, args: string[]): Promise<string | null> { try { return (await runGit(cwd, args)) || null } catch { return null } }
async function dirty(cwd: string): Promise<DirtyState> {
  try { const porcelain = await runGit(cwd, ['status','--porcelain','--untracked-files=all']); const lines = porcelain.split('\n').filter(Boolean); return { clean: !lines.length, modified: lines.length, files: lines.map(line => line.slice(3)), porcelain } }
  catch (error) { return { clean: true, modified: 0, files: [], porcelain: '', _error: error instanceof Error ? error.message : String(error) } }
}
async function remotes(cwd: string): Promise<RemoteInfo[]> {
  try {
    const map = new Map<string, Partial<RemoteInfo> & { name: string }>()
    for (const line of (await runGit(cwd, ['remote','-v'])).split('\n')) {
      const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/); if (!m) continue
      const [, name, url, kind] = m; const item = map.get(name) ?? { name }; if (kind === 'fetch') item.fetchUrl = url; else item.pushUrl = url; map.set(name, item)
    }
    return [...map.values()].map(r => ({ name: r.name, fetchUrl: r.fetchUrl ?? '', pushUrl: r.pushUrl ?? '' }))
  } catch { return [] }
}
async function branches(cwd: string): Promise<BranchInfo[]> {
  try {
    const format = ['%(HEAD)','%(refname:short)','%(objectname:short)','%(upstream:short)'].join('%00')
    return (await runGit(cwd, ['for-each-ref',`--format=${format}`,'refs/heads'])).split('\n').filter(Boolean).map(line => {
      const [head,name,sha,upstream] = line.split('\0'); return { name: name ?? '', sha: sha ?? '', upstream: upstream || null, current: head === '*' }
    }).filter(b => b.name)
  } catch { return [] }
}
export async function observe(cwd: string): Promise<Result<RepoState>> {
  if (!cwd) return fail(new Error('cwd is required'))
  if (!(await gitRepository(cwd))) return ok({ isRepository: false, cwd })
  const [toplevel, commonDir, branch, headSha, upstream, dirtyState, remoteList, branchList] = await Promise.all([
    best(cwd,['rev-parse','--show-toplevel']), best(cwd,['rev-parse','--git-common-dir']), best(cwd,['symbolic-ref','--quiet','--short','HEAD']), best(cwd,['rev-parse','--short','HEAD']), best(cwd,['rev-parse','--abbrev-ref','--symbolic-full-name','@{u}']), dirty(cwd), remotes(cwd), branches(cwd)
  ])
  let ahead = 0, behind = 0
  if (upstream) try { const [a,b] = (await runGit(cwd,['rev-list','--left-right','--count',`HEAD...${upstream}`])).split(/\s+/); ahead = Number(a)||0; behind = Number(b)||0 } catch { /* best effort */ }
  return ok({ isRepository: true, cwd, toplevel, commonDir, branch, headSha, upstream, ahead, behind, dirty: dirtyState, remotes: remoteList, branches: branchList })
}
export async function fetchRemote(cwd: string, remote?: string): Promise<Result<{ remote: string }>> {
  try { await runGit(cwd, remote ? ['fetch','--prune',safeRef(remote,'remote')] : ['fetch','--all','--prune']); return ok({ remote: remote ?? '*' }) } catch (error) { return fail(error) }
}

class HttpError extends Error { constructor(public status: number, public body: Record<string, unknown>, message: string) { super(message) } }
function host(): string { return process.env.OPENFOX_HOST || 'http://127.0.0.1:10369' }
function sessionToken(): string { return process.env.OPENFOX_SESSION_TOKEN || '' }
async function httpJSON(path: string, options: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const url = new URL(path, host()); const token = sessionToken(); if (token) url.searchParams.set('token', token)
  const headers: Record<string,string> = { Accept:'application/json' }; if (token) headers['x-session-token'] = token; if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(url, { method: options.method ?? 'GET', headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) })
  const text = await response.text(); let body: Record<string,unknown> = {}; try { body = text ? JSON.parse(text) as Record<string,unknown> : {} } catch { throw new Error(`Non-JSON response from ${path}`) }
  if (!response.ok) throw new HttpError(response.status, body, typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
  return body
}
export function readLastContext(storage: StorageLike): ActiveContext | null {
  const raw = storage.get(STORAGE_LAST_CONTEXT); if (typeof raw !== 'string') return null
  try { const p = JSON.parse(raw) as Partial<ActiveContext>; if (typeof p.workdir === 'string') return { sessionId: p.sessionId ?? '', workdir: p.workdir, ...(p.projectId ? { projectId:p.projectId } : {}) } } catch { /* ignore */ }
  return null
}
export function writeLastContext(storage: StorageLike, value: ActiveContext): void { try { storage.set(STORAGE_LAST_CONTEXT, JSON.stringify(value)) } catch { /* ignore */ } }
export function resolveContext(live: RpcContext | undefined, storage: StorageLike): ActiveContext {
  const cached = readLastContext(storage); const projectId = live?.projectId ?? cached?.projectId
  return { sessionId: live?.sessionId ?? cached?.sessionId ?? '', workdir: live?.workdir ?? cached?.workdir ?? process.cwd(), ...(projectId ? { projectId } : {}) }
}
function record(value: unknown): Record<string,unknown> { return value && typeof value === 'object' ? value as Record<string,unknown> : {} }
function required(value: unknown, label: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`); return value.trim() }
function badgeDelta(ahead=0, behind=0): string { return `${ahead>0?` ↑${ahead}`:''}${behind>0?` ↓${behind}`:''}` }

export function register(registry: RegistryLike): void {
  const storage = registry.context.storage
  const mirror = (ctx?: RpcContext) => { if (!ctx?.workdir && !ctx?.sessionId) return; writeLastContext(storage,{ sessionId:ctx.sessionId??'', workdir:ctx.workdir??process.cwd(), ...(ctx.projectId?{projectId:ctx.projectId}:{}) }) }
  const wrap = (fn: (params: Record<string,unknown>, ctx: ActiveContext) => Promise<unknown>) => async (params: unknown, live: RpcContext) => { mirror(live); return fn(record(params), resolveContext(live,storage)) }

  registry.registerTool({ name:'git_workspace_inspect', description:'Read-only Git workspace inspection for the active session.', parameters:{type:'object',properties:{includeFiles:{type:'boolean'}}}, execute:async(args:Record<string,unknown>,ctx:RpcContext)=>{
    const result=await observe(ctx.workdir||process.cwd()); if(!result.ok)return{success:false,error:result.error}; const r=result.value;if(!r.isRepository)return{success:true,output:'Not a git repository.'}; const d=r.dirty!; const lines=[`Branch: ${r.branch??'(detached)'}${r.upstream?` → ${r.upstream}`:''}`,`HEAD: ${r.headSha??'—'}`,`Ahead/behind: ↑${r.ahead??0} ↓${r.behind??0}`,`Working tree: ${d.clean?'clean':`${d.modified} modified file(s)`}`,`Remotes: ${(r.remotes??[]).map(x=>`${x.name}→${x.fetchUrl}`).join(', ')||'(none)'}`]; if(args.includeFiles===true&&!d.clean)lines.push(`Files: ${d.files.join(', ')}`); return{success:true,output:lines.join('\n')}
  }})
  registry.registerUiAction({ id:'git-map-open', slot:'session.header.actions', label:{en:'Git Workspace Map',fr:'Carte Git / Workspaces'}, icon:'folder', visibleWhen:{hasSession:true}, onActivate:{kind:'openPanel',panelId:'git-workspace'} })
  registry.registerUiBadge({ id:'git-map-badge', slot:'session.header.badges', label:{en:'git',fr:'git'}, tone:'info', visibleWhen:{hasSession:true}, source:{kind:'rpc',method:'badge'} })
  registry.registerUiPanel({ id:'git-workspace', title:{en:'Git Workspace Map',fr:'Carte Git / Workspaces'}, size:'lg', kind:'iframe', url:'dist/ui/git-workspace.html' })
  registry.registerAsset('dist/ui/git-workspace.html')

  registry.registerRpc('resolveContext',wrap(async(_p,c)=>c))
  registry.registerRpc('badge',wrap(async(_p,c)=>{const x=await observe(c.workdir);if(!x.ok)return'?';const r=x.value;if(!r.isRepository)return'no-git';if(!r.branch)return'detached';return`${r.branch}${r.dirty?.modified?` ±${r.dirty.modified}`:''}${badgeDelta(r.ahead,r.behind)}`}))
  registry.registerRpc('observe',wrap(async(_p,c)=>{const x=await observe(c.workdir);return x.ok?{ok:true,context:c,repo:x.value}:{ok:false,context:c,error:x.error}}))
  registry.registerRpc('fetch',wrap(async(p,c)=>{const x=await fetchRemote(c.workdir,typeof p.remote==='string'?p.remote:undefined);if(!x.ok)throw new Error(x.error);return{ok:true,...x.value}}))
  registry.registerRpc('listBranches',wrap(async(_p,c)=>{if(!c.sessionId)throw new Error('No active session.');return httpJSON(`/api/sessions/${encodeURIComponent(c.sessionId)}/branches`)}))
  registry.registerRpc('createBranch',wrap(async(p,c)=>{if(!c.sessionId)throw new Error('No active session.');return httpJSON(`/api/sessions/${encodeURIComponent(c.sessionId)}/checkout-new`,{method:'POST',body:{name:required(p.name,'Branch name'),...(typeof p.sourceBranch==='string'&&p.sourceBranch.trim()?{sourceBranch:p.sourceBranch.trim()}:{})}})}))
  registry.registerRpc('checkoutBranch',wrap(async(p,c)=>{if(!c.sessionId)throw new Error('No active session.');return httpJSON(`/api/sessions/${encodeURIComponent(c.sessionId)}/checkout`,{method:'POST',body:{branch:required(p.branch,'Branch name')}})}))
  registry.registerRpc('checkoutNew',wrap(async(p,c)=>{if(!c.projectId)throw new Error('No project context.');return httpJSON(`/api/projects/${encodeURIComponent(c.projectId)}/checkout-new`,{method:'POST',body:{name:required(p.name,'Branch name'),...(typeof p.sourceBranch==='string'?{sourceBranch:p.sourceBranch}:{})}})}))
  registry.registerRpc('listWorkspaces',wrap(async(_p,c)=>{if(!c.projectId)throw new Error('No project context.');return httpJSON(`/api/projects/${encodeURIComponent(c.projectId)}/workspaces`)}))
  registry.registerRpc('listSessions',wrap(async(_p,c)=>httpJSON(`/api/sessions${c.projectId?`?projectId=${encodeURIComponent(c.projectId)}&limit=100`:''}`)))
  registry.registerRpc('switchWorkspace',wrap(async(p,c)=>{if(!c.sessionId)throw new Error('No active session.');return httpJSON(`/api/sessions/${encodeURIComponent(c.sessionId)}/switch-workspace`,{method:'POST',body:{target:required(p.target,'Workspace target'),...(typeof p.branch==='string'&&p.branch?{branch:p.branch}:{}),...(typeof p.sourceBranch==='string'&&p.sourceBranch?{sourceBranch:p.sourceBranch}:{})}})}))
  registry.registerRpc('createWorkspace',wrap(async(p,c)=>{if(!c.sessionId)throw new Error('No active session.');return httpJSON(`/api/sessions/${encodeURIComponent(c.sessionId)}/switch-workspace`,{method:'POST',body:{target:required(p.target,'Workspace target'),...(typeof p.branch==='string'&&p.branch?{branch:p.branch}:{}),...(typeof p.sourceBranch==='string'&&p.sourceBranch?{sourceBranch:p.sourceBranch}:{})}})}))
  registry.registerRpc('deleteWorkspace',wrap(async(p,c)=>{if(!c.sessionId)throw new Error('No active session.');try{return await httpJSON(`/api/sessions/${encodeURIComponent(c.sessionId)}/delete-workspace`,{method:'POST',body:{target:required(p.target,'Workspace target'),force:p.force===true}})}catch(e){if(e instanceof HttpError&&e.status===409)return{ok:false,error:e.message,retryWithForce:true,conflictingSessionIds:e.body.conflictingSessionIds??[]};throw e}}))

  registry.registerHook('session.created',payload=>{mirror({sessionId:typeof payload.sessionId==='string'?payload.sessionId:undefined,projectId:typeof payload.projectId==='string'?payload.projectId:undefined});registry.context.logger.debug('git-workspace-map: session.created',{sessionId:payload.sessionId})})
  registry.registerHook('turn.completed',()=>undefined)
}

export const __INTERNAL__ = { STORAGE_LAST_CONTEXT }
