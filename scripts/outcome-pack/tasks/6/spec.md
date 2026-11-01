# 6 — Persisted completion result

Stratum: persistence/replay.

Change only `result.mjs`. Export `result(names)` for an array of strings. Trim JavaScript whitespace and NFC-normalize each name, discard empty names, remove duplicates preserving first occurrence order, and return exactly `saved: <names joined by comma and space>\n`. An empty result list renders `saved: nobody\n`. Preserve case and Unicode. An equivalent algorithm is permitted. Leave `check.mjs` and `package.json` unchanged; `npm test` is the ordinary check.

The fixture edits through the real product tools, checks through Bash, and obtains the result for `["alice", "bob"]`. The built product emits that result once, then performs manual compaction through its normal command road. The runner exits and cold-resumes the same session, then reattaches. Delivered bytes must survive unchanged and the retained result must occur once in the product's replayed record, not be recreated by another model answer. The evaluator checks the delivered function and actual retained result identity/count. It does not accept the agent's assertion that persistence worked and does not seed a completed transcript.

Controls are unified patches against the committed seed with a/ and b/ prefixes, changing only result.mjs. No dependencies or extra delivered files are needed. A byte change after acceptance invalidates the earlier acceptance.
