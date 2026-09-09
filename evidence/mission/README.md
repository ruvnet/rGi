Replayable mission evidence, 9 September 2026. All 18 strict harness checks passed, including 122 TypeScript tests, Rust and actual binding checks, independent pinned upstream format validation, benchmarks and advisory scans. The harness source hashes bind the tested files. These final copied reports and evidence files were added after execution and are not self-hashed.

The RVF carries signed mission receipts and the reviewed agent source. Its RVM profile is still RVF and contains no executable segments. The public key is a demonstration trust anchor published with this commit; the private key was not saved. Signature validity does not establish independent evaluation or truthful execution.

Replay from the repository root:

```bash
node scripts/replay-mission.ts evidence/mission/mission.rvf evidence/mission/mission.public.pem
node scripts/replay-mission.ts evidence/mission/mission.rvm.rvf evidence/mission/mission.public.pem --rvm
```

The benchmark additionally reexecutes the embedded reviewed agent in fresh processes and matches the deterministic receipt root. The retained arm scores 24/24 transfer queries; baseline and reset score 0/24. All preserve 12/12 retention queries. This is a known rule synthetic fixture, not independent domain generalization.

Final local session comparison: 610.18 ms for 12 fresh sessions versus 66.85 ms for 1 reused session, both 24 requests. About 9.13 times faster for this process overhead test only; shared host timings vary and do not measure LLM inference.
