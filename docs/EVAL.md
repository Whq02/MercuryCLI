# The Eval tool: one code cell at a time in a retained runtime

The Eval tool runs one code cell per call in a runtime that stays alive
between calls: a Python kernel or a JavaScript kernel, one of each per agent
and working directory. Variables, imports, functions and classes defined in
one cell are there for the next; `reset: true` recreates that language's
runtime alone. It is the tool the model reaches for when work is stateful,
iterative or data-shaped; plain shell commands stay on the Bash tool, and
the Workshop ([WORKSHOP.md](WORKSHOP.md)) is a separate cell surface with a
runtime and words of its own.

## What persists, and what a failed cell says

- **JavaScript.** Top-level `import` statements and top-level `const`,
  `let`, `var`, `class` and `function` declarations persist across cells
  through a source transform. Quoted strings and template literals in an
  initializer may contain text with commas and equals signs. A declaration
  written directly after a block's closing brace on the same line
  (`for (…) {…} var total = 0`) persists like any other; declarations inside
  a block or a function do not. Leading and trailing comments preserve
  declaration boundaries; regex literals in initializers may contain commas,
  quotes and braces. The transform is lexical, not a full parser: when its
  output would break a valid cell, the cell runs unchanged without promising
  to retain its bindings. One declaration per statement reads best.
- **Python.** The namespace keeps every assignment a cell made before it
  ended, error or not.
- **A cell that throws** keeps what it bound before the throw. Its result
  carries a `[note]` line naming the bindings that survived and the ones
  that never landed: a declaration whose initializer threw, `var`
  included, never landed and is not written to the runtime, so a later
  cell cannot mistake it for a value.
- **An idle kernel is reaped** after fifteen minutes. The next cell in that
  language starts a fresh runtime and its result says so; re-run the setup
  cell first.
- **A cancelled cell.** A timeout or an operator stop interrupts the
  kernel; Python keeps its state, the JavaScript kernel is recreated, and
  the result says which.

## The JavaScript kernel's environment

The JavaScript kernel is a child Node process running an ES module, on the
Node that runs Mercury itself. The result of a cell that trips over the
difference names the fact and the fix:

- `require`, `module`, `exports`, `__dirname` and `__filename` are not
  defined. Import instead: `import { readFileSync } from 'node:fs'` at the
  top level of a cell persists across cells, and
  `const fs = await import('node:fs')` works anywhere. `process.cwd()` is
  the working directory.
- The global `crypto` is the Web Crypto API (`crypto.subtle`,
  `crypto.randomUUID()`, `crypto.getRandomValues()`). Node's `createHash`,
  `createHmac`, `randomBytes` and the rest are in the `node:crypto` module:
  `import { createHash } from 'node:crypto'`, or
  `const { createHash } = await import('node:crypto')`.
- Node's own globals are there: `process`, `Buffer`, `fetch`, `URL`, the
  timers. `import.meta` is unavailable in a cell. Top-level `await` works.
- A relative import is re-read on every cell, so an edited local module
  loads fresh; a package keeps its identity.

## The Python kernel

Python cells run on `python3`: the interpreter named by
`MERCURY_EVAL_PYTHON`, else the active virtualenv, else `.venv` under the
working directory, else the `python3` on the path. The last expression's
value is the cell result, as in a notebook, and figures are captured after
each cell.

## Inside a cell

Both kernels carry the same helpers: `tool.<Name>(…)` calls any session
tool under the session's permission mode (a refused call raises into the
cell; `tool.attempt` returns the error as a value instead), `agent(…)` runs
one sub-agent, `parallel(…)` and `pipeline(…)` fan work out, `completion(…)`
makes a tool-free model call, `display(…)` and its markdown, JSON and image
forms put rich output beside stdout, and `read_file` / `write_file` are the
Read and Write tools. Provider credentials never reach a kernel's
environment; a cell that needs a secret receives it through an approved
tool call.

## Switches

`MERCURY_EVAL=0` removes the tool; `MERCURY_EVAL_JS=0` and
`MERCURY_EVAL_PY=0` remove one language each, and the tool's schema then
advertises only the languages that would run.
