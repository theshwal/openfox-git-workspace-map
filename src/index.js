/**
 * openfox-git-workspace-map — Plugin source.
 *
 * Implements the OpenFox Plugin API v2 (peerDep openfox >= 2.0.151) as
 * pure ESM JavaScript with JSDoc annotations. No build step is required; the
 * plugin host loads `src/index.js` directly through `import()`.
 *
 * Contribution surface:
 *   - Tool: git_workspace_inspect   — read-only inspection callable by the agent
 *   - Badge: "git"  → session.header.badges, sourced via RPC `badge`
 *   - Action: "git-map-open"  → session.header.actions, opens the iframe panel
 *   - Panel: "git-workspace"  → iframe (assets/git-workspace.html)
 *   - RPCs: badge, observe, fetch, listBranches, createBranch, checkoutBranch,
 *           listWorkspaces, listSessions, switchWorkspace, deleteWorkspace,
 *           resolveContext
 *   - Hooks: turn.completed, session.created, message.created
 *
 * Context resolution (no core patch):
 *   The badge slot `session.header.badges` is the only slot for which the
 *   OpenFox host injects the active sessionId/workdir/projectId into the RPC
 *   call. Every render, we mirror that context into the plugin storage under a
 *   stable key so any subsequent iframe RPC can resolve the "active" context.
 *   The iframe itself never needs a patched host: it calls
 *   `resolveContext` and the host returns the latest cached entry, or falls
 *   back to the workdir provided by the host process if none is cached yet.
 *
 * Branch and workspace mutations always go through OpenFox REST endpoints so
 * the host can update its session/workspace bookkeeping. We never run
 * `git checkout -b` or `git worktree` directly.
 */

import { observe as gitObserve, fetch as gitFetch } from './git-state.js'

/* ------------------------------------------------------------------ */
/* Plugin context plumbing                                            */
/* ------------------------------------------------------------------ */

/**
 * Storage keys used by the badge RPC to mirror the active session/workdir
 * into a place the iframe RPCs can reach.
 */
const STORAGE_LAST_CONTEXT = 'lastActiveContext'
const STORAGE_LAST_BRANCH = 'lastActiveBranch'

const PLUGIN_ID = 'openfox-git-workspace-map'

/**
 * Try to read the host address. When running outside OpenFox (e.g. in unit
 * tests) `OPENFOX_HOST` defaults to `http://127.0.0.1:10369`.
 */
function getHostBase() {
  return process.env['OPENFOX_HOST'] || 'http://127.0.0.1:10369'
}

/**
 * Read the session token from the well-known Hermes env var. The host will
 * inject this into the RPC context when the iframe calls our RPCs.
 */
function getSessionToken() {
  return process.env['OPENFOX_SESSION_TOKEN'] || ''
}

/**
 * Outbound HTTP helper used by the iframe-facing RPCs. Uses Node's global
 * `fetch` (available in Node 18+). The token is sent as `x-session-token`
 * (header) AND as `?token=` query parameter, because the iframe sandbox cannot
 * set headers and the plugin asset endpoint only accepts query tokens.
 */
