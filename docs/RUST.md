# Rust policy kernel

`rgi-core` is a pure, deterministic policy evaluator shared by the WASM and Node native wrappers. It does not run agents or claim general intelligence. The TypeScript runtime owns lifecycle, adapter invocation, accounting, and persistence.

## Contract

`evaluate_json(&str) -> Result<String, String>` accepts strict camelCase JSON:

```json
{"capability":"world.observe","allowedCapabilities":["world.observe"],"spentMicros":20,"reservedMicros":30,"requestedMicros":50,"budgetMicros":100,"confidence":0.9,"minConfidence":0.8,"stopped":false}
```

Result: `{"allowed":true,"reason":"allowed"}`. Decision precedence is stopped, capability_denied, invalid_confidence, budget_exhausted, allowed. Below threshold confidence uses `invalid_confidence` as well as nonfinite or out of range confidence. Capabilities match exactly, with no wildcard semantics.

Input JSON is bounded to 65,536 bytes. Identifiers contain 1 to 128 ASCII alphanumeric or `_.:/-` bytes; the allowlist has at most 256 entries. Missing, unknown, duplicate, mistyped, fractional, negative, oversized, and nonfinite numeric JSON fields fail parsing. Costs use u64 and checked addition. JavaScript callers must use safe integers no greater than `Number.MAX_SAFE_INTEGER` to avoid precision loss before serialization.

## Build and verify

```sh
cargo test -p rgi-core --locked
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build -p rgi-napi --release --locked
cargo build -p rgi-wasm --release --target wasm32-unknown-unknown --locked
cargo run -p rgi-core --release --example bench --locked
```

The NAPI library exports `evaluateJson(string): string`. On Linux, copy the compiled `target/release/librgi_napi.so` to a `.node` artifact for Node loading, or package it with the NAPI CLI. The WASM library exports `evaluate_json(string): string` after generating JavaScript glue using `wasm-bindgen-cli` version 0.2.104, matching its pinned crate:

```sh
cargo install wasm-bindgen-cli --version 0.2.104 --locked
wasm-bindgen target/wasm32-unknown-unknown/release/rgi_wasm.wasm --target nodejs --out-dir target/wasm-node
```

Use `--target web` for browser glue. Raw Rust WASM cannot be called with JavaScript strings without this glue. The native binding targets Node API 6; it remains the same pure policy kernel, not an OS sandbox.

## Trust boundary

An allowed decision does not reserve budget or authorize arbitrary code. The runtime must serialize check and reservation, prevent mutation of the evaluated request, enforce capabilities at invocation, account actual costs, and honor stop signals independently. This kernel trusts the supplied snapshot; untrusted agents must not control budget or allowedCapabilities. It cannot stop a hung adapter or guarantee bounded execution. Model confidence is a supplied value, not independently calibrated assurance.

Primary binding references: [NAPI-RS](https://napi.rs/docs/introduction/getting-started), [wasm-bindgen](https://wasm-bindgen.github.io/wasm-bindgen/).

## Initial validation

On 2026-09-08, Rust 1.90.0 on this Linux x86_64 development host passed all 11 core unit tests, including a 1,296-case u128 budget oracle, strict JSON validation, stopping, default deny, overflow, and nonfinite confidence tests. Formatting and workspace Clippy with warnings denied passed. Release builds for native NAPI and wasm32-unknown-unknown passed.

The local JSON microbenchmark ran 100,000 evaluations in 62,369,925 ns, mean 623 ns. This is an illustrative shared-host microbenchmark, not a stable latency SLO, end-to-end runtime measurement, or intelligence benchmark. Re-run on deployment hardware; compare accepted task outcomes and total cost independently.
