# 3 — Two-file limit update

Stratum: multi-file edit.

Change `config.mjs` and `view.mjs`. The named export `limit` from config.mjs must be the number 8. The named export `renderLimit` from view.mjs accepts a name, trims JavaScript whitespace and returns exactly `<name>: 8` without a newline. The empty trimmed name is rendered as `anonymous: 8`. Preserve case and Unicode. Export shapes and observable results, not a particular implementation, are required. Both modules must work independently when imported. Leave `check.mjs` and `package.json` unchanged; the ordinary check is `npm test`.

The delivery uses the product's ChangeSet preview/apply road: after both files are read and a two-file plan is prepared, the controller appends one space to view.mjs as an outside edit. Applying that old plan must refuse without changing either file; config.mjs must remain byte-identical to the seed and view.mjs must retain exactly the external edit. After fresh reads, a corrected two-file plan succeeds. The ordinary check follows. This tests the outcome, not ChangeSet crash recovery.

Controls are unified patches against the committed seed, with a/ and b/ prefixes, changing only these two modules. A valid alternative can use different expressions or imports. No extra delivered files or dependencies are needed. The controller applies the candidate to the fresh state using real tools. Acceptance checks the untouched refusal snapshot, the delivered modules and run facts, never final-answer words. A checked-byte change after acceptance invalidates that acceptance.
