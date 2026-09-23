# ─── Build Stage ───────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# The source arrives from the build context, not from a `git clone`. CI builds
# this image from its own checkout and firelink pulls it by tag, so a clone
# would fetch over the network what is already in the context - and Docker
# caches a clone layer on the URL alone, so a new commit on main was silently
# not built without --no-cache. Copying builds the commit in hand.

# Manifests first, so the dependency layer is keyed on them alone and editing
# a source file does not reinstall node_modules. `ci` rather than `install`:
# the lockfile is the build, not a suggestion to it.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc
# Prune dev dependencies so runtime only has production deps (with native binaries intact)
RUN npm prune --omit=dev

# ─── Runtime Stage ────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

WORKDIR /app

# libgomp1 is required by ONNX Runtime (used by @xenova/transformers for built-in embeddings)
RUN apt-get update && \
    apt-get install -y --no-install-recommends libgomp1 && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r nexus && useradd -r -g nexus nexus

# Filesystem MCP server — launched by nexus as a stdio source (the `files` source in
# mcp-nexus.yaml), sandboxed to /data/lyra. Installed into the image rather than fetched
# at runtime with `npx -y`: the container has no writable $HOME, so npx has nowhere to
# put its cache and the source would fail to start. Pinned deliberately — this package
# can write files on Lyra's behalf.
RUN npm install -g @modelcontextprotocol/server-filesystem@2026.7.10

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules/ ./node_modules/

COPY --from=builder /app/dist/ ./dist/

# Create data directory for model cache (writable by nexus user)
RUN mkdir -p /app/data/model-cache && chown -R nexus:nexus /app/data

# Volume for caching downloaded embedding models (built-in provider)
VOLUME ["/app/data/model-cache"]
ENV TRANSFORMERS_CACHE=/app/data/model-cache

# Artefacts root (see `artefacts` in the config). Created and chowned here so that
# Docker seeds the right ownership when it initialises an empty named volume —
# otherwise the mountpoint arrives root-owned 755 and the non-root user cannot write.
# A bind mount takes the host directory's ownership instead, so chown it to this uid.
RUN mkdir -p /data/artefacts && chown -R nexus:nexus /data

# Config should be mounted at runtime:
#   -v ./mcp-nexus.yaml:/app/mcp-nexus.yaml
# Auth token should be set via env var:
#   -e MCP_NEXUS_AUTH_TOKEN=<token>

# NOTE: docker-compose.yml overrides this with user: "1000:1000" so that artefacts and
# scripts are owned by aidan on the host. Kept as a sane non-root default for any run
# that does not set `user:`.
USER nexus

EXPOSE 8050

CMD ["node", "dist/index.js"]
