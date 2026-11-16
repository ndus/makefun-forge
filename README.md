# makefun-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ndus/makefun-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ndus/makefun-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process — it implements git itself (object store, packfiles, smart HTTP) with no git binary and no outside service. Surfaces: git smart HTTP (upload-pack protocol v2, receive-pack v0, fast-forward only), the REST v3 API (repos, contents, labels, issues, pull requests with squash merge), GraphQL v4, and an MCP endpoint (JSON-RPC Streamable HTTP, 6 tools). Passes the kit's full conformance suite 120/120 with a score of 990/1000 locally.

## Run it

```sh
MAKEFUN_ENV_URL=<harness url> MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

The entry binds an ephemeral port, registers it with the harness, serves until the harness reports done, then exits 0.

---

<sub>Entered on [make.fun](https://make.fun/?ref=c8k7kbr0&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
