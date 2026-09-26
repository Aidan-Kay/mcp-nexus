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
npm run eval          # search relevance eval; fails on regression from eval/baseline.json
npm run build         # tsc into dist/
npm run dev           # tsx watch, against ./mcp-nexus.yaml
docker build -t mcp-nexus .
```

There is no unit test suite and no linter. The acceptance checks are the two
typechecks and `npm run eval`, which is what CI runs. Any change to search
ranking must pass the eval; improve the baseline only deliberately, with
`npm run eval -- --update`, never to make a regression go away.

## Layout

```
src/index.ts          entry point
src/nexus-server.ts   the MCP surface: browse, search, get_schemas, call_tool
src/sources/          one transport per file - http and stdio upstreams
src/search/           lexical, semantic and hybrid tool search, embedding providers
eval/                 offline relevance eval: corpus snapshot, queries, baseline
src/artefacts.ts      large tool results written to files instead of returned
src/recovery.ts       re-probes failed sources on a timer
```

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
- Put the auth token anywhere but `MCP_NEXUS_AUTH_TOKEN`.
- Unpin `@modelcontextprotocol/server-filesystem` in the Dockerfile. It writes
  files on Lyra's behalf, so a version change is a decision, not an upgrade.
- Commit, push, or change git state unless explicitly asked.
- Claim a check passed that you did not run.
