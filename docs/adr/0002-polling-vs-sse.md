# ADR-0002: polling vs SSE/WebSocket for git state refresh

Status: Accepted (2026-01).

## Context

The panel needs fresh Git state (branch, HEAD, dirty files, remotes, ahead/behind).
Two main approaches:

1. **Polling** — every 15 s, the UI calls the `observe` RPC which runs `git` commands.
2. **Server push (SSE/WebSocket)** — OpenFox pushes events when files change,
   branches move, or remotes update.

## Decision

Use **polling** with a 5 s backend cache and a UI mutex that drops stale responses.

## Consequences

- Simple to implement, no protocol change required.
- Higher CPU usage (one `git status` per session per 15 s).
- 15 s worst-case staleness.
- The cache ensures that concurrent refreshes from multiple UI panels hit a
  single `git` invocation per 5 s window.
- When OpenFox exposes SSE/WebSocket events (see upstream issue `US-11`), we can
  layer them on top without changing the RPC contract.
