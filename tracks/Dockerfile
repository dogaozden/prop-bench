FROM rust:1.92.0-bookworm@sha256:e90e846de4124376164ddfbaab4b0774c7bdeef5e738866295e5a90a34a307a2 AS validator-build

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src/lib.rs src/replay.rs src/validate.rs ./src/
COPY src/bin/propbench-validate.rs ./src/bin/

# Owner commands and their source are excluded from this build, not hidden by a
# wrapper. Cargo.lock freezes the logic-core dependency to the reviewed commit.
# Whole-program LTO drops unused dependency code and its source-path constants.
# Inspect before copying the executable: no solver/generator may survive linking.
RUN test ! -e src/main.rs && test ! -e src/golf.rs \
    && CARGO_PROFILE_RELEASE_LTO=true cargo build --locked --release --no-default-features --bin propbench-validate \
    && nm -C target/release/propbench-validate > /tmp/validator-symbols \
    && if grep -E 'propbench::golf|logic_core::services::(generator|tree_gen|obfuscate_gen|planted_gen|proof_search|prover|cheese|serve_filter)::' /tmp/validator-symbols; then exit 1; fi \
    && strings target/release/propbench-validate > /tmp/validator-strings \
    && if grep -E 'Plant golf candidates|out-key|answer-key|planted_gen' /tmp/validator-strings; then exit 1; fi

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251

LABEL org.propbench.frontier-runtime="3"

# The owner builds this image explicitly. Runtime execution always uses
# --pull=never and the immutable image ID obtained from local inspection.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      clang \
      coreutils \
      dash \
      diffutils \
      file \
      findutils \
      gawk \
      grep \
      jq \
      lld \
      make \
      nodejs \
      npm \
      pkg-config \
      python3 \
      python3-venv \
      ripgrep \
      sed \
    && rm -rf /var/lib/apt/lists/*

COPY --from=validator-build /build/target/release/propbench-validate /opt/propbench/validator
RUN chmod 0555 /opt/propbench/validator

WORKDIR /workspace
