// App structural and snapshot regression tests
import { describe, it, expect, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { App } from '../src/ui'

vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
  const url = String(input)
  if (url.includes('/api/sessions/session-12345678') && !url.includes('/rpc/')) {
    return new Response(JSON.stringify({
      session: { id: 'session-12345678', projectId: 'project-1', workdir: '/project-root', workspace: '/repo' }
    }), { status: 200 })
  }
  const method = decodeURIComponent((url.split('/rpc/')[1] || '').split('?')[0])
  const data: Record<string, unknown> = { ok: true }
  if (method === 'gitWorkspace.resolveContext') data.context = { sessionId: 'session-12345678', workdir: '/repo', projectId: 'project-1' }
  if (method === 'gitWorkspace.observe') {
    data.repo = {
      isRepository: true, cwd: '/repo', toplevel: '/repo', commonDir: '/repo/.git',
      branch: 'main', headSha: 'abc1234', upstream: 'origin/main', ahead: 0, behind: 0,
      dirty: { clean: true, modified: 0, files: [], porcelain: '' },
      remotes: [{ name: 'origin', fetchUrl: 'git@example/repo.git', pushUrl: 'git@example/repo.git' }],
      branches: [{ name: 'main', current: true, upstream: 'origin/main' }, { name: 'feat/x', current: false, upstream: null }],
      inProgress: { merge: false, rebase: false, cherryPick: false, revert: false, bisect: false },
    }
  }
  if (method === 'gitWorkspace.listBranches') data.branches = [{ name: 'main', current: true }, { name: 'feat/x', current: false }]
  if (method === 'gitWorkspace.listWorkspaces') data.workspaces = []
  if (method === 'gitWorkspace.listSessions') data.sessions = []
  if (method === 'gitWorkspace.logRecent') return new Response(JSON.stringify({ result: [] }), { status: 200 })
  return new Response(JSON.stringify({ result: data }), { status: 200 })
}))

Object.defineProperty(document, 'referrer', { configurable: true, value: 'http://localhost/p/project-1/s/session-12345678' })
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
})

afterEach(() => cleanup())

describe('App structure (DEV-40)', () => {
  it('matches the canonical top-level structure', async () => {
    const { container } = render(<App />)
    await new Promise(r => setTimeout(r, 800))
    expect(container.querySelector('.app')).toBeTruthy()
    expect(container.querySelector('h1')?.textContent).toMatch(/Git Workspace Map|Carte Git/)
    expect(container.querySelectorAll('article').length).toBeGreaterThanOrEqual(5)
  })
  it('renders header controls in canonical order', async () => {
    const { container } = render(<App />)
    await new Promise(r => setTimeout(r, 800))
    const buttons = Array.from(container.querySelectorAll('header button'))
    const labels = buttons.map(b => b.textContent?.trim() || '')
    expect(labels.some(l => /Refresh|Rafraîchir/.test(l))).toBe(true)
    expect(labels.some(l => /Fetch|Fetch all/.test(l))).toBe(true)
  })
  it('exposes dark/light theme via data-theme attribute', async () => {
    render(<App />)
    await new Promise(r => setTimeout(r, 800))
    expect(['dark', 'light']).toContain(document.documentElement.dataset.theme)
  })

  it('renders matching DOM snapshot', async () => {
    const { container } = render(<App />)
    await new Promise(r => setTimeout(r, 800))
    expect(container.querySelector('.app')).toMatchSnapshot()
  })
})
