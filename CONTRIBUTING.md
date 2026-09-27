# Contributing

Thanks for your interest in contributing to `openfox-git-workspace-map`.

## Development setup

Requirements: Node.js >= 20.

```bash
git clone https://github.com/theshwal/openfox-git-workspace-map.git
cd openfox-git-workspace-map
npm install
npm run verify
```

`npm run verify` runs TypeScript, tests, build, and the bundle audit checks.

## Conventions

- **TypeScript strict** — `tsconfig.json` has `strict: true`. Don't relax it.
- **No `eval`, `new Function`, `innerHTML=`** — enforced by CI. Use `textContent`, `createElement`, or React rendering.
- **No shell** — always use `execFile` for subprocesses. Validate arguments with `safeRef` / `safeRemote`.
- **Redact secrets** — anything that could contain a token, basic-auth URL, or password must pass through `redactSecrets` before logging.
- **i18n** — UI strings live in `STRINGS` in `src/ui.tsx`. Add a new locale by extending the dict and `Lang` type.
- **Mutations** go through OpenFox REST, never direct Git CLI.
- **Cache** — observation results are cached for 5s. Mutations must call `invalidateCache(\`observe:\${cwd}\`)`.

## Testing

- Backend tests in `test/plugin.test.ts` and `test/plugin-extras.test.ts`.
- UI tests in `test/ui.test.tsx` (Vitest + jsdom + @testing-library/react).
- All tests run under `npm test`.

When adding a new RPC, add at least one test asserting it is registered and one test exercising the happy path. For RPCs that hit OpenFox REST, mock `fetch` with `vi.stubGlobal('fetch', ...)`.

## Architecture decisions

See `docs/adr/` (when present) for rationale behind non-obvious choices:

- ADR-0001: postMessage vs referrer for panel context
- ADR-0002: polling vs SSE/WebSocket for git state refresh
- ADR-0003: in-process cache vs Redis/external store

## Submitting changes

1. Create a branch off `main`.
2. Run `npm run verify` locally before pushing.
3. Open a PR describing the change and link any related issue.
4. CI must pass (typecheck + tests + build + bundle audit).

## Reporting issues

Use [GitHub Issues](https://github.com/theshwal/openfox-git-workspace-map/issues). For upstream OpenFox feature requests, use the `upstream-proposal` label on this repo's tracker — they will be triaged separately.
