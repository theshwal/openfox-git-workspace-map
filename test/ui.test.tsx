import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/ui'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Object.defineProperty(document, 'referrer', { configurable: true, value: '' })
})

const context = { sessionId: 'session-12345678', workdir: '/repo', projectId: 'project-1' }
const repo = {
  isRepository: true,
  cwd: '/repo',
  toplevel: '/repo',
  commonDir: '/repo/.git',
  branch: 'main',
  headSha: 'abc1234',
  upstream: 'origin/main',
  ahead: 1,
  behind: 0,
  dirty: { clean: false, modified: 1, files: ['src/a.ts'], porcelain: ' M src/a.ts' },
  remotes: [{ name: 'origin', fetchUrl: 'git@example/repo.git', pushUrl: 'git@example/repo.git' }],
  branches: [
    { name: 'main', current: true, upstream: 'origin/main' },
    { name: 'feat/x', current: false, upstream: null }
  ]
}

function installRpcMock() {
  const calls: Array<{ method: string; params: Record<string, unknown>; context?: Record<string, unknown> }> = []
  Object.defineProperty(document, 'referrer', {
    configurable: true,
    value: 'http://localhost/p/project-1/s/session-12345678'
  })
  vi.stubGlobal('confirm', vi.fn(() => true))
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/sessions/session-12345678') && !url.includes('/rpc/')) {
      return new Response(JSON.stringify({
        session: {
          id: 'session-12345678',
          projectId: 'project-1',
          workdir: '/project-root',
          workspace: '/repo'
        }
      }), { status: 200 })
    }
    const method = decodeURIComponent((url.split('/rpc/')[1] || '').split('?')[0])
    const body = init?.body ? JSON.parse(String(init.body)) as {
      params?: Record<string, unknown>
      sessionId?: string
      workdir?: string
      projectId?: string
    } : {}
    calls.push({
      method,
      params: body.params || {},
      context: {
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
        ...(body.workdir ? { workdir: body.workdir } : {}),
        ...(body.projectId ? { projectId: body.projectId } : {})
      }
    })
    let data: unknown = { ok: true }
    if (method === 'resolveContext') data = context
    if (method === 'observe') data = { ok: true, repo }
    if (method === 'listBranches') data = { branches: repo.branches }
    if (method === 'listWorkspaces') data = { workspaces: [{ name: 'issue-7', path: '/repo/ws' }] }
    if (method === 'listSessions') data = { sessions: [{ id: 'session-12345678', title: 'Test session', workspace: 'issue-7', branch: 'feat/x' }] }
    return new Response(JSON.stringify({ result: data }), { status: 200 })
  }))
  return calls
}

describe('React panel', () => {
  it('renders topology and workspace state', async () => {
    installRpcMock()
    render(<App />)
    expect(await screen.findByText('Git Workspace Map')).toBeInTheDocument()
    expect(await screen.findByText('src/a.ts')).toBeInTheDocument()
    expect(await screen.findByText('issue-7')).toBeInTheDocument()
    expect(await screen.findByText('git@example/repo.git')).toBeInTheDocument()
  })

  it('binds RPCs to the session identified by the parent page', async () => {
    const calls = installRpcMock()
    render(<App />)
    await screen.findByText('Git Workspace Map')
    await waitFor(() => expect(calls).toContainEqual({
      method: 'observe',
      params: {},
      context: { sessionId: 'session-12345678', workdir: '/repo', projectId: 'project-1' }
    }))
  })

  it('fetches all remotes', async () => {
    const calls = installRpcMock()
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /Fetch all/i }))
    await waitFor(() => expect(calls.some((call) => call.method === 'fetch')).toBe(true))
  })

  it('creates and checks out a branch with an optional source', async () => {
    const calls = installRpcMock()
    render(<App />)
    fireEvent.change(await screen.findByLabelText('New branch'), { target: { value: 'feat/react' } })
    fireEvent.change(screen.getByLabelText('Source branch'), { target: { value: 'develop' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create & checkout' }))
    await waitFor(() => expect(calls).toContainEqual({
      method: 'createBranch',
      params: { name: 'feat/react', sourceBranch: 'develop' },
      context: { sessionId: 'session-12345678', workdir: '/repo', projectId: 'project-1' }
    }))
  })
})
