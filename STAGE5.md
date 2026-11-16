# Stage 5 — targeted fixes

Repository creation now distinguishes invalid names from duplicates. Invalid names
still return HTTP 422 with a validation message. Duplicates return HTTP 422 with
`message: "Validation Failed"` and an `errors` array containing
`{resource: "Repository", code: "custom", field: "name", message: "name already exists on this account"}`.
`HttpError` carries optional validation details, and the REST handler serializes
those details so the git client's raw-body `/already exists/i` test succeeds.
The regression in `tests/rest.ts` checks first-create 201, duplicate 422, the raw
body phrase, the exact JSON shape, and continued invalid-name validation.

Reimplemented `main.ts` with a shared retry driver and separate registration and
completion operations. It explicitly reads both environment variables and uses
`createApp` for routes, authentication and the public `/healthz` response.
It preserves URL trailing-slash removal, missing-URL exit 1, ephemeral port
allocation, startup messages, 30-second request timeouts, independent 250ms-to-2s
exponential backoffs, registration 200/409 acceptance, fatal 400/405 responses,
retryable transport failures and other statuses, strict `done === true`, server
closure and explicit exit 0. Other fatal errors retain stderr logging and exit 1.
The old entrypoint omitted a listen host; this version explicitly uses
`127.0.0.1` as requested.

## Verification

Run with Node v24.22.1:

| Command | Result |
| --- | --- |
| `node tests/rest.ts` | PASS, including new duplicate-create regression and 55 supplied checks |
| `node tests/git-conformance.ts` | PASS, 30 supplied checks and supplemental checks |
| `node tests/graphql.ts` | PASS, 20 supplied checks and supplemental checks |
| `node tests/mcp.ts` | PASS, 15 supplied checks and supplemental checks |
| `node tests/git-store.ts` | PASS |
| `node tests/git-pack.ts` | PASS, 6 pack cases |
| `node tests/lifecycle.ts` | BLOCKED: sandbox rejects harness TCP bind with `listen EPERM: operation not permitted 127.0.0.1` |
| `node tests/git-http.ts` | BLOCKED: same TCP listen restriction |

The two TCP tests must run under the orchestrator; neither is claimed as passing
here. The full orchestrator conformance suite was not rerun in this sandbox.
No commit was made.