async function httpJSON(path, { method = 'GET', body, token } = {}) {
  const headers = { Accept: 'application/json' }
  if (body) headers['Content-Type'] = 'application/json'
  if (token) headers['x-session-token'] = token
  const url = new URL(path, getHostBase())
  if (token) url.searchParams.set('token', token)
  const res = await fetch(url, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers,
  })
  const text = await res.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch (error) {
    throw new Error(`Non-JSON response from ${path}: ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const message = parsed && typeof parsed === 'object' && 'error' in parsed ? parsed.error : `HTTP ${res.status}`
    throw new Error(message)
  }
  return parsed
}

/* ------------------------------------------------------------------ */
/* Context resolution                                                 */
/* ------------------------------------------------------------------ */

/**
 * Read the last-known session context that the badge RPC mirrored into
 * storage. Returns null when nothing has been mirrored yet.
 */
function readLastContext(storage) {
  const raw = storage.get(STORAGE_LAST_CONTEXT)
  if (!raw || typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    /* ignore corrupted cache */
  }
  return null
}

/**
 * Save (or replace) the cached active context. We store as JSON because the
 * storage only accepts scalar values (string|number|boolean) per the API.
 */
function writeLastContext(storage, value) {
  try {
    storage.set(STORAGE_LAST_CONTEXT, JSON.stringify(value))
  } catch (error) {
    /* storage may be read-only in tests; non-fatal */
  }
}

/**
 * Resolve the context an RPC handler should use, given the live RPC context
 * and the cached "active" context from the badge.
 *
 * Resolution order:
 *   1. The live RPC context (passed in by the host) wins if it has a sessionId
 *      or workdir.
 *   2. Otherwise fall back to the cached context from the badge.
 *   3. Otherwise use process.cwd() as a last resort.
 */
function resolveContext(rpcContext, storage) {
  const live = rpcContext || {}
  const cached = readLastContext(storage) || {}
  const sessionId = live.sessionId || cached.sessionId || ''
  const workdir = live.workdir || cached.workdir || process.cwd()
  const projectId = live.projectId || cached.projectId || undefined
  return { sessionId, workdir, ...(projectId ? { projectId } : {}) }
}

/* ------------------------------------------------------------------ */
/* REST helpers for branch / workspace mutations                       */
/* ------------------------------------------------------------------ */

/**
 * Switch the given session to a (possibly new) workspace. We rely on
 * `POST /api/sessions/:id/switch-workspace` which is the same endpoint the
 * host uses for its own UI: this guarantees the session tree, branch and
 * workdir stay in sync.
 */
async function callSwitchWorkspace({ sessionId, target, branch, sourceBranch, token }) {
  return httpJSON(`/api/sessions/${encodeURIComponent(sessionId)}/switch-workspace`, {
    method: 'POST',
    body: { target, ...(branch ? { branch } : {}), ...(sourceBranch ? { sourceBranch } : {}) },
    token,
  })
}

/**
 * Delete a workspace via the host-managed REST endpoint. Force-delete is
 * exposed because the panel confirms in the UI before issuing the call.
 */
async function callDeleteWorkspace({ sessionId, target, force, token }) {
  return httpJSON(`/api/sessions/${encodeURIComponent(sessionId)}/delete-workspace`, {
    method: 'POST',
    body: { target, force: force === true },
    token,
  })
}

/**
 * Checkout a branch in the session's effective workdir.
 */
async function callCheckout({ sessionId, branch, token }) {
  return httpJSON(`/api/sessions/${encodeURIComponent(sessionId)}/checkout`, {
    method: 'POST',
    body: { branch },
    token,
  })
}

/**
 * Create a brand new branch anchored at the session's effective workdir.
 */
async function callCheckoutNew({ projectId, name, sourceBranch, token }) {
  return httpJSON(`/api/projects/${encodeURIComponent(projectId)}/checkout-new`, {
    method: 'POST',
    body: { name, ...(sourceBranch ? { sourceBranch } : {}), },
    token,
  })
}

async function callListBranches({ sessionId, token }) {
  return httpJSON(`/api/sessions/${encodeURIComponent(sessionId)}/branches`, { token })
}

async function callListWorkspaces({ projectId, token }) {
  return httpJSON(`/api/projects/${encodeURIComponent(projectId)}/workspaces`, { token })
}

async function callListSessions({ token }) {
  return httpJSON('/api/sessions/home', { token })
}

/**
 * Internal: switch or create-and-switch a workspace. Shared by the public
 * `switchWorkspace` and `createWorkspace` RPCs. Exposed at top level so the
 * handler functions (also at top level) can call it without a closure dance.
 */
async function doSwitchWorkspace(params, rpcContext, storageRef) {
  const ctx = resolveContext(rpcContext, storageRef)
  if (!ctx.sessionId) throw new Error('No active session.')
  if (!params || typeof params.target !== 'string' || params.target.length === 0) {
    throw new Error('Workspace target is required.')
  }
  const result = await callSwitchWorkspace({
    sessionId: ctx.sessionId,
    target: params.target,
    ...(typeof params.branch === 'string' ? { branch: params.branch } : {}),
    ...(typeof params.sourceBranch === 'string' ? { sourceBranch: params.sourceBranch } : {}),
    token: getSessionToken(),
  })
  return result
}

/* ------------------------------------------------------------------ */
/* RPC handlers                                                       */
/* ------------------------------------------------------------------ */

const rpcHandlers = {
  /**
   * Badge feed. Called by the host whenever the session header re-renders.
   * We return a tiny human-readable summary (`main ✓`, `feat/x ↑1↓0 ±3`).
   */
  async badge(params, rpcContext, storage) {
    const ctx = resolveContext(rpcContext, storage)
    if (!ctx.workdir) return ''
    const observation = await gitObserve(ctx.workdir)
    if (!observation.ok) return '?'
    const repo = observation.value
    if (!repo.isRepository) return 'no-git'
    if (!repo.branch) return 'detached'
    const aheadBehind = formatAheadBehind(repo.ahead, repo.behind)
    return `${repo.branch}${repo.dirty.modified ? ` ±${repo.dirty.modified}` : ''}${aheadBehind}`
  },

  /**
   * Full observation payload for the iframe panel.
   */
  async observe(params, rpcContext, storage) {
    const ctx = resolveContext(rpcContext, storage)
    const observation = await gitObserve(ctx.workdir)
    if (!observation.ok) {
      return { ok: false, error: observation.error, context: ctx }
    }
    return { ok: true, context: ctx, repo: observation.value }
  },

  /**
   * Resolve the active session/workdir context for the iframe. Used when the
   * panel renders before the badge has had a chance to populate the cache.
   */
  async resolveContext(params, rpcContext, storage) {
    const ctx = resolveContext(rpcContext, storage)
    return ctx
  },

  /**
   * Run `git fetch --all --prune` (or for a single remote when `remote` is
   * provided). Returns the result string the panel renders in the toast.
   */
  async fetch(params, rpcContext, storage) {
    const ctx = resolveContext(rpcContext, storage)
    const remote = typeof params?.remote === 'string' && params.remote.length > 0 ? params.remote : null
    const result = await gitFetch(ctx.workdir, remote)
    if (!result.ok) {
      throw new Error(result.error)
    }
    return { ok: true, remote: result.value.remote }
  },

  /**
   * List branches for the active session. Uses the REST endpoint so the
   * host has the canonical view (including its workspace bookkeeping).
   */
  async listBranches(params, rpcContext, storage) {
    const ctx = resolveContext(rpcContext, storage)
    if (!ctx.sessionId) {
      throw new Error('No active session — open a session to list its branches.')
    }
    const result = await callListBranches({ sessionId: ctx.sessionId, token: getSessionToken() })
    return result
  },

  /**
   * Create and switch to a new branch in the session's effective workdir.
   * `sourceBranch` is optional — defaults to the upstream default.
   */
  async createBranch(params, rpcContext, storage) {
    const ctx = resolveContext(rpcContext, storage)
    if (!ctx.sessionId) throw new Error('No active session.')
    if (!params || typeof params.name !== 'string' || params.name.length === 0) {
      throw new Error('Branch name is required.')
    }
    const result = await callCheckout({
      sessionId: ctx.sessionId,
      branch: params.name,
      token: getSessionToken(),
    })
    if (result && typeof result === 'object' && 'error' in result) {
      throw new Error(result.error)
    }
    return { ok: true, branch: params.name }
  },

  /**
   * Create a brand new branch in the project's main workdir (does not switch
   * the session's effective workdir). Used by the panel to fork a branch off
   * the main upstream.
   */
  async checkoutNew(params, rpcContext, storage) {
    const ctx = resolveContext(rpcContext, storage)
    if (!ctx.projectId) throw new Error('No project context.')
    if (!params || typeof params.name !== 'string' || params.name.length === 0) {
      throw new Error('Branch name is required.')
    }
    const result = await callCheckoutNew({
      projectId: ctx.projectId,
      name: params.name,
      ...(typeof params.sourceBranch === 'string' ? { sourceBranch: params.sourceBranch } : {}),
      token: getSessionToken(),
    })
    return result
  },

  /**
   * Switch the session's effective workdir to an existing branch (in-place).
   * If `target` is provided, delegates to switchWorkspace so we cover both
   * "checkout a branch" and "switch to a named workspace".
   */
  async checkoutBranch(params, rpcContext, storage) {
    const ctx = resolveContext(rpcContext, storage)
    if (!ctx.sessionId) throw new Error('No active session.')
    if (!params || typeof params.branch !== 'string' || params.branch.length === 0) {
      throw new Error('Branch name is required.')
    }
    const result = await callCheckout({ sessionId: ctx.sessionId, branch: params.branch, token: getSessionToken() })
    return result
  },

  /**
   * Switch the session to a workspace. If `target` does not exist yet, the
   * host will create it (that's the documented behaviour of the endpoint).
   */
  async switchWorkspace(params, rpcContext, storage) {
    return doSwitchWorkspace(params, rpcContext, storage)
  },

  /**
   * Convenience: create AND switch in one call (same semantics as
   * switchWorkspace with a non-existent target).
   */
  async createWorkspace(params, rpcContext, storage) {
    return doSwitchWorkspace({ ...(params || {}), target: params?.target }, rpcContext, storage)
  },

  /**
   * Delete a workspace. The host returns HTTP 409 with conflictingSessionIds
   * if any session is still using it; we surface that so the UI can prompt
   * the user to retry with `force: true`.
   */
  async deleteWorkspace(params, rpcContext, storage) {
    const ctx = resolveContext(rpcContext, storage)
    if (!ctx.sessionId) throw new Error('No active session.')
    if (!params || typeof params.target !== 'string' || params.target.length === 0) {
      throw new Error('Workspace target is required.')
    }
    try {
      const result = await callDeleteWorkspace({
        sessionId: ctx.sessionId,
        target: params.target,
        force: params.force === true,
        token: getSessionToken(),
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message, retryWithForce: /in use/i.test(message) }
    }
  },

  /**
   * List all workspaces for the active project.
   */
  async listWorkspaces(params, rpcContext, storage) {
    const ctx = resolveContext(rpcContext, storage)
    if (!ctx.projectId) throw new Error('No project context.')
    const result = await callListWorkspaces({ projectId: ctx.projectId, token: getSessionToken() })
    return result
  },

  /**
   * List all sessions known to the host (used by the panel to show which
   * sessions share a workspace, surfacing the "WorkspaceInUse" conflict).
   */
  async listSessions(params, _rpcContext, _storage) {
    const result = await callListSessions({ token: getSessionToken() })
    return result
  },
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatAheadBehind(ahead, behind) {
  const parts = []
  if (ahead > 0) parts.push(`↑${ahead}`)
  if (behind > 0) parts.push(`↓${behind}`)
  return parts.length > 0 ? ` ${parts.join('')}` : ''
}

/* ------------------------------------------------------------------ */
/* Plugin entry point                                                 */
/* ------------------------------------------------------------------ */

/**
 * @param {import('openfox/plugin').PluginRegistry} registry
 */
export function register(registry) {
  const { context } = registry

  // Mirror the active context from the badge slot into plugin storage so the
  // iframe panel can resolve the same context without a core patch.
  const mirrorContext = (rpcContext) => {
    if (!rpcContext) return
    const { sessionId, workdir, projectId } = rpcContext
    if (!sessionId && !workdir) return
    writeLastContext(context.storage, {
      ...(sessionId ? { sessionId } : {}),
      ...(workdir ? { workdir } : {}),
      ...(projectId ? { projectId } : {}),
      timestamp: new Date().toISOString(),
    })
  }

  // Wrap each RPC handler so the context mirror runs first. We capture
  // `storage` in the closure so the wrapper is callable without a bound
  // `this` (the host calls the registered function as a plain function).
  /** @type {Record<string, (params:any, ctx:any) => Promise<unknown>>} */
  const boundHandlers = {}
  const storage = context.storage
  for (const [name, handler] of Object.entries(rpcHandlers)) {
    boundHandlers[name] = async function (params, rpcContext) {
      mirrorContext(rpcContext)
      return handler(params, rpcContext, storage)
    }
  }

  // ---- Tool -----------------------------------------------------------
  registry.registerTool({
    name: 'git_workspace_inspect',
    description:
      'Read-only git workspace inspection. Returns the current branch, upstream, ahead/behind counts, dirty status and modified files for the active session workdir.',
    parameters: {
      type: 'object',
      properties: {
        includeFiles: {
          type: 'boolean',
          description: 'Include the list of modified file paths (default: false).',
        },
      },
    },
    async execute(args, toolContext) {
      const observation = await gitObserve(toolContext.workdir || process.cwd())
      if (!observation.ok) {
        return { success: false, error: observation.error }
      }
      const repo = observation.value
      if (!repo.isRepository) {
        return { success: true, output: 'Not a git repository.' }
      }
      const lines = [
        `Branch: ${repo.branch ?? '(detached)'}${repo.upstream ? ` → ${repo.upstream}` : ''}`,
        `Upstream: ${repo.upstream || '(none configured)'}`,
        `HEAD: ${repo.headSha}`,
        `Toplevel: ${repo.toplevel}`,
        repo.commonDir && repo.commonDir !== repo.toplevel ? `Common dir: ${repo.commonDir}` : null,
        `Ahead/behind: ↑${repo.ahead} ↓${repo.behind}`,
        `Working tree: ${repo.dirty.clean ? 'clean' : `${repo.dirty.modified} modified file(s)`}`,
        `Remotes: ${repo.remotes.map((r) => `${r.name}→${r.fetchUrl || ''}`).join(', ') || '(none)'}`,
      ].filter(Boolean)
      if (args && args.includeFiles === true && !repo.dirty.clean) {
        lines.push(`Files: ${repo.dirty.files.join(', ')}`)
      }
      return { success: true, output: lines.join('\n') }
    },
  })

  // ---- Settings (none required, but exposing an empty schema is fine) -
  // Skipped: zero fields is not a valid schema in some hosts.

  // ---- UI: action + badge + panel ------------------------------------
  registry.registerUiAction({
    id: 'git-map-open',
    slot: 'session.header.actions',
    label: { en: 'Git Workspace Map', fr: 'Carte Git / Workspaces' },
    icon: 'git-branch',
    tooltip: {
      en: 'Open the Git Workspace Map panel (branches, remotes, workspaces).',
      fr: 'Ouvrir le panneau Carte Git / Workspaces (branches, remotes, workspaces).',
    },
    visibleWhen: { hasSession: true },
    onActivate: { kind: 'openPanel', panelId: 'git-workspace' },
  })

  registry.registerUiBadge({
    id: 'git-map-badge',
    slot: 'session.header.badges',
    label: { en: 'git', fr: 'git' },
    tooltip: {
      en: 'Active git branch, dirty state, ahead/behind vs upstream.',
      fr: 'Branche git active, état du working tree, avance/retard vs upstream.',
    },
    tone: 'info',
    visibleWhen: { hasSession: true },
    source: { kind: 'rpc', method: 'badge' },
  })

  registry.registerUiPanel({
    id: 'git-workspace',
    title: { en: 'Git Workspace Map', fr: 'Carte Git / Workspaces' },
    size: 'lg',
    kind: 'iframe',
    url: 'git-workspace.html',
  })

  // ---- RPCs -----------------------------------------------------------
  for (const [method, handler] of Object.entries(boundHandlers)) {
    registry.registerRpc(method, handler)
  }

  // ---- Asset ----------------------------------------------------------
  registry.registerAsset('git-workspace.html')

  // ---- Hooks (telemetry) ----------------------------------------------
  registry.registerHook('session.created', (payload) => {
    mirrorContext({ sessionId: payload.sessionId, projectId: payload.projectId, workdir: undefined })
    context.logger.debug('git-workspace-map: session.created', { sessionId: payload.sessionId })
  })

  registry.registerHook('turn.completed', () => {
    /* noop; reserved for future auto-refresh */
  })
}

// Re-export helpers so unit tests can exercise them without going through the
// host machinery.
export { resolveContext, readLastContext, writeLastContext }
export const __INTERNAL__ = {
  PLUGIN_ID,
  STORAGE_LAST_CONTEXT,
  STORAGE_LAST_BRANCH,
}
