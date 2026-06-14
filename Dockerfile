# ─── Build Stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install --ignore-scripts

COPY src/ ./src/
RUN npx tsc

# ─── Runtime Stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Create non-root user
RUN addgroup -S nexus && adduser -S nexus -G nexus

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && \
    npm cache clean --force

COPY --from=builder /app/dist/ ./dist/

# Config should be mounted at runtime:
#   -v ./mcp-nexus.yaml:/app/mcp-nexus.yaml
# Auth token should be set via env var:
#   -e MCP_NEXUS_AUTH_TOKEN=<token>

USER nexus

EXPOSE 8050

CMD ["node", "dist/index.js"]
