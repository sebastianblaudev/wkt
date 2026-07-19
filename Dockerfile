# InstaPods / generic container deploy for the walkie-talkie server.
# Build context is the repo root.
FROM node:20-alpine

WORKDIR /app

# Install prod deps only (devDeps are for local tests/build, not needed at runtime).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy server source (CommonJS .cjs files + static admin/app assets).
COPY server.cjs ./
COPY ai.cjs ./
COPY schema.sql ./
COPY scripts ./scripts
COPY admin.html admin.js style.css gps-admin.js gps-admin.html ./ 2>/dev/null || true
COPY public ./public 2>/dev/null || true

# The server reads PORT from the environment (InstaPods sets it).
ENV PORT=3000
EXPOSE 3000

# Healthcheck so the platform can detect a dead process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["node", "server.cjs"]
