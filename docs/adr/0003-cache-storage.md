# ADR-0003: in-process cache vs Redis/external store

Status: Accepted (2026-01).

## Context

The plugin runs as a single Node.js process inside OpenFox. Git observation
results are expensive (multiple subprocess spawns) and called frequently by the
UI poll.

Options:

1. **No cache** — every observation spawns `git status`, `git for-each-ref`, etc.
2. **In-process `Map` with TTL** — simple, fast, lost on restart.
3. **External store (Redis)** — survives restart, shared across instances.

## Decision

Use **in-process `Map`** with a 5 s TTL and explicit invalidation on mutation.

## Consequences

- Lost on plugin reload, but the cache is cheap to rebuild.
- No cross-instance sharing; not an issue since OpenFox runs one plugin instance.
- TTL of 5 s balances freshness vs load: a single poll cycle (15 s) hits the
  cache for 2/3 of its calls.
- Mutations (`fetchRemote`, `pull`, `reset`, branch creation) call
  `invalidateCache(\`observe:\${cwd}\`)` so the next observation re-reads state.
