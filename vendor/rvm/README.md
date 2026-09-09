# Pinned RVM structural inspection oracle

The source files are unmodified copies from [RVM commit 0973d77e5a9e99065376e8ef772a4a1d16e88c75](https://github.com/ruvnet/rvm/tree/0973d77e5a9e99065376e8ef772a4a1d16e88c75/crates/rvm-rvf/src).

| Source | Upstream Git blob |
| --- | --- |
| container.rs | bdf5b15668499147c504cee67caecb8eba9fc7c7 |
| format.rs | 4f975c3c029d894b9665de30d77f14b8db4eb07b |

The pinned upstream workspace declares `MIT OR Apache-2.0` and attributes its authors as RuVector Contributors in its Cargo metadata. This vendoring selects the MIT license. The upstream tree has no standalone LICENSE file. The standard MIT text with attribution is supplied here, and the original workspace manifest is retained as licensing provenance.

`scripts/verify-rvm-format.ts` checks both Git blob identities before compilation. It extracts the upstream container walker, header parser, footer parser, constants and alignment helpers unchanged, omitting only upstream tests and the unused signature message builder. A small local error enum supplies the structural error variants so this inspection oracle needs no external crates. It compiles those actual parsing functions with the pinned Rust compiler and inspects the generated mission segment stream. Corrupt magic and oversized payload lengths must fail in the upstream parser.

The oracle proves compatibility with those executed structural parsing functions. It does not invoke the full RVM verifier, capability installation, signature validation, a WASM guest or the microhypervisor. Application hashes and schema are checked by rGi before structural inspection. This scope is also present in the machine readable report.
