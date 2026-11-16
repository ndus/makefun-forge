# Stage 1

Run with Node 22.18+ using `node main.ts`. Set `MAKEFUN_SHOP_TOKEN` and
`MAKEFUN_ENV_URL`. The unchanged starter binds port 0, registers its assigned
port, polls `/done`, and exits 0 when done. Without `MAKEFUN_ENV_URL`, it retains
the starter's immediate exit 1.

- `git-store.ts`: raw Git objects, SHA-1 IDs, binary trees, refs, commit ancestry,
  loose-object compression, and three-way file merges. Incoming pack objects can
  later be inserted with `put`; pack writers can use object types and payloads.
- `store.ts`: repositories, labels, issues, comments and pull requests, with
  shared IDs and deterministic increasing timestamps.
- `app.ts`: REST adapter, authentication, JSON errors and pagination.
- `identity.ts`: derives the opaque token's viewer using the published wire
  identity generator. The source file `docs/conformance/wire.ts` is therefore a
  runtime dependency; no package or external service is used.

Git smart HTTP, GraphQL and MCP are not implemented.

## Validation

`node tests/rest.ts` runs all 55 supplied REST/protocol assertions through the
actual server callback with an in-process fetch transport. It also checks auth
and hashes/decompresses every stored object. The kit lacks calibration.json;
a test-only module hook supplies uncalibrated benchmark metadata, which these
REST checks do not use. No conformance source is modified.

`node tests/git-store.ts` checks canonical empty-object IDs, binary nested files,
tree ordering, ancestry, independent edits and conflicting edits.

`node tests/lifecycle.ts` runs a real dummy environment and spawns `node main.ts`
to verify registration, repeated done polling and exit 0. TCP binding is blocked
with EPERM in the development sandbox, so this last test could not run here.
The available development runtime is Node 24.22.1; direct Node 22 execution was
not available. Source uses erasable TypeScript and standard Node APIs only.

## Contract interpretations and limits

`/healthz` is a public lifecycle probe: the supplied boot runner requests it
without Authorization. All application surfaces require the exact bearer token,
including unknown routes. This resolves the conflict between blanket auth wording
and the boot contract in favor of allowing the suite to boot.

Merge conflict detection operates at file granularity. Independent paths and
identical edits merge; different edits to the same file are rejected, even when a
line-based merger might resolve them. Squash commits have the base tip as their
single parent and update the PR's base branch (the supplied checks use the default
branch).
