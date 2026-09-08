# Verification snapshot

This snapshot records the 2026-09-08 local strict verification run for the initial rGi implementation. All 12 checks passed. TypeScript tests: 32. Rust core tests: 11, including 1,296 checked arithmetic combinations. Executable binding parity: 52 cases plus one native-guarded supervisor dispatch.

The verification report hashes the exact source files evaluated before these evidence copies were added. Reports do not hash themselves. No source changes were made between that run and the evidence snapshot. GitHub CI is a separate run and must be checked separately.

The final durable no-op benchmark completed 1,000 actions at approximately 1,345 actions/second, with median 0.355ms and p95 2.437ms on the shared host. Earlier local runs ranged from 476 to 2,165 actions/second, illustrating environmental variability. Do not interpret this as model throughput, AGI capability or a production SLA.

Run `npm run harness` to regenerate current artifacts. npm and Cargo advisory checks passed at the recorded execution time, but the report does not independently establish advisory-feed freshness. Live upstream services, hardware, multi-tenant isolation and hostile plugin containment are excluded.
