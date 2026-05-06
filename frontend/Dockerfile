# ============================================================
# Dockerfile — Next.js Frontend (monorepo-aware)
# ============================================================

# ── Stage 1: Build ───────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace manifests
COPY package*.json ./
COPY frontend/package*.json ./frontend/
COPY shared/package*.json ./shared/

# Install all deps
RUN npm ci --workspace=frontend --workspace=shared

# Copy source
COPY shared/ ./shared/
COPY frontend/ ./frontend/

# Build Next.js (skip linting + type-checking for speed)
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace=frontend

# ── Stage 2: Production image ─────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Only production deps
COPY package*.json ./
COPY frontend/package*.json ./frontend/
COPY shared/package*.json ./shared/
RUN npm ci --workspace=frontend --workspace=shared --omit=dev

# Copy Next.js build output
COPY --from=builder /app/frontend/.next ./frontend/.next
COPY --from=builder /app/frontend/public ./frontend/public
COPY --from=builder /app/shared ./shared

EXPOSE 3000

CMD ["npm", "run", "start", "--workspace=frontend"]
