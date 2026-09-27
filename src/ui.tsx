import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './ui.css'

type Context={sessionId:string;workdir:string;projectId?:string}
type Dirty={clean:boolean;modified:number;files:string[];porcelain:string}
type Remote={name:string;fetchUrl:string;pushUrl:string}
type Branch={name:string;sha?:string;upstream?:string|null;current?:boolean}
type InProgress={merge:boolean;rebase:boolean;cherryPick:boolean;revert:boolean;bisect:boolean}
type Repo={isRepository:boolean;cwd:string;toplevel?:string|null;commonDir?:string|null;branch?:string|null;headSha?:string|null;upstream?:string|null;ahead?:number;behind?:number;dirty?:Dirty;remotes?:Remote[];branches?:Branch[];inProgress?:InProgress}
type Workspace={name:string;path?:string;branch?:string}
type Session={id:string;title?:string;workspace?:string|null;branch?:string|null;isRunning?:boolean}
type Snapshot={context:Context;repo:Repo|null;branches:Branch[];workspaces:Workspace[];sessions:Session[];error?:string;loading:boolean}

const PLUGIN_ID='openfox-git-workspace-map'
const TOKEN=new URLSearchParams(location.search).get('token')??''
let activeContext:Context|null=null

export type Lang='en'|'fr'
const STRINGS:Record<Lang,Record<string,string>>={
  en:{title:'Git Workspace Map',topology:'Topology',status:'Status',branches:'Branches',workspaces:'Workspaces',remotes:'Remotes',projectSessions:'Project sessions',refresh:'Refresh',fetchAll:'Fetch all + prune',fetch:'Fetch',createCheckout:'Create & checkout',checkout:'Checkout',createSwitch:'Create / switch',switch:'Switch',delete:'Delete',newBranch:'New branch',sourceBranch:'Source branch',workspaceName:'Workspace name',workspaceBranch:'Workspace branch',workspaceSource:'Workspace source',remote:'Remote',noContext:'No context',loadingTopology:'Loading topology…',noRepo:'Not a Git repository.',noRemotes:'No remotes configured.',noBranches:'No local branches yet.',noWorkspaces:'No additional workspaces.',noSessions:'No sessions.',workingClean:'clean',modifiedSuffix:'modified',deleteConfirm:'Delete workspace',forceDeleteConfirm:'Force delete? Workspace used by',forceDeleteTitle:'Force delete',retryForce:'Retry with force',session:'session',cancel:'Cancel',confirm:'Confirm',light:'Light',dark:'Dark',allRemotes:'all remotes',language:'Language',recentCommits:'Recent commits',noCommits:'No commits yet',showAll:'Show all',showLess:'Show less',inProgress:'In progress',inProgressMerge:'merge',inProgressRebase:'rebase',inProgressCherryPick:'cherry-pick',inProgressRevert:'revert',inProgressBisect:'bisect',dangerZone:'Danger zone',resetHard:'Reset hard',resetTarget:'Reset target',mergeConflict:'Merge conflict?',forceCheckout:'Force checkout',resetDestructive:'Reset destructive',confirmReset:'Confirm reset',resetHardWarning:'This will discard all uncommitted changes.',resetMixedWarning:'This will unstage changes but keep them in the working tree.',resetSoftWarning:'This will keep changes staged.',deleteWorkspaceBody:'Delete workspace',deleteWorkspaceWarning:'This action may affect other sessions.',mergeConflictBody:'Checking out',mergeConflictWarn:'would create merge conflicts.',forceCheckoutHint:'Proceed anyway? Local changes may be overwritten.',resetBody:'Reset',resetModeLabel:'with mode',forceDeleteBody:'is currently in use by other sessions',pollInterval:'Poll interval (ms)',mainProjectWorkspace:'main project workspace'},
  fr:{title:'Carte Git / Workspaces',topology:'Topologie',status:'Statut',branches:'Branches',workspaces:'Workspaces',remotes:'Remotes',projectSessions:'Sessions du projet',refresh:'Rafraîchir',fetchAll:'Fetch tout + prune',fetch:'Fetch',createCheckout:'Créer et checkout',checkout:'Checkout',createSwitch:'Créer / switcher',switch:'Switcher',delete:'Supprimer',newBranch:'Nouvelle branche',sourceBranch:'Branche source',workspaceName:'Nom du workspace',workspaceBranch:'Branche du workspace',workspaceSource:'Source du workspace',remote:'Remote',noContext:'Aucun contexte',loadingTopology:'Chargement de la topologie…',noRepo:'Pas un dépôt Git.',noRemotes:'Aucun remote configuré.',noBranches:'Aucune branche locale.',noWorkspaces:'Aucun workspace supplémentaire.',noSessions:'Aucune session.',workingClean:'propre',modifiedSuffix:'modifié(s)',deleteConfirm:'Supprimer le workspace',forceDeleteConfirm:'Forcer la suppression ? Workspace utilisé par',forceDeleteTitle:'Forcer la suppression',retryForce:'Réessayer avec force',session:'session',cancel:'Annuler',confirm:'Confirmer',light:'Clair',dark:'Sombre',allRemotes:'tous les remotes',language:'Langue',recentCommits:'Commits récents',noCommits:'Aucun commit',showAll:'Tout afficher',showLess:'Réduire',inProgress:'En cours',inProgressMerge:'merge',inProgressRebase:'rebase',inProgressCherryPick:'cherry-pick',inProgressRevert:'revert',inProgressBisect:'bisect',dangerZone:'Zone dangereuse',resetHard:'Reset hard',resetTarget:'Cible du reset',mergeConflict:'Conflit de merge ?',forceCheckout:'Forcer le checkout',resetDestructive:'Reset destructif',confirmReset:'Confirmer le reset',resetHardWarning:'Cela supprimera toutes les modifications non commitées.',resetMixedWarning:'Cela déstage les modifications mais les conserve dans le working tree.',resetSoftWarning:'Cela conserve les modifications staged.',deleteWorkspaceBody:'Supprimer le workspace',deleteWorkspaceWarning:'Cette action peut affecter d\'autres sessions.',mergeConflictBody:'Checkout de',mergeConflictWarn:'provoquerait des conflits de merge.',forceCheckoutHint:'Continuer quand même ? Les modifications locales peuvent être écrasées.',resetBody:'Reset',resetModeLabel:'avec le mode',forceDeleteBody:'est actuellement utilisé par d\'autres sessions',pollInterval:'Intervalle de poll (ms)',mainProjectWorkspace:'workspace principal du projet'}
}
function detectLang():Lang{const p=new URLSearchParams(location.search).get('lang');if(p==='fr'||p==='en')return p;const nav=navigator.language.toLowerCase();return nav.startsWith('fr')?'fr':'en'}
const DEFAULT_POLL_MS=15000
const PREF_KEYS={theme:'gwmap:theme',lang:'gwmap:lang',poll:'gwmap:poll',verbose:'gwmap:verbose'}
function loadPrefs():{theme:'dark'|'light';lang:Lang;pollMs:number;verbose:boolean;defaultBranchFilter?:string}{
  const out={theme:(typeof localStorage!=='undefined'&&localStorage.getItem(PREF_KEYS.theme)==='light'?'light':'dark') as 'dark'|'light',lang:detectLang(),pollMs:DEFAULT_POLL_MS,verbose:false,defaultBranchFilter:undefined as string|undefined}
  if(typeof localStorage!=='undefined'){
    const stored=localStorage.getItem(PREF_KEYS.poll);if(stored){const n=Number(stored);if(Number.isFinite(n)&&n>=2000&&n<=600000)out.pollMs=n}
    if(localStorage.getItem(PREF_KEYS.verbose)==='1')out.verbose=true
  }
  const qp=new URLSearchParams(location.search)
  if(qp.get('verbose')==='1')out.verbose=true
  if(qp.get('poll')){const n=Number(qp.get('poll'));if(Number.isFinite(n)&&n>=2000&&n<=600000)out.pollMs=n}
  const fileCfg=readConfigFile()
  if(fileCfg){
    if(fileCfg.theme==='light'||fileCfg.theme==='dark')out.theme=fileCfg.theme
    if(fileCfg.lang==='en'||fileCfg.lang==='fr')out.lang=fileCfg.lang
    if(typeof fileCfg.pollMs==='number'&&Number.isFinite(fileCfg.pollMs)&&fileCfg.pollMs>=2000&&fileCfg.pollMs<=600000)out.pollMs=fileCfg.pollMs
    if(fileCfg.verbose===true)out.verbose=true
    if(typeof fileCfg.defaultBranchFilter==='string')out.defaultBranchFilter=fileCfg.defaultBranchFilter
  }
  return out
}

