# 1 — Ordered labels

Stratum: parser.

Change only `labels.mjs`. Export `parseLabels(input)`, accepting a string of comma-separated labels. Trim JavaScript whitespace around each label; discard empty labels; normalize each remaining label to NFC; remove duplicates after normalization, preserving the first occurrence order. Matching is case-sensitive. Preserve non-ASCII characters, including supplementary code points. Empty or whitespace-only input returns an empty array. No sorting, lowercasing or other rewriting is permitted. A different algorithm with the same results is valid.

Examples:

- ` b, a,b,, c ` becomes `["b","a","c"]`.
- `e\u0301,é,É,東京,🙂,東京` becomes `["é","É","東京","🙂"]`.
- `, \t ,` becomes `[]`.

Leave `check.mjs` and `package.json` unchanged. The ordinary check is `npm test`; independent acceptance exercises more inputs than that check. No dependencies or additional delivered files are needed.

Controls are unified patches relative to the committed seed, with `a/` and `b/` path prefixes. Each patch changes only `labels.mjs`. The controller materializes patch contents outside the task repository, then applies the change through the built product's Read and Edit tools, runs `npm test` through Bash and obtains a settled outcome. The evaluator checks delivered bytes and runtime results, not the final answer. A later byte change invalidates the previous acceptance even if a new evaluation could accept it.
