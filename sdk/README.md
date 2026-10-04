# mercury-sdk-draft

A draft TypeScript client for Mercury's run door. It is parked in the repository and is not published: `package.json` says `private: true`, there is no registry configuration, and nothing here talks to npm.

## What it is

- `src/rows.ts` and `src/door.ts` are generated from the tree by `scripts/sdk/generate.ts` (a tree tool beside the suite, not part of the package): the row vocabulary (`ROW_TYPES`, `PARTIAL_ROW_TYPES`, `INPUT_ROW_TYPES`, `OUTCOME_STATUSES`, `STOP_WORDS`, `ERROR_CLASSES`, `OUTCOME_EXIT_CODES`), one TypeScript type per row, the JSON schema of every row as data, and the run door's option table (`RUN_OPTIONS`, `PERMISSION_MODES`, `EFFORT_LEVELS`, `RUN_FORMATS`). The generator reads `src/rows/vocabulary.ts`, `src/types/permissions.ts`, `src/utils/effortLadder.ts` and `src/main.tsx` in the repository; the generated files carry no dependency on them, so the package stands on its own once copied out of the tree.
- `src/validate.ts` interprets those schemas at run time; `src/parse.ts` turns a stdout line into a typed row (`parseRow`, `rowOf`) or a typed reason why not (`not_json`, `unknown_type`, `schema_mismatch`, `invalid` with the field path).
- `src/client.ts` spawns the installed `mercury` (or the executable you name) with `run --format rows`, streams the rows as typed events and as an async iterator, resolves the outcome row, and surfaces the door's refusals and exit codes as typed errors (`src/errors.ts`).

The draft covers one prompt per run through `mercury run`. The runner door (`mercury runner`, JSON-RPC over stdio) and `--input rows` streaming input are not covered yet.

## Build and prove

From the repository root:

```sh
bun scripts/sdk/generate.ts            # regenerate sdk/src/rows.ts and sdk/src/door.ts from the tree
bun scripts/sdk/generate.ts --check    # exit 1 when the committed files have drifted
cd sdk && tsc -p tsconfig.json         # emit dist/ (plain ES modules and declarations)
bash scripts/sdk/run-all.sh            # the suite: a clean-copy build, the drift check, the run door driven through the package
```

The suite drives the real run door against a loopback fixture provider on a scratch config home; it never calls a live model.

## The one example

```ts
import { run, MercuryRefusal } from 'mercury-sdk-draft'

const turn = run({ prompt: 'summarise the README', cwd: '/path/to/project', mode: 'implement', effort: 'high' })
turn.on('text', row => process.stdout.write(row.text))
for await (const row of turn) {
  if (row.type === 'tool_call') console.error(`→ ${row.tool}`)
}
try {
  const outcome = await turn.outcome
  console.log(outcome.status, outcome.answer, outcome.usage, outcome.cost_usd)
} catch (error) {
  if (error instanceof MercuryRefusal) console.error(`refused (${error.errorClass}, exit ${error.exit?.code}): ${error.message}`)
  else throw error
}
```

`run()` returns a `MercuryRun`: `outcome` resolves with the outcome row the door wrote (any status but `refused`; read `status` and `OUTCOME_EXIT_CODES`); `session` resolves with the session row; `exit` resolves with `{ code, signal, stderr }`; `rows` holds every row received; `interrupt()`, `terminate()` and `kill()` send SIGINT, SIGTERM and SIGKILL (an `AbortSignal` in the options interrupts); `argvOf(options)` shows the command line the client will spawn.

The typed errors: `MercuryRefusal` (the door answered a `refused` outcome row — a bad option, an empty prompt, a conflicting posture; carries the row, the error class and the exit code), `MercuryUsageError` (the door exited 2 with no row: an unknown option, its stderr line is the message), `MercuryExitError` (the door ended without an outcome row), `MercurySpawnError` (the executable could not start), `MercuryWireError` (a stdout line is not a row the package knows — the day the vocabulary moves without a regeneration).
