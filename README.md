# openfox-git-workspace-map

OpenFox plugin (Plugin API v2, peer `openfox >= 2.0.151`) that surfaces the full
git topology of the active workspace and lets you manage branches, workspaces
and remotes without leaving the OpenFox UI.

## What it does

- Renders a **badge in the session header** (`session.header.badges`) showing
  the current branch, dirty count and ahead/behind vs upstream.
- Adds an **action in the session header** (`session.header.actions`) that
  opens an iframe panel.
- The iframe panel (`assets/git-workspace.html`) visualises:
  - **Topology**: `upstream (.git common dir) → workspace (effective workdir) → branch/tracking → origin`.
  - **HEAD** (short SHA), **dirty/clean** status, **modified files**.
  - **Remotes** with fetch/push URLs.
  - **Ahead/behind** vs upstream.
  - **Workspaces** of the active project and **sessions** sharing them.
- Performs **mutations through OpenFox REST**, never through direct git CLI:
  - `POST /api/sessions/:id/checkout` — switch branch.
  - `POST /api/sessions/:id/switch-workspace` — create/switch workspace.
  - `POST /api/sessions/:id/delete-workspace` — delete workspace (force-aware).
  - `POST /api/projects/:id/checkout-new` — fork a new branch from the project
    root.
- Performs **observation + fetch through git CLI** (read-only):
  - `git status`, `git rev-parse`, `git remote -v`, `git fetch --all --prune`,
    `git for-each-ref`.

## Context resolution (no core patch)

The plugin never touches the OpenFox core. The badge slot
`session.header.badges` is the only slot for which the host calls a plugin RPC
with the live `sessionId / workdir / projectId`. The badge handler mirrors that
context into the plugin's own storage so every subsequent iframe RPC can resolve
the "active" context, regardless of whether the iframe was opened from the
session header action or from the bare action button.

Resolution order for every iframe RPC:

1. The `PluginToolContext` passed in by the host (always populated when the
   front calls the RPC on behalf of a session).
2. The cached entry written by the badge RPC.
3. `process.cwd()` as a last resort.

## Install

From the OpenFox UI (Plugins → Registry / GitHub URL):

```
https://github.com/theshwal/openfox-git-workspace-map
```

Or drop the package into `~/.config/openfox/plugins/openfox-git-workspace-map/`
and restart the OpenFox server.

## Files

- `package.json` — manifest with `openfox.apiVersion: 2`.
- `src/index.js` — plugin entry: registers tool, badge, action, panel, RPCs,
  hooks and asset.
- `src/git-state.js` — read-only git CLI wrapper (`execFile`, bounded timeouts,
  no shell).
- `assets/git-workspace.html` — sandboxed iframe UI (vanilla, no build).
- `test/index.test.js` — unit tests for the plugin registration and RPCs.
- `test/git-state.test.js` — integration tests against a throwaway git repo.
- `README.md`, `LICENSE`.

## Compatibility

| Component   | Version    |
| ----------- | ---------- |
| OpenFox     | >= 2.0.151 |
| Node.js     | >= 20.0.0  |
| License     | MIT        |

## Tests

```bash
npm install
npm run syntax            # node --check on both source files
npx vitest run            # runs both unit and integration tests
```

## Limitations

- The plugin can only operate on workdirs that the host has resolved for the
  current session. Calling the panel from outside a session falls back to
  `process.cwd()` of the host process.
- Workspace deletion requires the active session to be the one requesting it.
  Force-delete is supported (with a UI confirmation step) but only when the
  host reports a `WorkspaceInUseError` first.
- The plugin cannot list workspaces for projects without a `projectId` in the
  RPC context (UI shows "No project context" in that case).
- No tests for the iframe UI itself (it is exercised manually inside a running
  OpenFox session). The HTML is linted visually via the curl-based asset smoke
  test in `scripts/smoke.sh` (optional).

## License

MIT — see `LICENSE`.
