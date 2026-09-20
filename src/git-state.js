/**
 * Git state observer.
 *
 * Read-only side of the plugin. This module never mutates the repository's
 * branch / workspace layout directly; mutations (branch / workspace creation,
 * switching, deletion) are routed through the OpenFox REST API so the host can
 * keep its session and workspace bookkeeping in sync.
 *
 * Design constraints:
 *   - execFile only (no shell), so user-controlled refs cannot inject flags.
 *   - Every external call is bounded by a timeout.
 *   - Errors are returned as { ok: false, error }, never thrown to the host.
 *   - Inputs that originate from user input are validated before being passed
 *     to git, but only as defensive checks — git itself rejects bad refs.
 */

import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

/** Default timeout (ms) for a single git invocation. */
const DEFAULT_TIMEOUT = 15_000

/** Validate a ref name (branch, remote name, workspace name). */
function safeRef(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  // Allow common ref characters; reject shell metacharacters defensively.
  if (!/^[A-Za-z0-9._\-\/]+$/.test(value)) {
    throw new Error(`${label} contains invalid characters: ${value}`)
  }
  if (value.includes('..') || value.startsWith('-')) {
    throw new Error(`${label} is not a safe git ref: ${value}`)
  }
  return value
}

/** Run a git command in a given working directory and return trimmed stdout. */
async function runGit(cwd, args, { timeout = DEFAULT_TIMEOUT } = {}) {
  const result = await execFile('git', args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 })
  return result.stdout.trimEnd()
}

