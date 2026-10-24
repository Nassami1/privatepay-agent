#!/usr/bin/env sh
# Build the policy contract to wasm and copy it next to the source.
# Requires a Rust toolchain with the wasm32-unknown-unknown target (near-sdk 5.29 needs rustc >= 1.95).
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT/contracts/policy"
if [ -d "$ROOT/.toolchain/cargo/bin" ]; then
  export RUSTUP_HOME="$ROOT/.toolchain/rustup"
  export CARGO_HOME="$ROOT/.toolchain/cargo"
  export PATH="$CARGO_HOME/bin:$PATH"
fi
cargo build --target wasm32-unknown-unknown --release
mkdir -p build
cp target/wasm32-unknown-unknown/release/privatepay_policy.wasm build/privatepay_policy.wasm
printf 'built %s (%s bytes)\n' "contracts/policy/build/privatepay_policy.wasm" "$(wc -c < build/privatepay_policy.wasm)"
