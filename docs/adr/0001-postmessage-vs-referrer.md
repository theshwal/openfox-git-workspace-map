# ADR-0001: postMessage vs referrer for panel context

Status: Accepted (2026-01).

## Context

The plugin UI runs inside a sandboxed iframe loaded by OpenFox as a panel.
The UI must know the active session (`sessionId`, `workdir`, `projectId`) to
make RPC calls.

Options considered:

1. **`document.referrer` + `/api/sessions/<id>` from `location.origin`**
   Pros: simple, no protocol change.
   Cons: `location.origin` inside the iframe is not the OpenFox API host, so the
   fetch always 404s in production. Even when it works, the referrer can be
   stripped by `Referrer-Policy` or stripped by the browser.
2. **`postMessage` from the OpenFox parent page to the iframe**
   Pros: explicit, fast, secure (origin-checked by the parent).
   Cons: requires OpenFox core change to publish the message.
3. **URL query params on the panel URL**
   Pros: trivial, no protocol change.
   Cons: leaks session ID in logs/history; not suitable.

## Decision

Use **postMessage** as the primary mechanism, with `document.referrer` + REST
fallback when the parent does not post a message within 500 ms.

The plugin listens for `MessageEvent` with `data.type === 'openfox:panel-context'`
and payload `{ sessionId, workdir, projectId }`. If no message arrives within
500 ms, it falls back to extracting `sessionId` from `document.referrer` (regex
`/\/p\/[^/]+\/s\/([^/?#]+)/`) and fetching session details. If that also fails,
it calls the `resolveContext` RPC against the backend cache.

## Consequences

- Iframe must accept `postMessage` from the OpenFox origin only.
- The 500 ms wait adds latency to initial render. Acceptable for a panel that
  itself takes longer to render.
- The fallback chain keeps the plugin functional in environments where OpenFox
  has not yet implemented the postMessage protocol.