/** Same as runGit but ignores exit code (use for "best effort" calls). */
async function runGitAllowFailure(cwd, args, { timeout = DEFAULT_TIMEOUT } = {}) {
  try {
    return { ok: true, ...(await runGit(cwd, args, { timeout })) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** A small result wrapper so callers can rely on a stable shape. */
function ok(value) {
  return { ok: true, value }
}
function fail(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

/**
 * Return true if `cwd` is inside a git working tree.
 * @param {string} cwd
 * @returns {Promise<boolean>}
 */
export async function isGitRepository(cwd) {
  if (!cwd) return false
  try {
    await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}

/**
 * @typedef {Object} RepoIdentity
 * @property {string|null} toplevel
 * @property {string|null} commonDir
 * @property {string} branch
 * @property {string|null} upstream
 * @property {string|null} remote
 */

/**
 * Return the absolute path of the repo toplevel.
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function getToplevel(cwd) {
  try {
    const value = await runGit(cwd, ['rev-parse', '--show-toplevel'])
    return value || null
  } catch {
    return null
  }
}

/**
 * Return the absolute path of the git common directory (where `.git/...` lives
 * for worktrees, or the repo itself). This is the anchor for "upstream" in
 * OpenFox's workspace model.
 */
export async function getCommonDir(cwd) {
  try {
    const value = await runGit(cwd, ['rev-parse', '--git-common-dir'])
    return value ? value : null
  } catch {
    return null
  }
}

/**
 * Return the current short branch name, or `null` if HEAD is detached.
 */
export async function getCurrentBranch(cwd) {
  try {
    const symbolic = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    return symbolic || null
  } catch {
    return null
  }
}

/**
 * Return the abbreviated commit hash at HEAD.
 */
export async function getHeadSha(cwd) {
  try {
    return await runGit(cwd, ['rev-parse', '--short', 'HEAD'])
  } catch {
    return null
  }
}

/**
 * Return the upstream branch (e.g. `origin/main`) configured for the current
 * branch, or null when no upstream is set.
 */
export async function getUpstream(cwd) {
  const branch = await getCurrentBranch(cwd)
  if (!branch) return null
  try {
    const upstream = await runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    return upstream || null
  } catch {
    return null
  }
}

/**
 * @typedef {Object} WorkingTreeStatus
 * @property {boolean} clean       true when there are no unstaged, staged, or untracked changes
 * @property {number} modified     number of modified files (staged + unstaged)
 * @property {string[]} files      paths that differ from HEAD/HEAD/index, plus untracked
 * @property {string|null} porcelain short porcelain status for tooltips
 */

/**
 * Compute the working tree status using `git status --porcelain`.
 * Untracked files are included but only if the caller has not disabled them
 * with `includeUntracked=false`.
 */
export async function getWorkingTreeStatus(cwd, { includeUntracked = true } = {}) {
  try {
    const args = ['status', '--porcelain', '--untracked-files=' + (includeUntracked ? 'all' : 'no')]
    const porcelain = await runGit(cwd, args)
    const lines = porcelain.split('\n').filter((line) => line.length > 0)
    return ok({
      clean: lines.length === 0,
      modified: lines.length,
      files: lines.map((line) => line.slice(3)),
      porcelain,
    })
  } catch (error) {
    return fail(error)
  }
}

/**
 * @typedef {Object} RemoteInfo
 * @property {string} name
 * @property {string} fetchUrl
 * @property {string} pushUrl
 */

/**
 * Return the list of remotes and their fetch/push URLs.
 */
export async function listRemotes(cwd) {
  try {
    const output = await runGit(cwd, ['remote', '-v'])
    /** @type {Map<string, {name:string, fetchUrl?:string, pushUrl?:string}>} */
    const map = new Map()
    for (const line of output.split('\n')) {
      if (!line) continue
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
      if (!match) continue
      const [, name, url, kind] = match
      const entry = map.get(name) ?? { name }
      if (kind === 'fetch') entry.fetchUrl = url
      if (kind === 'push') entry.pushUrl = url
      map.set(name, entry)
    }
    return ok([...map.values()])
  } catch (error) {
    return fail(error)
  }
}

/**
 * @typedef {Object} AheadBehind
 * @property {number} ahead
 * @property {number} behind
 */

/**
 * Return the ahead/behind counts between HEAD and its upstream. Returns
 * `{ ahead: 0, behind: 0 }` when no upstream is configured.
 */
export async function getAheadBehind(cwd) {
  const upstream = await getUpstream(cwd)
  if (!upstream) return { ahead: 0, behind: 0 }
  try {
    const output = await runGit(cwd, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`])
    const [left, right] = output.split(/\s+/).map((n) => Number(n))
    return { ahead: left || 0, behind: right || 0 }
  } catch {
    return { ahead: 0, behind: 0 }
  }
}

/**
 * @typedef {Object} BranchInfo
 * @property {string} name
 * @property {string} sha
 * @property {string|null} upstream
 * @property {boolean} current
 */

/**
 * Return the list of local branches with HEAD info. Uses `for-each-ref` for
 * cheap parsing.
 */
export async function listBranches(cwd) {
  try {
    const format = ['%(HEAD)', '%(refname:short)', '%(objectname:short)', '%(upstream:short)'].join('%00')
    const output = await runGit(cwd, ['for-each-ref', `--format=${format}`, 'refs/heads'])
    /** @type {BranchInfo[]} */
    const branches = []
    for (const line of output.split('\n')) {
      if (!line) continue
      const [head, name, sha, upstream] = line.split('\0')
      if (!name) continue
      branches.push({
        name,
        sha: sha || '',
        upstream: upstream || null,
        current: head === '*',
      })
    }
    return ok(branches)
  } catch (error) {
    return fail(error)
  }
}

/**
 * Run `git fetch <remote>` (or all remotes) and report the outcome.
 *
 * Mutation note: fetch is observation-friendly because it does not change any
 * local branch state, only the remote-tracking refs. The OpenFox REST API does
 * not expose fetch, so we run git directly here.
 *
 * @param {string} cwd
 * @param {string|null} remoteName
 */
export async function fetch(cwd, remoteName) {
  if (!cwd) return fail(new Error('cwd is required'))
  if (remoteName) {
    safeRef(remoteName, 'remote')
    const result = await runGitAllowFailure(cwd, ['fetch', '--prune', remoteName])
    return result.ok ? ok({ remote: remoteName }) : fail(new Error(result.error))
  }
  const result = await runGitAllowFailure(cwd, ['fetch', '--all', '--prune'])
  return result.ok ? ok({ remote: '*' }) : fail(new Error(result.error))
}

/**
 * Build the observation payload used by both the panel RPC and the badge RPC.
 *
 * @param {string} cwd
 * @returns {Promise<object>}
 */
export async function observe(cwd) {
  if (!cwd) {
    return { ok: false, error: 'cwd is required' }
  }
  const inside = await isGitRepository(cwd)
  if (!inside) {
    return { ok: true, value: { isRepository: false, cwd } }
  }
  const toplevel = await getToplevel(cwd)
  const commonDir = await getCommonDir(cwd)
  const branch = await getCurrentBranch(cwd)
  const upstream = await getUpstream(cwd)
  const headSha = await getHeadSha(cwd)
  const dirtyResult = await getWorkingTreeStatus(cwd)
  const dirty = dirtyResult.ok
    ? dirtyResult.value
    : { clean: true, modified: 0, files: [], porcelain: '', _error: dirtyResult.error }
  const aheadBehind = await getAheadBehind(cwd)
  const remotesResult = await listRemotes(cwd)
  const remotes = remotesResult.ok ? remotesResult.value : []
  const branchesResult = await listBranches(cwd)
  const branches = branchesResult.ok ? branchesResult.value : []

  return {
    ok: true,
    value: {
      isRepository: true,
      cwd,
      toplevel,
      commonDir,
      branch,
      headSha,
      upstream,
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
      dirty,
      remotes,
      branches,
    },
  }
}
