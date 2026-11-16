# Stage 4: performance

The retained optimization memoizes parsed commits and trees by immutable GitObject
identity. Receive-pack staging stores copy the object map but share existing object
instances, so repeated connectivity and fast-forward validation now reuse parsing.
Ref moves need no invalidation: lookups first resolve the current object instance.
Replacing an object map or object instance cannot hit an older instance's entry.

Each of the two process-wide FIFO caches holds at most 4096 entries and admits only
payloads up to 4096 bytes (at most 16 MiB of retained source payload per cache,
plus bounded parsed representation and Map overhead). Large objects bypass caching.
Caches create no timers, sockets or background work. Repository data itself still
grows with legitimate writes, as before. main.ts is unchanged, including registration,
/done polling, server closure and explicit exit.

## Measurement

Run `node --experimental-strip-types tests/bench-local.ts`. It prints recorded BEFORE
rounds and freshly measured AFTER rounds. `--baseline PATH` records a new baseline;
`--compare PATH` compares another baseline. The committed baseline is
`tests/bench-before.json`.

The harness invokes the supplied runBenchmark unchanged using the existing
surface-harness fetch adapter and actual createApp request listener. This preserves
client serialization, response parsing, checksum verification, setup, prebuilt push
payloads, five warmups, three rounds, and operation counts/concurrency. It omits TCP,
keep-alive pool and kernel costs. Missing calibration.json is supplied by the existing
uncalibrated test hook; no scores or reference times are fabricated.

The baseline used an isolated /tmp copy with original HEAD git-store.ts and
git-pack.ts restored. It was measured after the initial cache experiment, rather
than before any implementation edits; the measured baseline code is the original
implementation. Local runtime was Node v24.22.1, not Node 22; no new dependencies
or syntax requiring that newer runtime were added.

Latest full-run medians (milliseconds per round):

| Workload | Before | After |
| --- | ---: | ---: |
| 200 sequential pushes | 449.841 | 269.616 |
| 50 concurrent shallow clones | 32.317 | 34.237 |
| 2000 issue reads | 189.977 | 175.922 |
| 200 issue writes | 14.872 | 15.048 |

After rounds: push [351.140, 240.937, 269.616]; clone [29.295, 36.249,
34.237]; read [220.795, 152.433, 175.922]; write [28.299, 15.048, 14.396].
Push improves approximately 40%. Clone and REST differences are small/noisy;
REST implementation is unchanged and no REST speedup is claimed. Earlier runs
also showed push improvement. Small per-store caches were discarded because they
churned during push history walks. Identical-pack caching was discarded because
it showed no consistent end-to-end clone benefit.

## Correctness and robustness

All six required local suites passed after the cache experiments and again on the
final implementation: REST 55/55, Git conformance 30/30, GraphQL 20/20, MCP 15/15,
plus supplemental surface checks, git-store ancestry/merge/tree checks and all six
git-pack cases (including real Git delta decoding and strict index-pack).

The benchmark additionally calls MCP list_issues against all 605 issues created
by the write workload, validates the returned count, and asserts response time
below 3000 ms. Final observed time: 4.520 ms. The benchmark process exits naturally
after cleanup; retained caches add no handles. The supplied runner ordering was
reviewed in docs/conformance/main.ts: fixture setup, 120 sequential checks, four
benchmarks, export, then /done. docs/conformance/run.ts is absent from this kit.

Remaining limits: push still copies the object map and validates historical
connectivity; no unsafe shortcut trusts previous ref reachability. Full clones
still deflate objects per request. Memory estimates bound auxiliary cache data,
not user-owned repositories or incoming request allocations. External TCP and
lifecycle verification remains the orchestrator's job; no local TCP run is claimed.
