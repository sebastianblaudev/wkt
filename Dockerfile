# InstaPods / generic container deploy for the walkie-talkie server.
# Build context is the repo root.
FROM node:20-alpine

WORKDIR /app

# Install prod deps only (devDeps are for local tests/build, not needed at runtime).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy server source and all frontend assets
COPY server.cjs ai.cjs schema.sql mock_db.cjs ./
COPY scripts ./scripts
COPY index.html app.js admin.html admin.js style.css landing.html superadmin.html superadmin.js gps.html ./
COPY dist ./dist
COPY public ./public

# The server reads PORT from the environment (InstaPods sets it).
ENV PORT=3000
EXPOSE 3000

# Healthcheck so the platform can detect a dead process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["node", "server.cjs"]
