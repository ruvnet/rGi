# Pinned upstream RVForge compatibility oracle

The `.ts.source` files are unmodified source files from `npm/packages/rvforge/src` in [RuVector commit edaffffb3b85768eb1f3ec1f683b7f46f0506af4](https://github.com/ruvnet/RuVector/tree/edaffffb3b85768eb1f3ec1f683b7f46f0506af4/npm/packages/rvforge/src). Their MIT license is included.

The test suite verifies each source's original Git blob ID before compiling it with the repository's pinned TypeScript development dependency. It then executes the actual upstream writer and file validator. Only emitted JavaScript import locations change to resolve these pinned sources in memory. The source files themselves remain byte identical to upstream.

| Source | Upstream Git blob |
| --- | --- |
| rvf.ts | 9d4b28cdcaeceabda49f526d772b9c934ddc6760 |
| rvf-writer.ts | 568f3dd69ba9aa83cb432a5ef810ef121981bcd9 |
| validate.ts | a25345aa91c54a9881e0cd95e69aee1bbfd8c516 |
| hash.ts | e044e58c11fe7bbe4e367de1cb60f0c250d35eea |
| errors.ts | 565571d3a0d7ba80a34a3474fbf5152b513ccf96 |

These files are test oracles, not runtime dependencies. Production uses the bounded application profile in `src/evidence-container.ts`. Upstream validation checks RVF structure and whole file identity; the production reader additionally checks every payload digest, canonical application JSON and the exact allowed segment inventory.

The evidence profile grants no capabilities and contains no executable segment. Upstream acceptance proves wire compatibility with this pinned revision, not successful execution in RVM, a trusted publisher identity, or truth of an experiment.
