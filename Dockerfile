# -----------------------------------------------------------------------------
# Integration image. Pure Node.js — no local device protocol, no Python
# bridge: every EcoFlow call is a signed HTTPS request to the EcoFlow Cloud
# API (see src/ecoflow/client.js), so a single stage is enough (compare
# gladys-lubluelu-vaccum/gladys-hydro-quebec's Python-venv builder stages,
# needed there because no JS port of the Tuya/hydroqc library existed).
#
# Gladys sandbox constraints ("the sandbox is the defense"):
#   - rootfs mounted READ-ONLY -> never write outside /data
#   - a single writable volume: /data
#   - runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see the build workflow
# -----------------------------------------------------------------------------

FROM node:26-alpine

# dumb-init: correct PID 1 signal handling (SIGTERM) for a graceful shutdown.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Install the PROD dependencies first (better build cache). --ignore-scripts:
# none of @ecoflow-api/rest-client, @ecoflow-api/schemas or
# @gladysassistant/integration-sdk need an install-time build step, so this
# is free hardening against a compromised transitive dependency running
# arbitrary code during `npm ci`.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts || npm install --omit=dev --ignore-scripts

COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json ./

ENV NODE_ENV=production
VOLUME ["/data"]

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
