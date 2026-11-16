# Stage 3: GraphQL and MCP

Implemented `/api/graphql` and `/mcp` with the existing exact Bearer-token authentication. Both use the same `ForgeStore`, repositories, issues, pull requests, refs and git objects as REST and smart HTTP. No dependencies, build step, external service or production git executable were added. `main.ts` is unchanged, including ephemeral-port registration, `/done` polling and exit behavior.

## GraphQL

`graphql.ts` parses selections, aliases, variables and defaults, operation names, inline fragments, enum/list/object inputs and JSON-array operation batches. Selection validation happens before mutations. Unknown fields produce HTTP 200 GraphQL errors naming the field, missing repositories resolve to null without errors, and malformed documents produce errors without escaping the handler. Malformed JSON receives HTTP 400 with GraphQL errors.

The schema supports viewer, repository and node reads; Issue, PullRequest, Repository and enum introspection (including field type references); issue and PR connections; labels; changed files; cursor pagination; and createIssue, closeIssue, createPullRequest, mergePullRequest and addComment. Issue ordering uses creation timestamps and number tie-breaks, both descending for CREATED_AT DESC. IDs stay stable across surfaces. Mutations update the existing objects, and PR creation and squash merge use the existing store methods.

## MCP

`mcp.ts` implements stateless JSON Streamable HTTP with `server/discover` advertising revision `2026-07-28`, server identity and tools capability. Six tools are exposed with stable descriptions and object schemas: create_repo, get_repo, create_issue, list_issues, create_pull_request and merge_pull_request. Tool results contain JSON in text content.

JSON-RPC IDs are preserved independently for concurrent calls. Unknown methods return -32601; unknown tools and invalid arguments return -32602; malformed JSON returns HTTP 400/-32700; invalid envelopes return -32600. Domain failures are tool results with isError:true. Notifications receive HTTP 202 with no body. List response bodies are byte-identical for identical request IDs (different IDs necessarily change the envelope); the tools array is identical across all calls.

## Verification

Run from the repository root with `node tests/<name>.ts`:

| Test | Result |
| --- | --- |
| graphql.ts | 20/20 supplied GraphQL checks, plus supplemental assertions |
| mcp.ts | 15/15 supplied MCP checks, plus supplemental assertions |
| rest.ts | 55/55 supplied REST checks, plus existing supplemental assertions |
| git-conformance.ts | 30/30 supplied git checks, plus existing supplemental assertions |
| git-store.ts | Pass: canonical IDs, binary nested trees, tree ordering, ancestry, three-way merge |
| git-pack.ts | 6/6 pack cases, including real Git delta packs and strict index-pack |

All 120 supplied surface checks pass. The new tests drive the real HTTP request handler through an in-process transport. GraphQL PR fixtures are built in a separate git object store and pushed through the kit GitClient and smart HTTP handler. Supplemental assertions compare GraphQL-created PRs against REST for ID, number, title, head, base and state, and MCP-created issues against both REST and GraphQL. They also cover timestamp ties, operation selection/defaults, labels, malformed documents/JSON, batch error isolation, pre-mutation field validation, auth, introspection types, JSON-RPC errors and empty notification bodies. Every complete MCP conformance check finished in less than three seconds, including its setup and requests.

`git diff --check` passes. The available runtime was Node v24.22.1; Node 22 was not installed for a direct runtime check. Code uses erasable TypeScript and standard-library facilities compatible with the repository's Node >=22.18 requirement.

## Limits

This is the contracted GraphQL subset, not the complete GitHub schema or a full GraphQL implementation. Named fragment definitions, directives, subscriptions, full argument/input coercion and schema-wide introspection are not implemented. Parser depth and token limits bound document processing. Merge mutations support squash only. Store persistence and other pre-existing store limitations are unchanged.

MCP supports the modern discovery protocol only, with JSON responses and no SSE stream, sessions or legacy initialize handshake. GET /mcp is 405. No claim is made of full MCP protocol compliance beyond this surface or a hard latency bound under arbitrary workload; the supplied checks and their timing assertions pass.

The TCP git CLI integration (`tests/git-http.ts`) and lifecycle smoke test (`tests/lifecycle.ts`) were attempted but both were blocked by this sandbox's `listen EPERM` restriction. They could not be reverified here. The prior stage's TCP results remain historical; the in-process regression suites above passed in this session.
