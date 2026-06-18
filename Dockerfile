# ─── Build Stage ───────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install --ignore-scripts

COPY src/ ./src/
RUN npx tsc

# ─── Runtime Stage ────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

WORKDIR /app

# libgomp1 is required by ONNX Runtime (used by @xenova/transformers for built-in embeddings)
RUN apt-get update && \
    apt-get install -y --no-install-recommends libgomp1 && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r nexus && useradd -r -g nexus nexus

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && \
    npm cache clean --force

COPY --from=builder /app/dist/ ./dist/

# Volume for caching downloaded embedding models (built-in provider)
VOLUME ["/app/data/model-cache"]
ENV TRANSFORMERS_CACHE=/app/data/model-cache

# Config should be mounted at runtime:
#   -v ./mcp-nexus.yaml:/app/mcp-nexus.yaml
# Auth token should be set via env var:
#   -e MCP_NEXUS_AUTH_TOKEN=<token>

USER nexus

EXPOSE 8050

CMD ["node", "dist/index.js"]
