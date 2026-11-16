# Stage 2: Git smart HTTP

Implemented authenticated smart HTTP at `/{owner}/{repo}.git`, sharing the
stage-1 repository, object and ref stores with REST. `main.ts` is unchanged:
port 0, registration, done polling and exit semantics are preserved. Runtime
code uses only Node standard libraries and erasable TypeScript; it neither
spawns Git nor imports the conformance Git implementation.

- Upload-pack advertises protocol v2 when requested, opening with `version 2`.
  It implements ls-refs with prefixes, unborn HEAD, symrefs and recursive tag
  peeling; fetch supports full, incremental and absolute-depth shallow fetches,
  including boundary movement. V0 discovery and want/have/done fetch are also
  supported. Generated packs contain canonical objects and a SHA-1 trailer;
  negotiated side-band-64k packets obey the byte limit.
- Receive-pack is v0, with report-status, side-band-64k, delete-refs, ofs-delta,
  object-format and agent capabilities. Pack v2/v3 imports verify checksums and
  sizes, resolve REF_DELTA and OFS_DELTA (including thin bases from the store),
  and compute canonical object IDs. Imports are staged before refs change.
- Updates check the old OID, object closure and commit ancestry. Non-fast-forward
  updates return `ng <ref> non-fast-forward`; independent valid commands in the
  same push apply. Branch/tag deletion and first pushes are supported.
- Both services use the existing exact Bearer token authentication and owner
  isolation. Missing or foreign-owner repositories return 404. Malformed framing
  returns 400; invalid packs report unpack failure without moving refs.

## Verification

Executed on the available Node 24.22.1 and Git 2.43.0:

| Command | Result |
| --- | --- |
| `node tests/git-conformance.ts` | 30/30 supplied Git checks pass, plus supplemental auth, owner isolation, v0 clone, corrupt push isolation, malformed input, REST branch/content visibility and multi-packet binary transfer assertions |
| `node tests/rest.ts` | 55/55 stage-1 REST/protocol checks pass; 303 stored objects verified |
| `node tests/git-store.ts` | Existing object-store assertion suite passes |
| `node tests/git-pack.ts` | 6 pack cases pass using actual Git: thin reference deltas, offset deltas, imported byte equality, generated pack accepted by `git index-pack --strict`, corrupt checksum rejection, truncation rejection |
| `git diff --check` | Pass |
| `node tests/git-http.ts` | Blocked by sandbox `listen EPERM`; not counted as passing |
| `node tests/lifecycle.ts` | Also blocked by sandbox `listen EPERM`; lifecycle source unchanged |

The kit's calibration.json is absent. As in the stage-1 runner, test-only module
hooks supply empty calibration metadata; no conformance files are modified and
no benchmark scores are claimed. The in-process runner invokes the actual HTTP
request handler, but does not validate TCP transport.

`tests/git-http.ts` is the real TCP integration test for a host permitting
listeners. It boots `main.ts` against a registration/done harness, runs all 30
kit checks, then uses Git CLI clone, commit, push, pull, force-push refusal,
mixed push, branch deletion, reclone, fsck and shallow fetch. It checks REST
contents after pushing and exit 0 after done. Run it with `node tests/git-http.ts`.
A manual HTTP clone and this TCP integration test remain unverified here because
listeners are prohibited; offline CLI pack interoperability is verified.

## Limits

Storage remains in memory. Packs and responses are buffered, with a 64 MiB
request/per-object limit and a 256 MiB inflated-entry budget. Outgoing packs use
zlib-compressed full objects rather than delta compression. Shallow coverage is
absolute numeric depth, not relative/time/exclusion deepening. Partial clone
filters, atomic pushes, push certificates, SHA-256 repositories and persistent
storage are outside this stage. Negotiation is basic NAK/done negotiation, not
multi-ack optimization. Direct Node 22 execution was not available locally.
GraphQL and MCP remain outside the implemented stages.
