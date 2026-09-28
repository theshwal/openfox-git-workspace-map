# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] - 2026-XX-XX

### Changed (breaking for plugin-to-plugin RPC collisions)

- **All plugin RPC methods are now namespaced** with a `gitWorkspace.` prefix
  (e.g. `health` → `gitWorkspace.health`, `observe` → `gitWorkspace.observe`,
  `fetch` → `gitWorkspace.fetch`, `listBranches` → `gitWorkspace.listBranches`,
  `switchWorkspace` → `gitWorkspace.switchWorkspace`, …).
- The session-row badge `source.method` is now `gitWorkspace.badge`.
- HTTP RPC endpoint path changes from
  `POST /api/plugins/<id>/rpc/<method>` to use the namespaced method
  (e.g. `/api/plugins/<id>/rpc/gitWorkspace.health`).
- The shared `RPC_NAMESPACE` constant now lives in `src/constants.ts` and is
  imported by both the plugin server entry and the bundled React panel, so the
  prefix cannot drift between the two.

### Why

OpenFox shares a single global RPC registry across all plugins. Two plugins
claiming the same generic method name (e.g. `health`) caused
`Plugin rpc 'health' is already registered by 'openfox-automate'` at load time.
Namespacing every plugin-owned RPC prevents future collisions and is a no-op for
the plugin's own business logic — endpoints, payloads, and side effects are
unchanged.

### Migration

Consumers (the bundled React panel and any external caller) must call
`gitWorkspace.<method>` instead of `<method>`. The plugin still ships its own
panel which already targets the new names; no rebuild is required from
installers beyond the usual `npm run build`.

## [1.3.0] - 2026-01-XX

### Added

- `workdir` is mandatory in every RPC. Structured `NO_WORKDIR` error when missing.
- `createWorkspace` and `switchWorkspace` now send a `mode` field to discriminate.
- `commonDir` always returned as an absolute path.
- `health` RPC exposes counters, cache size, node version, uptime.
- UI listens for `postMessage('openfox:panel-context')` from the parent.
- `window.confirm` replaced by React modal with focus trap (sandbox-safe).
- Polling has a mutex; stale responses are dropped.
- Stash list/apply/pop/drop RPCs.
- Tags list/create/delete RPCs.
- Recent commit log RPC.
- Diff stat RPC.
- `git pull` (ff-only / rebase / merge).
- `git reset` (soft / mixed / hard).
- `merge-tree` pre-flight conflict detection before checkout.
- Merge/rebase/cherry-pick/revert/bisect in-progress detection.
- i18n (en/fr) and theme toggle (dark/light) in the panel.
- Skeleton loaders and contextual empty states.
- `aria-live="polite"` on toast for screen readers.
- HTTP retry with exponential backoff on 5xx (10s timeout, AbortController).
- Secret redaction in `logger.debug` (PATs, basic-auth URLs).
- CI: bundle audit (no `eval` / `new Function` / `innerHTML=`), CSP check, inlining guard, size guard.

### Changed

- `listBranches` uses local Git observation (faster, no extra REST hop).
- CI verification strengthened.

## [1.2.0] - 2026-01-XX

### Added

- Session-scoped UI: action in `composer.actions`, badge in `session.row.badges`.
- Iframe reconstructs the active session from the embedding page.

## [1.1.0] - 2025-XX-XX

### Changed

- Migrated source development to TypeScript + React.

## [1.0.0] - 2025-XX-XX

### Added

- Initial release: JavaScript plugin with handwritten HTML/DOM UI.
