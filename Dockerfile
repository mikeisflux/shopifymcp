# ─── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# Install all deps (including dev) using the lockfile for reproducibility.
COPY package.json package-lock.json* ./
RUN npm ci

# Compile TypeScript.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies so only production deps are copied into the runtime.
RUN npm prune --omit=dev

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy the pruned node_modules and compiled output only.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Create the state dir owned by the unprivileged runtime user. A named volume
# mounted at /data is seeded from this path's ownership when it is first created,
# so the `node` user can write auction/order-sync/tracking state and job records.
# Without this the volume defaults to root-owned and every state save hits EACCES.
RUN mkdir -p /data && chown node:node /data

# Run as the built-in unprivileged `node` user.
USER node

EXPOSE 3000

# Health check hits the unauthenticated /healthz endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
