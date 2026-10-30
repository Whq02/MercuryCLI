ARG BUILDER_IMAGE=docker.io/oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
ARG RUNTIME_IMAGE=docker.io/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587

FROM ${BUILDER_IMAGE} AS builder
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
WORKDIR /srv/mercury-source
COPY package.json bun.lock bunfig.toml ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY . .
RUN --mount=type=cache,target=/srv/mercury-source/vendor/node \
    --mount=type=cache,target=/srv/mercury-source/vendor/brush \
    --mount=type=cache,target=/srv/mercury-source/vendor/pyright \
    --mount=type=cache,target=/srv/mercury-source/vendor/debugpy \
    --mount=type=cache,target=/srv/mercury-source/vendor/js-debug \
    --mount=type=cache,target=/srv/mercury-source/vendor/grammars \
    bun run scripts/vendor/fetch-node.ts --platform linux-x64 \
 && bun run scripts/vendor/fetch-brush.ts --platform linux-x64 \
 && bun run scripts/vendor/fetch-pyright.ts \
 && bun run scripts/vendor/fetch-debugpy.ts \
 && bun run scripts/vendor/fetch-js-debug.ts \
 && bun run scripts/vendor/fetch-grammars.ts \
 && bun run build.ts --target linux-x64 \
 && rm dist/splash.mjs dist/splash-core.mjs

FROM ${RUNTIME_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git procps && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1000 --shell /bin/bash mercury \
 && mkdir -p /work \
 && chown mercury:mercury /work \
 && git config --system --add safe.directory /work
COPY --from=builder --chown=mercury:mercury /srv/mercury-source/dist /opt/mercury
RUN printf '#!/bin/sh\nexec /opt/mercury/vendor/node/bin/node /opt/mercury/mercury.mjs "$@"\n' > /usr/local/bin/mercury \
 && chmod 755 /usr/local/bin/mercury
ENV MERCURY_CONFIG_DIR=/home/mercury/.mercury \
    PATH=/opt/mercury/vendor/node/bin:${PATH}
USER mercury
WORKDIR /work
ENTRYPOINT ["mercury"]
CMD ["run"]
