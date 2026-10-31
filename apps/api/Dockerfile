# Multi-stage build: compile TypeScript in a builder image, ship only JS + prod deps.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY migrations ./migrations
# Folder for STORAGE_DRIVER=local (dev). Hosted deployments should use S3-compatible storage instead.
RUN mkdir -p /app/storage && chown node:node /app/storage
USER node
EXPOSE 4000
# Uses the PORT the host assigns (Render sets its own); falls back to 4000.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT:-4000}/health/live" || exit 1
CMD ["node", "dist/main.js"]
