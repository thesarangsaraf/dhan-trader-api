# ==============================================================================
# Production Dockerfile for Dhan Trader Backend API (NestJS / TypeScript)
# Target Deployment: GCP Cloud Run (Serverless Container)
#
# Size Optimizations:
# - Multi-stage build separation (Builder -> Prod-Deps -> Runner)
# - Ultra-lightweight Alpine Linux base (node:22-alpine)
# - Zero development dependencies in runtime layer (tsc, @types, ts-node omitted)
# - Stripped npm cache and unused build artifacts
#
# Production & Security Readiness:
# - Unprivileged non-root execution (USER node)
# - Cloud Run standard environment configuration (PORT=8080, HOST=0.0.0.0)
# - Proper PID 1 process supervision & SIGTERM propagation via dumb-init
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Build & Compile TypeScript
# ------------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests and TypeScript configuration
COPY package.json package-lock.json tsconfig.json ./

# Install all dependencies (including devDependencies needed for compiling)
RUN npm ci --ignore-scripts

# Copy application source code
COPY src/ ./src/

# Compile TypeScript into production JavaScript under /app/dist
RUN npm run build

# ------------------------------------------------------------------------------
# Stage 2: Install Production Dependencies Only
# ------------------------------------------------------------------------------
FROM node:22-alpine AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./

# Install only runtime dependencies and clean npm cache immediately
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# ------------------------------------------------------------------------------
# Stage 3: Minimal Production Runtime
# ------------------------------------------------------------------------------
FROM node:22-alpine AS runner

# Install dumb-init for clean UNIX signal forwarding (SIGTERM / SIGINT)
RUN apk add --no-cache dumb-init

WORKDIR /app

# Configure default Cloud Run environment variables
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

# Copy production node_modules from prod-deps stage
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules

# Copy compiled JavaScript output from builder stage
COPY --from=builder --chown=node:node /app/dist ./dist

# Copy package metadata
COPY --chown=node:node package.json ./

# Enforce non-root execution
USER node

# Expose default Cloud Run container port
EXPOSE 8080

# Forward signals properly to Node.js for graceful termination during scale-down
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/main.js"]
