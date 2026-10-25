#!/usr/bin/env sh
# Build both contracts to wasm and copy them next to their sources.
# Requires Rust with wasm32-unknown-unknown (near-sdk 5.29 needs rustc >= 1.95).
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -d "$ROOT/.toolchain/cargo/bin" ]; then
  export RUSTUP_HOME="$ROOT/.toolchain/rustup"
  export CARGO_HOME="$ROOT/.toolchain/cargo"
  export PATH="$CARGO_HOME/bin:$PATH"
fi
export CARGO_TARGET_DIR="$ROOT/contracts/target"

cd "$ROOT/contracts/policy"
cargo build --target wasm32-unknown-unknown --release
mkdir -p build
cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/privatepay_policy.wasm" build/privatepay_policy.wasm

cd "$ROOT/contracts/test-ft"
cargo build --target wasm32-unknown-unknown --release
mkdir -p build
cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/privatepay_test_ft.wasm" build/privatepay_test_ft.wasm

printf 'policy %s bytes\n' "$(wc -c < "$ROOT/contracts/policy/build/privatepay_policy.wasm")"
printf 'token  %s bytes\n' "$(wc -c < "$ROOT/contracts/test-ft/build/privatepay_test_ft.wasm")"
