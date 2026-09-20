/**
 * Integration tests for src/git-state.js — run real `git` commands against a
 * throwaway repository. Skipped automatically when git is not installed.
 *
 * Run: `npm run test:state` or `npx vitest run`.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  isGitRepository,
  getCurrentBranch,
  getHeadSha,
  getWorkingTreeStatus,
  listRemotes,
  getAheadBehind,
  listBranches,
  observe,
} from '../src/git-state.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

let dir
let hasGit = true
let skipReason = ''

beforeAll(() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
  } catch (error) {
    hasGit = false
    skipReason = 'git is not installed'
    return
  }
  dir = mkdtempSync(join(tmpdir(), 'gwm-state-'))
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 'ci@example.com'])
  git(dir, ['config', 'user.name', 'CI'])
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-m', 'init'])
  // Set up a local "remote" we can fetch from. Use a bare clone.
  const bare = mkdtempSync(join(tmpdir(), 'gwm-remote-'))
  execFileSync('git', ['clone', '--bare', dir, bare], { stdio: 'ignore' })
  git(dir, ['remote', 'add', 'origin', bare])
  git(dir, ['fetch', 'origin'])
  git(dir, ['branch', '--set-upstream-to=origin/main', 'main'])
})

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const skipIfNoGit = hasGit ? it : it.skip

describe('isGitRepository', () => {
  skipIfNoGit('returns true inside a repo', async () => {
    expect(await isGitRepository(dir)).toBe(true)
  })

  it('returns false outside a repo', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'gwm-empty-'))
    try {
      expect(await isGitRepository(empty)).toBe(false)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('getCurrentBranch / getHeadSha', () => {
  skipIfNoGit('returns the branch name', async () => {
    expect(await getCurrentBranch(dir)).toBe('main')
  })

  skipIfNoGit('returns a short SHA', async () => {
    const sha = await getHeadSha(dir)
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/)
  })
})

describe('getWorkingTreeStatus', () => {
  skipIfNoGit('reports clean', async () => {
    const status = await getWorkingTreeStatus(dir)
    expect(status.ok).toBe(true)
    expect(status.value.clean).toBe(true)
    expect(status.value.modified).toBe(0)
  })

  skipIfNoGit('reports modified + untracked', async () => {
    writeFileSync(join(dir, 'README.md'), 'changed\n')
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    const status = await getWorkingTreeStatus(dir)
    expect(status.ok).toBe(true)
    expect(status.value.clean).toBe(false)
    expect(status.value.modified).toBeGreaterThanOrEqual(2)
    expect(status.value.files).toEqual(expect.arrayContaining(['README.md', 'new.txt']))
    // Clean up so subsequent tests see a clean tree.
    git(dir, ['checkout', '--', 'README.md'])
    rmSync(join(dir, 'new.txt'))
  })
})

describe('listRemotes / getAheadBehind', () => {
  skipIfNoGit('lists the origin remote', async () => {
    const result = await listRemotes(dir)
    expect(result.ok).toBe(true)
    expect(result.value).toEqual([
      expect.objectContaining({ name: 'origin', fetchUrl: expect.any(String) }),
    ])
  })

  skipIfNoGit('reports 0/0 ahead/behind initially', async () => {
    const ab = await getAheadBehind(dir)
    expect(ab).toEqual({ ahead: 0, behind: 0 })
  })
})

describe('listBranches', () => {
  skipIfNoGit('returns at least main', async () => {
    const result = await listBranches(dir)
    expect(result.ok).toBe(true)
    const main = result.value.find((b) => b.name === 'main')
    expect(main).toBeDefined()
    expect(main.current).toBe(true)
    expect(main.upstream).toBe('origin/main')
  })
})

describe('observe', () => {
  skipIfNoGit('returns the full payload', async () => {
    const result = await observe(dir)
    expect(result.ok).toBe(true)
    expect(result.value.isRepository).toBe(true)
    expect(result.value.branch).toBe('main')
    expect(result.value.upstream).toBe('origin/main')
    expect(result.value.ahead).toBe(0)
    expect(result.value.behind).toBe(0)
    expect(result.value.dirty.clean).toBe(true)
    expect(result.value.remotes.length).toBeGreaterThan(0)
    expect(Array.isArray(result.value.branches)).toBe(true)
  })
})
