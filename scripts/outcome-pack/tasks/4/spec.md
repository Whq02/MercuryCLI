# 4 — Bounded score and delayed check

Stratum: check/tree binding.

Change only `score.mjs`. Export `score(value)`: for a finite JavaScript number, round with Math.round, then clamp to the inclusive range 0 through 100; for all other inputs return the number 0. The result must not be negative zero. Equivalent algorithms are valid. Leave `check.mjs` and `package.json` unchanged. The ordinary check is `npm test`.

The check can be held after its assertions have passed using OUTCOME_HOLD, a controller-owned directory outside the task tree. It creates `ready` and waits for `release`. The controller runs it through the product's background Bash tool on delivered tree A, waits for ready, appends one newline to score.mjs through Edit (tree B), and only then releases the check. The late success must not verify B. After that product process ends, a fresh observer using the same persisted verification home must still find B unaccepted. A fresh ordinary check on B can verify it. This is verification-state acceptance, not the run-completion policy.

Controls are unified patches against the committed seed with a/ and b/ prefixes, changing only score.mjs. All calibration controls undergo the same delayed-completion and restart ordering. Independent acceptance checks the score function, checked-tree binding and observed run facts, never transcript prose. A later checked-byte change invalidates the old acceptance.
