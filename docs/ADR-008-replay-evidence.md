# ADR 008: Replay evidence in the RVF container

Status: implemented

Date: 2026 09 09

## Decision

Store experiment replay material as a genuine RVF v1 container. Use the existing RVForge segment and root page layout, with a narrowly defined rGi metadata payload. The file contains data only. Reading it never loads code, invokes tools, grants capabilities or imports a runtime checkpoint automatically.

RVM names the RuVector virtual machine and its execution contract. The pinned RVM source consumes `.rvf` containers; it does not define a separate `.rvm` serialization format. Consequently this implementation does not rename JSON or executable bytes to `.rvm`.

## Source authority

The format is pinned to [RuVector edaffffb3b85768eb1f3ec1f683b7f46f0506af4](https://github.com/ruvnet/RuVector/tree/edaffffb3b85768eb1f3ec1f683b7f46f0506af4). The relevant source files are [the segment writer](https://github.com/ruvnet/RuVector/blob/edaffffb3b85768eb1f3ec1f683b7f46f0506af4/npm/packages/rvforge/src/rvf-writer.ts), [root and header parser](https://github.com/ruvnet/RuVector/blob/edaffffb3b85768eb1f3ec1f683b7f46f0506af4/npm/packages/rvforge/src/rvf.ts), and [file validator](https://github.com/ruvnet/RuVector/blob/edaffffb3b85768eb1f3ec1f683b7f46f0506af4/npm/packages/rvforge/src/validate.ts).

RVM inspection semantics are pinned to [0973d77e5a9e99065376e8ef772a4a1d16e88c75](https://github.com/ruvnet/rvm/tree/0973d77e5a9e99065376e8ef772a4a1d16e88c75), specifically [rvm-rvf](https://github.com/ruvnet/rvm/blob/0973d77e5a9e99065376e8ef772a4a1d16e88c75/crates/rvm-rvf/src/lib.rs) and its [segment walker](https://github.com/ruvnet/rvm/blob/0973d77e5a9e99065376e8ef772a4a1d16e88c75/crates/rvm-rvf/src/container.rs).

## Binary layout

| Component | Representation |
| --- | --- |
| Segment 1 | META type 0x07; canonical JSON envelope with schema `rgi.replay-evidence/1` and payload |
| Segment 2 | MANIFEST type 0x05; schema `rgi.evidence-manifest/1`, empty capabilities, payload identity and size |
| Segment header | 64 bytes; magic 0x52564653 serialized little endian; monotonic IDs 1 and 2 |
| Segment checksum | SHAKE256 first 16 bytes, upstream algorithm ID 2 |
| Segment alignment | Explicit zero padding to the next 64 byte boundary |
| Root page | 4096 bytes at EOF, magic 0x52564d30, Level 1 pointer and CRC32C |
| Artifact identity | SHA256 of complete container bytes, published separately by the experiment harness |

The metadata payload is an application schema, not the upstream binary witness schema. The manifest holds a full SHA256 of the envelope. The file ID is its first 16 bytes. Timestamps are zero to make identical logical evidence produce identical bytes. Actual experiment timestamps belong inside the evidence payload.

The fixed container overhead is approximately 4.6 KiB plus JSON envelope bytes. No compression is used, avoiding decompression bombs and optional codec dependencies. SHA256 is computed once for the envelope and reused for its manifest and file ID. Payload verification uses built in native cryptographic primitives.

## Compatibility and RVM boundary

The test suite compiles and runs five unmodified upstream RVForge source files after verifying their Git blob identities. rGi output must equal the pinned upstream writer byte for byte, and the actual upstream file validator must accept it with deep hashing enabled. The MIT license and provenance accompany the test oracles.

The complete file follows RVForge's final root page convention. RVM's pinned low level `container::walk` accepts the aligned segment stream only and does not skip a raw root page at EOF. `rvmEvidenceSegments()` first validates the complete rGi profile, then returns an owned copy of the segment area for that inspection boundary. It does not claim that the RVM executable loader has run the experiment. A consumer that needs the RVForge root page should use the complete file instead.

The stream may be saved as `mission.rvm.rvf`, preserving its actual RVF format. `unpackRvmEvidence()` validates its bounds and inventory, reconstructs the deterministic root page and applies the same strict application decoder. Neither a complete container passed to the stream decoder nor a stream passed to the complete container decoder is accepted accidentally.

`scripts/verify-rvm-format.ts` compiles the actual pinned upstream Rust structural parser against the generated stream. The source blob IDs are checked first; the executed walker, header and footer functions remain unchanged. The script supplies only structural error types, omitting upstream tests and the unused signature message builder. The positive stream must be accepted and corrupt magic and oversized lengths must be rejected. This additional oracle has no Cargo dependency and explicitly reports that full RVM verification and execution were not performed.

No independent RVM image, boot module, hardware attestation or capability grant is produced. A future signed executable replay capsule requires a separate execution contract, trusted signing keys and actual RVM validation tests before those claims can be made.

## Reader invariants

The reader accepts exactly two unsigned, uncompressed, nonexecutable segments with the expected types and IDs. Unsupported flags, nonzero reserved fields, timestamps, trailing bytes, missing padding and oversized lengths fail closed. It verifies segment hashes, the exact manifest, the exact root page and canonical UTF8 JSON before exposing the payload. This is a reader for the rGi evidence profile, not a general purpose RVF editor; it rejects unknown segments instead of silently dropping them.

The envelope is limited to 16 MiB, nesting depth 64 and 500000 JSON values plus object keys. A lexical scan enforces allocation limits before JSON parsing creates the value graph. Unsupported objects, nonfinite numbers, getters, cycles, sparse arrays and silently omitted values are rejected. Shared backing buffers are rejected. Parsing takes an owned snapshot of caller bytes. Duplicate JSON keys and alternative encodings fail canonical validation even when their checksums were recomputed.

## What the evidence proves

Checksums detect corruption. A separately trusted SHA256 establishes the exact bytes an observer received. Neither an embedded digest nor an unsigned container authenticates the publisher: an attacker can replace the evidence and recompute every embedded hash. The container codec generates no signing keys. The mission payload may carry a separate Ed25519 signed proof whose verifier requires an externally supplied public key. A demonstration key generated by a local benchmark does not establish independent evaluator identity.

The 128 bit truncated segment hash has a generic collision bound of approximately 64 bits. The full SHA256 manifest and externally anchored artifact digest provide stronger content binding. None of these hashes proves that task outcomes are true, that hidden tasks were independent, that costs were honestly reported, or that AGI was achieved.

Replay software must independently recompute task scoring, checkpoint relationships, resource totals and promotion decisions from the payload. Reading evidence is never permission to replay external side effects. Synthetic runs remain explicitly marked as synthetic, and unavailable verification steps must remain unavailable rather than being relabeled as passing.

## Acceptance test

Run `node --test tests/evidence-container.test.ts`. The file must round trip deterministically, match the pinned upstream writer, pass the upstream file validator, and reject mutations in every header byte plus payload, padding, manifest and root regions. Then use the mission replay command to recompute the experiment's result from the received artifact, checking a separately published digest first.
