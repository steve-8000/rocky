# syntax=docker/dockerfile:1.7-labs
###############################################################################
# amaze — pi image
#
# Stages:
#   natives-builder — Rust + Bun → pi_natives.linux-<arch>.node
#   wheel-builder   — amaze_rpc Python wheel
#   amaze-base         — python + bun + rustup launcher + natives + amaze_rpc
#                     + /usr/local/bin/amaze shim
#   amaze-runtime      — amaze-base + amaze source + bun install      (DEFAULT, runnable)
#
# Build:
#     docker build -t amaze/amaze:dev .                          # default = amaze-runtime
#     docker build --target amaze-base -t amaze/amaze-base:dev .    # base for derived images
#
# Run:
#     docker run --rm amaze/amaze:dev --help
#     docker run --rm -it -v "$PWD":/work amaze/amaze:dev cli    # interactive amaze
#
# Consume as a base in another Dockerfile (see Dockerfile.rocky):
#     ARG AMAZE_BASE=amaze/amaze:dev
#     FROM ${AMAZE_BASE} AS amaze-base
###############################################################################

ARG BUN_VERSION=1.3.14

############################
# 1) natives-builder — Rust + Bun → pi_natives.linux-<arch>.node
############################
FROM rust:1.86-slim-bookworm AS natives-builder

ARG BUN_VERSION
ENV BUN_INSTALL=/opt/bun \
    PATH=/opt/bun/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin \
    CARGO_TERM_COLOR=never

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates pkg-config libssl-dev unzip git \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && /opt/bun/bin/bun --version

WORKDIR /amaze

# Layer 1 — manifests + lockfiles only. Source edits under packages/*/src and
# crates/*/src won't bust `bun install` below. `--parents` preserves the
# matched path under /amaze/ (requires syntax 1.7-labs).
COPY --parents \
    package.json bun.lock bunfig.toml \
    tsconfig.base.json tsconfig.json \
    Cargo.toml Cargo.lock rust-toolchain.toml \
    packages/*/package.json \
    packages/tsconfig.workspace.json \
    python/rocky/web/package.json \
    crates/*/Cargo.toml \
    /amaze/

# Layer 2 — hydrate node_modules from the manifests above.
RUN bun install --frozen-lockfile --ignore-scripts

# Layer 3 — full source. `Dockerfile.dockerignore` keeps target/, node_modules/,
# dist/, runs/, editor noise, etc. out of the context. node_modules from Layer 2
# is preserved across this COPY because it's never in the build context.
COPY . /amaze/

# Layer 4 — compile natives to a Linux N-API addon. Persistent caches keep
# repeat builds incremental: cargo's package index + git-deps + the workspace
# target dir.
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=cache,target=/amaze/target \
    set -eux; \
    rustup show; \
    bun --cwd=packages/natives run build; \
    mkdir -p /out; \
    cp packages/natives/native/amaze_natives.linux-*.node /out/

############################
# 2) wheel-builder — amaze-rpc wheel
############################
FROM python:3.12-slim-bookworm AS wheel-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip build

WORKDIR /src
COPY python/amaze-rpc /src
RUN python -m build --wheel --outdir /out

############################
# 3) amaze-base — python + bun + rustup + natives + amaze_rpc + amaze shim
#
# Sharable runtime base. Derived images (amaze-runtime below, Dockerfile.rocky)
# extend this and overlay their own source tree. Default AMAZE_ROOT=/work/amaze is
# friendly to derived images that mount a host pi checkout there; amaze-runtime
# overrides it to /amaze because its source is baked in.
############################
FROM python:3.12-slim-bookworm AS amaze-base

ARG BUN_VERSION
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    BUN_INSTALL=/opt/bun \
    AMAZE_ROOT=/work/amaze \
    CARGO_HOME=/data/cache/cargo \
    CARGO_TARGET_DIR=/data/cache/cargo-target \
    RUSTUP_HOME=/data/cache/rustup \
    PATH=/opt/bun/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git curl ca-certificates unzip openssh-client tini sqlite3 \
        build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && /opt/bun/bin/bun --version

# Rustup launcher only — the real toolchain is fetched lazily into RUSTUP_HOME
# on first cargo invocation, driven by pi's `rust-toolchain.toml`. Keeps the
# image small while sharing the toolchain across reboots when /data is mounted.
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup-bootstrap \
       sh /tmp/rustup-init.sh -y --no-modify-path --default-toolchain none --profile minimal \
    && rm -f /tmp/rustup-init.sh \
    && rm -rf /usr/local/rustup-bootstrap \
    && /usr/local/cargo/bin/rustup --version

# natives addon: pi's loader probes /opt/bun/bin as a fallback path.
COPY --from=natives-builder /out/amaze_natives.linux-*.node /opt/bun/bin/

# amaze-rpc Python wheel.
COPY --from=wheel-builder /out/*.whl /tmp/wheels/
RUN pip install /tmp/wheels/amaze_rpc-*.whl && rm -rf /tmp/wheels

# `amaze` shim — runs the coding-agent CLI against $AMAZE_ROOT via Bun. Derived
# images override AMAZE_ROOT to point at wherever their amaze source lives.
RUN printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    ': "${AMAZE_ROOT:=/work/amaze}"' \
    'if [ ! -d "$AMAZE_ROOT/packages/coding-agent" ]; then' \
    '  echo "pi: AMAZE_ROOT=$AMAZE_ROOT does not look like a pi checkout" >&2' \
    '  exit 127' \
    'fi' \
    'exec bun "$AMAZE_ROOT/packages/coding-agent/src/cli.ts" "$@"' \
    > /usr/local/bin/amaze \
    && chmod +x /usr/local/bin/amaze

############################
# 4) amaze-runtime — amaze-base + amaze source + bun install (DEFAULT)
#
# A self-contained, runnable amaze image. `docker run amaze/amaze:dev --help`
# Just Works without a host checkout.
############################
FROM amaze-base AS amaze-runtime

ENV AMAZE_ROOT=/amaze
WORKDIR /amaze

# Same manifests-only layered install pattern as natives-builder — `bun install`
# only re-runs when a package.json / lockfile changes.
COPY --parents \
    package.json bun.lock bunfig.toml \
    tsconfig.base.json tsconfig.json \
    packages/*/package.json \
    packages/tsconfig.workspace.json \
    python/rocky/web/package.json \
    /amaze/

RUN bun install --frozen-lockfile --ignore-scripts

# Pi source. `Dockerfile.dockerignore` keeps **/node_modules out of the context
# so stale isolated-linker symlinks from a host install can't shadow the
# hoisted node_modules that `bun install` just produced.
COPY . /amaze/

# Regenerate the docs index that `--ignore-scripts` skipped above. The root
# package.json's `prepare` script normally handles this on a vanilla install.
RUN bun --cwd=packages/coding-agent run generate-docs-index

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/amaze"]
CMD ["--help"]
