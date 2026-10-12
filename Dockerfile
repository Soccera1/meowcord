# syntax=docker/dockerfile:1

FROM golang:1.25-alpine AS sfu-build
WORKDIR /src
COPY extra/pion-sfu/go.mod extra/pion-sfu/go.sum ./
RUN go mod download
COPY extra/pion-sfu/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/pion-sfu .

FROM alpine:3.22 AS sfu
RUN mkdir -p /run/sfu && chown 1000:1000 /run/sfu
COPY --from=sfu-build /out/pion-sfu /usr/local/bin/pion-sfu
USER 1000:1000
ENV WRTC_PORT=50000 PION_SFU_IPC=/run/sfu/sfu.sock
ENTRYPOINT ["/bin/sh", "-c", "exec pion-sfu -ip \"${WRTC_PUBLIC_IP:?set WRTC_PUBLIC_IP}\" -port \"$WRTC_PORT\" -ipc \"$PION_SFU_IPC\" ${PION_SFU_VERBOSE:+-verbose}"]

FROM node:26-slim AS dependencies
COPY --from=oven/bun:1.4-slim /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY patches patches
RUN bun install --frozen-lockfile

FROM dependencies AS production-dependencies
RUN rm -rf node_modules && bun install --frozen-lockfile --production

FROM dependencies AS build
COPY scripts/vencord.js scripts/vencord.js
COPY client client
RUN VENCORD_DIR=/tmp/vencord bun scripts/vencord.js && rm -rf /tmp/vencord
COPY tsconfig.json ./
COPY src src
COPY scripts/default-avatars.js scripts/dist-tsconfig.json scripts/
COPY assets/icon.png assets/icon.png
COPY assets/public/branding assets/public/branding
RUN bun run build:src

FROM oven/bun:1.4-slim AS server
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    CONFIG_PATH=/data/state/config.json \
    STORAGE_LOCATION=/data/storage \
    PION_SFU_IPC=/run/sfu/sfu.sock \
    WRTC_LIBRARY=pion
COPY package.json ./
COPY --from=production-dependencies /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --chown=bun:bun assets assets
COPY --from=build --chown=bun:bun /app/assets/vencord assets/vencord
COPY client/release.json client/release.json
COPY scripts/client-release.js scripts/client.js scripts/e2ee-anchors.js scripts/clan-badges.js scripts/compress-client.js scripts/docker-configure.js scripts/
COPY scripts/ops/operator.mjs scripts/ops/database-transfer.mjs scripts/ops/
COPY docker/entrypoint.sh docker/
ARG REVISION=""
ARG REVISION_TIME="0"
RUN if [ -n "$REVISION" ]; then printf '{"rev":"%s","lastModified":%s}\n' "$REVISION" "$REVISION_TIME" > .rev; fi \
    && mkdir -p /data/state /data/storage /data/client /run/sfu \
    && ln -s /data/client/cache assets/cache \
    && ln -s /data/client/cache_compressed assets/cache_compressed \
    && chown -R bun:bun /data /run/sfu
USER bun
EXPOSE 3001
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["server"]
