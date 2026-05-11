# ============================================================
# Dockerfile — NestJS Backend (multi-stage build)
# ============================================================

# ── Stage 1: Build ───────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace manifests
COPY package*.json ./
COPY backend/package*.json ./backend/
COPY shared/package*.json ./shared/

# Install all deps (including devDeps for build)
RUN npm ci --workspace=backend --workspace=shared

# Copy source
COPY shared/ ./shared/
COPY backend/ ./backend/

# Generate Prisma client
RUN cd backend && npx prisma generate

# Build TypeScript
RUN npm run build --workspace=backend

# ── Stage 2: Production image ─────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Only production deps
COPY package*.json ./
COPY backend/package*.json ./backend/
COPY shared/package*.json ./shared/
RUN npm ci --workspace=backend --workspace=shared --omit=dev

# Copy built output + Prisma schema
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/prisma ./backend/prisma
COPY --from=builder /app/shared ./shared

# Generate Prisma client in production image
RUN cd backend && npx prisma generate

# Also copy the Prisma generated client to node_modules
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

EXPOSE 3001

# Use absolute paths to avoid working directory confusion
CMD ["sh", "-c", "npx prisma db push --schema=/app/backend/prisma/schema.prisma --accept-data-loss && node /app/backend/dist/main"]