interface ConfigFile{theme?:'dark'|'light';lang?:Lang;pollMs?:number;verbose?:boolean;defaultBranchFilter?:string}

function readConfigFile():ConfigFile|null{
  try{
    const w=window as unknown as {__GWMAP_CONFIG__?:ConfigFile}
    if(w.__GWMAP_CONFIG__&&typeof w.__GWMAP_CONFIG__==='object')return w.__GWMAP_CONFIG__
  }catch{/* SSR or no window */}
  return null
}
function savePref(key:string,value:string){try{localStorage.setItem(key,value)}catch{}}
function formatDate(iso:string,lang:Lang):string{
  if(!iso)return'—'
  const locale=lang==='fr'?'fr-FR':'en-US'
  try{
    if(/^\d{4}-\d{2}-\d{2}$/.test(iso)){
      const [y,m,d]=iso.split('-').map(Number)
      const utc=new Date(Date.UTC(y,m-1,d))
      return new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone:'UTC'}).format(utc)
    }
    return new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'}).format(new Date(iso))
  }catch{return iso}
}

export function sessionIdFromReferrer(referrer:string):string|null{
  if(!referrer)return null
  try{
    const url=new URL(referrer,location.origin)
    const match=url.pathname.match(/\/p\/[^/]+\/s\/([^/?#]+)/)
    return match?.[1]?decodeURIComponent(match[1]):null
  }catch{return null}
}

async function sessionContextFromReferrer():Promise<Context|null>{
  const sessionId=sessionIdFromReferrer(document.referrer)
  if(!sessionId)return null
  const url=new URL(`/api/sessions/${encodeURIComponent(sessionId)}`,location.origin)
  if(TOKEN)url.searchParams.set('token',TOKEN)
  const headers:Record<string,string>={Accept:'application/json'}
  if(TOKEN)headers['x-session-token']=TOKEN
  const response=await fetch(url,{headers})
  if(!response.ok)return null
  const body=await response.json() as {session?:{id?:string;projectId?:string;workdir?:string;workspace?:string|null}}
  const session=body.session
  const workdir=(session?.workspace||session?.workdir||'').trim()
  if(!session?.id||!workdir)return null
  return{sessionId:session.id,workdir,...(session.projectId?{projectId:session.projectId}:{})}
}

function listenForParentContext(timeoutMs=500):Promise<Context|null>{
  return new Promise((resolve)=>{
    let done=false
    let timer:ReturnType<typeof setTimeout>|null=null
    const cfg=(typeof window!=='undefined'?(window as unknown as {__GWMAP_CONFIG__?:{parentOrigin?:string;allowAnyParentOrigin?:boolean}}).__GWMAP_CONFIG__:undefined)
    const configuredOrigin=cfg?.parentOrigin
    const ancestors=(typeof window!=='undefined'&&window.location&&(window.location as {ancestorOrigins?:DOMStringList}).ancestorOrigins)?((window.location as {ancestorOrigins?:DOMStringList}).ancestorOrigins as unknown as string[]):[]
    const ancestorOrigin=ancestors&&ancestors.length>0?ancestors[0]:null
    const sameOrigin=typeof window!=='undefined'&&window.location?window.location.origin:''
    const allowedOrigin=configuredOrigin||ancestorOrigin||(cfg?.allowAnyParentOrigin?sameOrigin:null)
    const finish=(ctx:Context|null)=>{
      if(done)return
      done=true
      if(timer){clearTimeout(timer);timer=null}
      try{window.removeEventListener('message',handler)}catch{}
      resolve(ctx)
    }
    const handler=(event:MessageEvent)=>{
      if(allowedOrigin&&event.origin!==allowedOrigin)return
      const data=event.data as {type?:string;sessionId?:string;workdir?:string;projectId?:string}|null
      if(!data||data.type!=='openfox:panel-context')return
      if(typeof data.sessionId!=='string'||typeof data.workdir!=='string')return
      finish({sessionId:data.sessionId,workdir:data.workdir,...(data.projectId?{projectId:data.projectId}:{})})
    }
    try{window.addEventListener('message',handler)}catch{finish(null);return}
    timer=setTimeout(()=>finish(null),timeoutMs)
  })
}

export async function rpc<T>(method:string,params:Record<string,unknown>={},context:Context|null=activeContext):Promise<T>{
  const url=new URL(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/rpc/${encodeURIComponent(method)}`,location.origin)
  if(TOKEN)url.searchParams.set('token',TOKEN)
  const headers:Record<string,string>={'Content-Type':'application/json','Accept-Encoding':'gzip, deflate'}
  if(TOKEN)headers['x-session-token']=TOKEN
  const payload={params,...(context?.sessionId?{sessionId:context.sessionId}:{}),...(context?.workdir?{workdir:context.workdir}:{}),...(context?.projectId?{projectId:context.projectId}:{})}
  const controller=new AbortController()
  const timer=setTimeout(()=>controller.abort(),15000)
  try{
    const response=await fetch(url,{method:'POST',headers,signal:controller.signal,body:JSON.stringify(payload)})
    const body=await response.json().catch(()=>({})) as {result?:T;error?:string;code?:string;retryable?:boolean}
    if(!response.ok){
      const err=new Error(body.error||`RPC ${method} failed (${response.status})`)
      ;(err as Error & {code?:string;retryable?:boolean}).code=body.code
      ;(err as Error & {code?:string;retryable?:boolean}).retryable=body.retryable
      throw err
    }
    return body.result as T
  }finally{clearTimeout(timer)}
}

export async function resolvePanelContext():Promise<Context>{
  const fromParent=await listenForParentContext().catch(()=>null)
  if(fromParent){activeContext=fromParent;return fromParent}
  const fromSession=await sessionContextFromReferrer().catch(()=>null)
  if(fromSession){activeContext=fromSession;return fromSession}
  const fallback=await rpc<Context>('resolveContext',{},null)
  activeContext=fallback
  return fallback
}

export async function loadSnapshot():Promise<Snapshot>{
  const context=await resolvePanelContext()
  activeContext=context
  const observed=await rpc<{ok:boolean;repo?:Repo;error?:string}>('observe',{},context)
  const repo=observed.ok?observed.repo??null:null
  if(!context.sessionId){
    return {context, repo, branches:repo?.branches??[], workspaces:[], sessions:[], error:observed.error, loading:false}
  }
  const results=await Promise.allSettled([
    rpc<{branches?:Branch[]}>('listBranches',{},context),
    rpc<{workspaces?:Workspace[]}>('listWorkspaces',{},context),
    rpc<{sessions?:Session[]}>('listSessions',{},context),
  ])
  const br=results[0].status==='fulfilled'?(results[0].value as {branches?:Branch[]}):({branches:[]})
  const ws=results[1].status==='fulfilled'?(results[1].value as {workspaces?:Workspace[]}):({workspaces:[]})
  const sess=results[2].status==='fulfilled'?(results[2].value as {sessions?:Session[]}):({sessions:[]})
  const errors=[results[0],results[1],results[2]].filter(r=>r.status==='rejected').map(r=>(r as PromiseRejectedResult).reason?.message??'error')
  return {context,repo,branches:br.branches??repo?.branches??[],workspaces:ws.workspaces??[],sessions:sess.sessions??[],error:errors.length?errors.join('; '):observed.error,loading:false}
}

function Modal({open,title,children,onCancel,onConfirm,confirmLabel,confirmDanger,cancelText='Cancel'}:{open:boolean;title:string;children:React.ReactNode;onCancel:()=>void;onConfirm:()=>void;confirmLabel:string;confirmDanger?:boolean;cancelText?:string}){
  const ref=useRef<HTMLDivElement>(null)
  const onCancelRef=useRef(onCancel)
  const onConfirmRef=useRef(onConfirm)
  onCancelRef.current=onCancel
  onConfirmRef.current=onConfirm
  useEffect(()=>{
    if(!open)return
    const previouslyFocused=document.activeElement as HTMLElement|null
    ref.current?.focus()
    const handler=(e:KeyboardEvent)=>{
      if(e.key==='Escape'){e.preventDefault();onCancelRef.current()}
      if(e.key==='Tab'){
        const focusables=ref.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        if(!focusables||focusables.length===0)return
        const first=focusables[0];const last=focusables[focusables.length-1]
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
      }
    }
    document.addEventListener('keydown',handler)
    return()=>{document.removeEventListener('keydown',handler);previouslyFocused?.focus()}
  },[open])
  if(!open)return null
  return <div className="modal-backdrop" role="presentation" onClick={()=>onCancelRef.current()}><div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onClick={e=>e.stopPropagation()}><h3>{title}</h3><div className="modal-body">{children}</div><div className="modal-actions"><button onClick={()=>onCancelRef.current()}>{cancelText}</button><button className={confirmDanger?'danger':''} onClick={()=>onConfirmRef.current()}>{confirmLabel}</button></div></div></div>
}

function Skeleton({lines=3}:{lines?:number}){
  return <div className="skeleton" aria-hidden="true">{Array.from({length:lines}).map((_,i)=><div key={i} className="skeleton-line"/>)}</div>
}

function EmptyState({message}:{message:string}){return <p className="empty">{message}</p>}

export function App(){
 const prefsRef=useRef(loadPrefs())
 const[s,setS]=useState<Snapshot|null>(null)
 const[loading,setLoading]=useState(false)
 const[mutating,setMutating]=useState(false)
 const[toast,setToast]=useState<string>('')
 const[toastTimer,setToastTimer]=useState<ReturnType<typeof setTimeout>|null>(null)
 const[branch,setBranch]=useState(''),[source,setSource]=useState('')
 const[wsName,setWsName]=useState(''),[wsBranch,setWsBranch]=useState(''),[wsSource,setWsSource]=useState('')
 const[remote,setRemote]=useState('')
 const[pendingDelete,setPendingDelete]=useState<{workspace:Workspace;force?:boolean;conflictingSessionIds?:string[];reason?:string}|null>(null)
 const[pendingReset,setPendingReset]=useState<{mode:'soft'|'mixed'|'hard';target:string}|null>(null)
 const[pendingCheckout,setPendingCheckout]=useState<{branch:string;conflict:boolean}|null>(null)
 const[recentCommits,setRecentCommits]=useState<Array<{sha:string;author:string;date:string;subject:string}>>([])
 const[branchesExpanded,setBranchesExpanded]=useState(false)
 const[lang,setLangState]=useState<Lang>(prefsRef.current.lang)
 const[theme,setThemeState]=useState<'dark'|'light'>(prefsRef.current.theme)
 const[pollMs,setPollMsState]=useState<number>(prefsRef.current.pollMs)
 const[verbose,setVerboseState]=useState<boolean>(prefsRef.current.verbose)
 const inFlightRef=useRef<number>(0)
 const lastCompletedRef=useRef<number>(0)
 const t=useCallback((key:string)=>STRINGS[lang][key]??key,[lang])
 const setLang=(l:Lang)=>{setLangState(l);savePref(PREF_KEYS.lang,l)}
 const setTheme=(th:'dark'|'light')=>{setThemeState(th);savePref(PREF_KEYS.theme,th)}
 const setPollMs=(ms:number)=>{setPollMsState(ms);savePref(PREF_KEYS.poll,String(ms))}
 const setVerbose=(v:boolean)=>{setVerboseState(v);savePref(PREF_KEYS.verbose,v?'1':'0')}
 useEffect(()=>{document.documentElement.dataset.theme=theme},[theme])
 useEffect(()=>{if(verbose)console.debug('[gwmap] verbose mode enabled')},[verbose])

 const flashToastRef=useRef<(message:string)=>void>(()=>{})
 flashToastRef.current=(message:string)=>{
   setToast(message)
   if(toastTimer)clearTimeout(toastTimer)
   setToastTimer(setTimeout(()=>setToast(''),4000))
 }
 const flashToast=useCallback((message:string)=>flashToastRef.current(message),[])

 const refreshRef=useRef<()=>Promise<void>>(async()=>{})
 refreshRef.current=async()=>{
   const ticket=++inFlightRef.current
   setLoading(true)
   try{
     const snap=await loadSnapshot()
     if(ticket>=lastCompletedRef.current){lastCompletedRef.current=ticket;setS(snap)}
     try{
       const logs=await rpc<Array<{sha:string;author:string;date:string;subject:string}>>('logRecent',{limit:5})
       if(ticket>=lastCompletedRef.current)setRecentCommits(Array.isArray(logs)?logs:[])
     }catch{/* non-fatal */}
   }catch(e){flashToast(e instanceof Error?e.message:String(e))}
   finally{if(ticket===inFlightRef.current)setLoading(false)}
 }
 const refresh=useCallback(()=>refreshRef.current(),[])

 useEffect(()=>{void refresh();const id=setInterval(()=>void refresh(),pollMs);return()=>clearInterval(id)},[refresh,pollMs])
 useEffect(()=>()=>{if(toastTimer)clearTimeout(toastTimer)},[toastTimer])

 const run=useCallback(async(label:string,fn:()=>Promise<unknown>)=>{
   setMutating(true)
   try{
     const result=await fn() as {retry?:boolean}|undefined
     if(!result||!result.retry)flashToast(label)
     if(!result||!result.retry)await refresh()
   }
   catch(e){flashToast(e instanceof Error?e.message:String(e))}
   finally{setMutating(false)}
 },[refresh,flashToast])

 const repo=s?.repo,dirty=repo?.dirty
 const sessionCounts=useMemo(()=>{const m=new Map<string,number>();for(const x of s?.sessions??[])if(x.workspace)m.set(x.workspace,(m.get(x.workspace)??0)+1);return m},[s?.sessions])
 const branchList=s?.branches??[]
 const BRANCH_VISIBLE=10
 const visibleBranches=branchesExpanded?branchList:branchList.slice(0,BRANCH_VISIBLE)

 async function doCheckout(branchName:string){
   if(verbose)console.debug('[gwmap] doCheckout',branchName)
   try{
     const will=await rpc<{conflict:boolean}>('willConflict',{target:branchName})
     if(will?.conflict){setPendingCheckout({branch:branchName,conflict:true});return}
   }catch{/* best-effort */}
   await run(`Checked out ${branchName}`,()=>rpc('checkoutBranch',{branch:branchName}))
 }

 async function confirmCheckout(){
   if(!pendingCheckout)return
   const {branch:bn}=pendingCheckout
   setPendingCheckout(null)
   await run(`Checked out ${bn}`,()=>rpc('checkoutBranch',{branch:bn}))
 }

 async function doDelete(workspace:Workspace,force=false){
   await run(force?`Force deleted ${workspace.name}`:`Deleted ${workspace.name}`,async()=>{
     const r=await rpc<{retryWithForce?:boolean;conflictingSessionIds?:string[];error?:string;ok?:boolean}>('deleteWorkspace',{target:workspace.name,force})
     if(r&&(r as {retryWithForce?:boolean}).retryWithForce){
       setPendingDelete({workspace,force:true,conflictingSessionIds:(r as {conflictingSessionIds?:string[]}).conflictingSessionIds??[],reason:(r as {error?:string}).error??''})
       return { retry:true }
     }
     return { retry:false }
   })
 }

 async function confirmDelete(workspace:Workspace){
   setPendingDelete({workspace,force:false})
 }

 async function performDelete(){
   if(!pendingDelete)return
   const {workspace,force}=pendingDelete
   setPendingDelete(null)
   await doDelete(workspace,force)
 }

 async function escalateForce(){
   if(!pendingDelete)return
   const {workspace}=pendingDelete
   setPendingDelete(null)
   await doDelete(workspace,true)
 }

 const upstreamRemote=repo?.upstream?.split('/')[0]
 const origin=repo?.remotes?.find(r=>r.name===upstreamRemote)

 return <main className="app">
 <header><div><h1>{t('title')}</h1><p>{s?.context.sessionId?`${t('session')} ${s.context.sessionId.slice(0,8)}`:s?.context.workdir||t('noContext')}</p></div>
 <div className="row"><button onClick={()=>void refresh()}>{t('refresh')}</button>
 <button disabled={mutating} onClick={()=>void run(t('fetchAll'),()=>rpc('fetch'))}>{t('fetchAll')}</button>
 <button onClick={()=>setTheme(theme==='dark'?'light':'dark')} aria-label="Toggle theme">{theme==='dark'?t('light'):t('dark')}</button>
 <select aria-label={t('language')} value={lang} onChange={e=>setLang(e.target.value as Lang)}><option value="en">EN</option><option value="fr">FR</option></select>
 <button onClick={()=>setVerbose(!verbose)} aria-label="Toggle verbose" title="Verbose">{verbose?'V●':'V○'}</button>
 <input type="number" aria-label={t('pollInterval')} min={2000} max={600000} step={1000} value={pollMs} onChange={e=>setPollMs(Math.max(2000,Math.min(600000,Number(e.target.value)||DEFAULT_POLL_MS)))} style={{width:90}}/>
 </div></header>

 <section className="grid">
 <article><h2>{t('topology')}</h2>
 {!repo?<Skeleton lines={4}/>:!repo.isRepository?<EmptyState message={t('noRepo')}/>:
 <div className="topology">{[['Upstream',repo.commonDir||repo.toplevel],['Workspace',repo.toplevel||repo.cwd],['Branch',repo.branch?`${repo.branch} @ ${repo.headSha}`:`detached @ ${repo.headSha}`],...(repo.upstream?[['Tracking',repo.upstream],['Origin',origin?`${origin.name} (${origin.fetchUrl})`:upstreamRemote]]:[])].map(([k,v],i)=><div key={k}>{i>0&&<div className="arrow">↓</div>}<div className="node"><small>{k}</small><strong>{v||'—'}</strong></div></div>)}</div>}
 </article>

 <article><h2>{t('status')}</h2>
 {!repo?<Skeleton lines={5}/>:
 <><dl><dt>Branch</dt><dd>{repo.branch||'—'}</dd><dt>HEAD</dt><dd className="mono">{repo.headSha||'—'}</dd><dt>Upstream</dt><dd>{repo.upstream||'—'}</dd><dt>Ahead / behind</dt><dd>↑{repo.ahead??0} ↓{repo.behind??0}</dd><dt>Working tree</dt><dd>{dirty?.clean?t('workingClean'):`${dirty?.modified??0} ${t('modifiedSuffix')}`}</dd></dl>
 {dirty&&!dirty.clean&&<ul className="files">{dirty.files.map(f=><li key={f}>{f}</li>)}</ul>}</>}
 </article>
 </section>

 <article><h2>{t('branches')}</h2>
 <div className="form"><input aria-label={t('newBranch')} value={branch} onChange={e=>setBranch(e.target.value)} placeholder="feat/my-change"/><input aria-label={t('sourceBranch')} value={source} onChange={e=>setSource(e.target.value)} placeholder="source (optional)"/><button disabled={mutating||!branch.trim()} onClick={()=>void run(`Created ${branch}`,async()=>{await rpc('createBranch',{name:branch.trim(),...(source.trim()?{sourceBranch:source.trim()}:{})});setBranch('');setSource('')})}>{t('createCheckout')}</button></div>
 {branchList.length===0?<EmptyState message={t('noBranches')}/>:
 <div className="list">{visibleBranches.map(b=><div className="item" key={b.name} tabIndex={0} role="button" aria-label={`Checkout ${b.name}`} onKeyDown={(e)=>{if(e.key==='Enter'&&!mutating&&!b.current)void doCheckout(b.name)}} onClick={()=>void doCheckout(b.name)}><div><strong>{b.current?'★ ':''}{b.name}</strong><small>{b.upstream||'no upstream'}</small></div><button disabled={mutating||b.current} onClick={(e)=>{e.stopPropagation();void doCheckout(b.name)}}>{t('checkout')}</button></div>)}
 {branchList.length>BRANCH_VISIBLE&&<button className="link" onClick={()=>setBranchesExpanded(!branchesExpanded)}>{branchesExpanded?t('showLess'):`${t('showAll')} (${branchList.length})`}</button>}</div>}
 </article>

 <article><h2>{t('workspaces')}</h2>
 <div className="form four"><input aria-label={t('workspaceName')} value={wsName} onChange={e=>setWsName(e.target.value)} placeholder="issue-123"/><input aria-label={t('workspaceBranch')} value={wsBranch} onChange={e=>setWsBranch(e.target.value)} placeholder="branch (optional)"/><input aria-label={t('workspaceSource')} value={wsSource} onChange={e=>setWsSource(e.target.value)} placeholder="source (optional)"/><button disabled={mutating||!wsName.trim()} onClick={()=>void run(`Workspace ${wsName} ready`,async()=>{await rpc('createWorkspace',{target:wsName.trim(),...(wsBranch.trim()?{branch:wsBranch.trim()}:{}),...(wsSource.trim()?{sourceBranch:wsSource.trim()}:{})});setWsName('');setWsBranch('');setWsSource('')})}>{t('createSwitch')}</button></div>
 <div className="list">{(s?.workspaces??[]).length===0?<EmptyState message={t('noWorkspaces')}/>:<>
 <div className="item"><div><strong>original</strong><small>{t('mainProjectWorkspace')}</small></div><button onClick={()=>void run('Switched to original',()=>rpc('switchWorkspace',{target:'original'}))}>{t('switch')}</button></div>
 {(s?.workspaces??[]).map(w=><div className="item" key={w.name}><div><strong>{w.name}</strong><small>{w.path||w.branch||''}{sessionCounts.get(w.name)?` · ${sessionCounts.get(w.name)} ${t('session')}(s)`:''}</small></div><div className="row"><button onClick={()=>void run(`Switched to ${w.name}`,()=>rpc('switchWorkspace',{target:w.name}))}>{t('switch')}</button><button className="danger" onClick={()=>void confirmDelete(w)}>{t('delete')}</button></div></div>)}

 </>}</div></article>

 <section className="grid">
 <article><h2>{t('remotes')}</h2>
 <div className="form two"><select aria-label={t('remote')} value={remote} onChange={e=>setRemote(e.target.value)}><option value="">{t('allRemotes')}</option>{(repo?.remotes??[]).map(r=><option key={r.name}>{r.name}</option>)}</select><button onClick={()=>void run(remote?`Fetched ${remote}`:'Fetched all remotes',()=>rpc('fetch',remote?{remote}:{}))}>{t('fetch')}</button></div>
 {(repo?.remotes??[]).length===0?<EmptyState message={t('noRemotes')}/>:
 <div className="list">{(repo?.remotes??[]).map(r=><div className="item" key={r.name}><div><strong>{r.name}</strong><small className="mono">{r.fetchUrl}{r.pushUrl&&r.pushUrl!==r.fetchUrl?` · push ${r.pushUrl}`:''}</small></div></div>)}</div>}
 </article>

 <article><h2>{t('projectSessions')}</h2>
 {(s?.sessions??[]).length===0?<EmptyState message={t('noSessions')}/>:
 <div className="list">{(s?.sessions??[]).slice(0,25).map(x=><div className="item" key={x.id}><div><strong>{x.title||x.id.slice(0,8)}</strong><small>{[x.workspace||'original',x.branch].filter(Boolean).join(' · ')}</small></div>{x.isRunning&&<span className="pill">running</span>}</div>)}</div>}
 </article>
 </section>

 {(s?.error)&&<div className="muted" role="alert">{s.error}</div>}

 <article><h2>{t('recentCommits')}</h2>
 {recentCommits.length===0?<EmptyState message={t('noCommits')}/>:
 <div className="list">{recentCommits.map(c=><div className="item" key={c.sha}><div><strong className="mono">{c.sha.slice(0,7)}</strong> <span>{c.subject}</span><small>{c.author} · {formatDate(c.date,lang)}</small></div></div>)}</div>}
 </article>

 {repo?.inProgress&&(repo.inProgress.merge||repo.inProgress.rebase||repo.inProgress.cherryPick||repo.inProgress.revert||repo.inProgress.bisect)&&(
 <article><h2>{t('inProgress')}</h2>
 <ul className="files">
 {repo.inProgress.merge&&<li>{t('inProgressMerge')}</li>}
 {repo.inProgress.rebase&&<li>{t('inProgressRebase')}</li>}
 {repo.inProgress.cherryPick&&<li>{t('inProgressCherryPick')}</li>}
 {repo.inProgress.revert&&<li>{t('inProgressRevert')}</li>}
 {repo.inProgress.bisect&&<li>{t('inProgressBisect')}</li>}
 </ul>
 </article>
 )}

 {repo?.branch&&(
 <article><h2>{t('dangerZone')}</h2>
 <div className="form two">
 <select aria-label={t('resetTarget')} id="reset-target" defaultValue="HEAD@{1}"><option>HEAD</option><option>HEAD@{1}</option><option>origin/main</option></select>
 <button className="danger" onClick={()=>{const target=(document.getElementById('reset-target') as HTMLSelectElement|null)?.value||'HEAD';setPendingReset({mode:'hard',target})}}>{t('resetHard')}</button>
 </div>
 </article>
 )}

 {toast&&<div role="status" aria-live="polite" className="toast">{toast}</div>}

 <Modal open={!!pendingCheckout} title={t('mergeConflict')} onCancel={()=>setPendingCheckout(null)} onConfirm={confirmCheckout} confirmLabel={t('forceCheckout')} confirmDanger cancelText={t('cancel')}>
  <p>{t('mergeConflictBody')} <strong>{pendingCheckout?.branch}</strong> {t('mergeConflictWarn')}</p>
  <p className="muted">{t('forceCheckoutHint')}</p>
 </Modal>

 <Modal open={!!pendingReset} title={t('resetDestructive')} onCancel={()=>setPendingReset(null)} onConfirm={async()=>{if(!pendingReset)return;const {mode,target}=pendingReset;setPendingReset(null);await run(`Reset ${mode} ${target}`,()=>rpc('reset',{mode,target}))}} confirmLabel={t('confirmReset')} confirmDanger cancelText={t('cancel')}>
  <p>{t('resetBody')} <strong>{pendingReset?.target}</strong> {t('resetModeLabel')} <strong>{pendingReset?.mode}</strong>?</p>
  <p className="muted">{pendingReset?.mode==='hard'?t('resetHardWarning'):pendingReset?.mode==='mixed'?t('resetMixedWarning'):t('resetSoftWarning')}</p>
 </Modal>

 <Modal open={!!pendingDelete&&!pendingDelete.force} title={t('deleteConfirm')} onCancel={()=>setPendingDelete(null)} onConfirm={performDelete} confirmLabel={t('confirm')} confirmDanger cancelText={t('cancel')}>
  <p>{t('deleteWorkspaceBody')} <strong>{pendingDelete?.workspace.name}</strong>?</p>
  <p className="muted">{t('deleteWorkspaceWarning')}</p>
 </Modal>

 <Modal open={!!pendingDelete?.force} title={t('forceDeleteTitle')} onCancel={()=>setPendingDelete(null)} onConfirm={escalateForce} confirmLabel={t('retryForce')} confirmDanger cancelText={t('cancel')}>
  <p>Workspace <strong>{pendingDelete?.workspace.name}</strong> {t('forceDeleteBody')}.</p>
  {pendingDelete?.conflictingSessionIds&&pendingDelete.conflictingSessionIds.length>0&&(
    <ul className="files">{pendingDelete.conflictingSessionIds.map(id=><li key={id} className="mono">{id}</li>)}</ul>
  )}
  {pendingDelete?.reason&&<p className="muted">{pendingDelete.reason}</p>}
 </Modal>
 </main>
}

if(document.getElementById('root'))createRoot(document.getElementById('root')!).render(<App/>)
