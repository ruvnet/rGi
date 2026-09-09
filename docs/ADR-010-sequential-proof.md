# ADR 010: Replayable sequential learning receipts

Status: accepted for the research runtime.

## Problem

A final accuracy number does not establish whether an agent retained learning through a restart. It also hides task substitutions, restored state changes and omitted requests. We need a portable record whose internal consistency and scores can be checked without running the agent again.

## Decision

The host produces a version 1 mission proof with a complete evidence specification and a hash chained event log. The specification binds an artifact SHA256 declaration, training examples, transfer queries, retention queries and resource ceilings. Its module path is excluded because paths are machine specific. The producer must independently verify the source artifact before execution. A declaration in a proof is not execution attestation.

Three arms execute in order: baseline, reset and retained. Each begins, learns on the declared examples, takes a snapshot and restarts. Only the retained arm restores its recorded snapshot. Every arm then predicts each transfer query and each retention query in specification order, and ends with its host request count. The baseline artifact's behavior must be frozen by its implementation; the proof alone cannot establish that property.

The first event references SHA256 of the canonical version and specification. Every event binds its sequence, previous hash, arm, kind and payload. Subsequent replay validates the complete chain and the exact control flow, then recomputes correctness by comparing canonical output values. No prediction call payload includes the expected answer. The final evidence artifact includes answers for retrospective public replay and must remain private until the audit is consumed.

Canonical serialization accepts only plain data: null, booleans, finite numbers, strings, plain objects and dense arrays. It rejects proxies, accessors, hidden properties, symbols, functions, undefined values, cycles and unusual prototypes. Keys use deterministic UTF16 ordering with JavaScript JSON numeric and string encoding. This is a specified local encoding, not a claim of RFC 8785 compatibility. Limits are 64 nesting levels, 100,000 values and 8 MiB per canonical document.

Every example phase contains 1 to 256 examples. Canonical inputs must be unique within training and across both audit phases. Training inputs cannot equal transfer or retention inputs under canonical encoding. Changing the expected output does not make a repeated input independent. Query similarity or conceptual leakage cannot be established through hashing. The ledger and independent task owner must additionally prevent reuse and hidden familiarity. Logs contain at most 4,096 events. Snapshot state and request data respect the declared message cap.

The host counts learning and snapshot as two requests, plus one restore for the retained arm and one request per prediction. Each arm obeys the same request ceiling; the retained arm pays for its extra restore. These are protocol operation counts, not verified inference cost, energy, elapsed time or tokens. Different numbers of requests do not imply equal cost. Timeout and message ceilings are declarations checked by replay and must be enforced by the execution host.

## Optional identity binding

An Ed25519 envelope signs a domain separated canonical proof. Verification requires a public key supplied externally by the verifier. The artifact cannot establish trust by carrying its own key. A valid signature identifies the holder of the signing key and detects later modification. It does not prove that the signer ran the artifact, used an isolated environment or reported truthful outcomes.

## Evidence scope

Replay reports transfer and retention counts for each arm. `retainedImproves` means strictly more correct transfer outputs than the reset arm. `retentionPassed` means the retained arm is at least as accurate on retention queries as both comparison arms. These predicates are descriptive counts. They provide no confidence interval, generalization guarantee, causal attribution, statistical promotion or evidence of AGI.

Independent reserved tasks, a trustworthy isolated producer, equal verified inference budgets and sufficiently powered paired analysis remain required for a capability claim. The useful result here is a checkable record of the declared experiment.

## Validation and acceptance

Tests reject chain tampering, truncation, reordered arms, substituted training and query inputs, disclosed answer fields, altered restore state, falsified request counts, invalid numeric values, oversized snapshots and mismatched signers. Acceptance requires replay to recover the recorded counts, reject any changed signed payload under the pinned key and report retention regressions even when transfer improves.
