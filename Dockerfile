# -----------------------------------------------------------------------------
# Integration image. Pure Node.js — no local device protocol, no Python
# bridge: every EcoFlow call is a signed HTTPS request or an MQTTS session to
# the EcoFlow cloud (see src/ecoflow/), so a single stage is enough.
#
# Gladys sandbox constraints ("the sandbox is the defense"):
#   - rootfs mounted READ-ONLY -> never write outside /data
#   - a single writable volume: /data
#   - runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see the build workflow
#
# Base image: Node 24, the LTS line the Gladys core itself runs on, pinned by
# digest so a rebuild is reproducible and every base-image security update
# arrives as a visible Dependabot PR (Dependabot bumps the digest; major Node
# versions are deliberate, see .github/dependabot.yml).
# -----------------------------------------------------------------------------

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

# dumb-init: correct PID 1 signal handling (SIGTERM) for a graceful shutdown.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Install the PROD dependencies first (better build cache), strictly from the
# lockfile: `npm ci` fails if package.json and package-lock.json disagree,
# instead of silently resolving other versions. --ignore-scripts: none of the
# runtime dependencies needs an install-time build step, so this is free
# hardening against a compromised transitive dependency running arbitrary
# code during the install.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json ./

ENV NODE_ENV=production
VOLUME ["/data"]

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
