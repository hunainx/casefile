# Stage 1: Build dependencies and tools
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Enable corepack and prepare pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

# Copy workspace configs
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/policy/package.json ./packages/policy/
COPY packages/db/package.json ./packages/db/
COPY packages/audit/package.json ./packages/audit/
COPY packages/storage/package.json ./packages/storage/
COPY packages/mock-provider/package.json ./packages/mock-provider/
COPY packages/mcp/package.json ./packages/mcp/
# pnpm applies patches/ during install (pnpm-workspace.yaml patchedDependencies)
COPY patches/ ./patches/
# D135: xlsx is installed from the vendored SheetJS tarball (the lockfile pins its sha512)
COPY vendor/ ./vendor/

# Install dependencies with frozen lockfile
RUN pnpm install --frozen-lockfile

# Copy source trees
COPY apps/api/ ./apps/api/
COPY packages/ ./packages/
# BIGDATA-4: the ingest CLI (triage, queue, workers) runs from the same image as Cloud Run job tasks.
COPY tools/ingest-cli/src/ ./tools/ingest-cli/src/
COPY matter.config.ts ./

# Stage 2: Production runtime
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

# Create unprivileged non-root user
RUN groupadd -r -g 10001 casefile && \
    useradd -r -u 10001 -g casefile -m -s /bin/bash casefile

# Copy built application
COPY --from=builder --chown=casefile:casefile /app /app

# Run as non-root user
USER casefile

EXPOSE 8080

CMD ["node", "./node_modules/tsx/dist/cli.mjs", "apps/api/src/server.ts"]
