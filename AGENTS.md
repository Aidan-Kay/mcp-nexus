# AGENTS.md — mcp-nexus

Conventions for a coding agent working in this repository. `README.md` is the
specification; this is the short version. Where they disagree, the README wins
and this file is wrong — say so rather than following it.

## What this is

One MCP endpoint in front of many upstream MCP servers, so an agent browses and
searches tools on demand instead of loading every schema at session start.
Node 22 (the image's base and CI's version), TypeScript, ESM.

## Commands

```
npx tsc --noEmit      # typecheck
npx tsc --noEmit -p eval   # typecheck the eval too
npx tsc --noEmit -p test   # and the tests
npm test              # node:test via tsx: unit tests, and call_tool end to end
npm run eval          # search relevance eval; fails on regression from eval/baseline.json
npm run build         # tsc into dist/
npm run dev           # tsx watch, against ./mcp-nexus.yaml
docker build -t mcp-nexus .
```

There is no linter. The acceptance checks are the three typechecks, `npm test`
and `npm run eval`, which is what CI runs. Any change to search ranking must
pass the eval; improve the baseline only deliberately, with
`npm run eval -- --update`, never to make a regression go away. Adding queries
moves the averages on its own, so compare per query (`--verbose`) and re-baseline
only when no existing query got worse.

Tests use `node:test` and `node:assert/strict` — no test framework is installed,
and none should be. A test written from a spec must fail against the code
before the change. `test/call-tool.test.ts` runs a real server and client
against `test/stub-upstream.mjs`; give a new call_tool behaviour a tool there.

## Layout

```
src/index.ts          entry point
src/nexus-server.ts   the MCP surface: browse, search, get_schemas, call_tool
src/gateway.ts        client tokens, per-client policy, confirmation, the call log
src/config.ts         the strict config schema; tokens from the environment
src/validation.ts     call_tool arguments against the upstream schema
src/response.ts       JSON payloads, `select`, shape inference
src/sources/          one transport per file - http and stdio upstreams, the size cap
src/search/           lexical, semantic and hybrid tool search, embedding providers
eval/                 offline relevance eval: corpus snapshot, queries, baseline
test/                 node:test suites and the stub upstream
src/artefacts.ts      large tool results written to files instead of returned
src/recovery.ts       re-probes failed sources on a timer
```

The config schema is strict: every object rejects keys it does not know. A
config key added to the code must be added to `mcp-nexus.example.yaml` and the
README's config table in the same change, and a key removed belongs in
`RETIRED_SOURCE_KEYS` (or its equivalent) so an old config fails with the reason.
The deployed config on firelink (`~/llm/mcp-nexus/volumes/mcp-nexus.yaml`) does
not track this repo — check it parses before deploying a schema change.

## After a push

A push to `main` is finished when the change is running on firelink.

1. **Watch CI.** `gh run watch $(gh run list --branch main --limit 1 --json databaseId -q '.[0].databaseId') --exit-status`.
   If it fails, read `gh run view <id> --log-failed` and report it; do not
   deploy.
2. **Deploy**, only once CI is green. The `image` job publishes
   `ghcr.io/aidan-kay/mcp-nexus:latest` after the typecheck; pulling before it
   finishes silently redeploys the previous image.
   ```
   ssh firelink 'cd ~/llm && docker compose pull mcp-nexus && docker compose up -d mcp-nexus'
   ```
3. **Confirm it took.** The running image's digest should equal the one CI
   pushed for the commit (`docker buildx imagetools inspect ghcr.io/aidan-kay/mcp-nexus:<full sha>`).
   The image has no healthcheck, so read the logs for `mcp-nexus listening`
   and check every source is available through the `index` tool.

A push that touches only documentation (`README.md`, `AGENTS.md`) gets step 1
but not steps 2 and 3: nothing that runs has changed.

## Never

- Commit `mcp-nexus.yaml` or `mcp-nexus.dev.yaml`. They hold real service URLs
  and tokens; `mcp-nexus.example.yaml` is the committed one.
- Put a token anywhere but the environment: `MCP_NEXUS_AUTH_TOKEN` for the shared
  one, `MCP_NEXUS_TOKEN_<NAME>` for a client's own. A client's policy
  (`auth.clients`) is not secret and does belong in the config.
- Log an argument's value. The call log records argument names only.
- Commit, push, or change git state unless explicitly asked.
- Claim a check passed that you did not run.
