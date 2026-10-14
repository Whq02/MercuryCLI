# The Eval tool: one code cell at a time in a retained runtime

The `Eval` tool runs one Python (`python3`) or JavaScript (Node ES module) code
cell per call in a retained runtime per agent and working directory.

Variables, imports, functions and classes defined in one cell persist for the
next; `reset: true` recreates that language's runtime alone. Use `Eval` for
stateful, iterative or data-shaped work and `Bash` for plain shell commands.
Multiple `Eval` calls in one message execute sequentially, each with its own
result. When an `Eval` call asks for permission (or renders in verbose mode),
the approval card displays the full code cell it will run beneath the language
and title.

## What persists, and what a failed cell says

- **JavaScript**: top-level `import` statements and top-level `const`, `let`,
  `var`, `class` and `function` declarations persist across cells through a
  lexical source transform (including declarations after a block's closing
  brace on the same line, quoted strings, template literals and regex literals
  in initializers). Declarations inside a block or function stay local; if the
  lexical transform would alter a valid cell's syntax, the cell runs unchanged
  without retaining its top-level bindings.
- **Python**: the namespace keeps every assignment a cell made before it ended.
- **Throwing cells**: bindings completed before the throw survive; a `[note]`
  line lists the bindings that survived and any declaration whose initializer
  threw (including `var`), which is never written to the runtime.
- **Idle reaping and cancellation**: an idle kernel is reaped after 15 minutes
  (the next cell starts a fresh runtime and notes the reset). A timeout or user
  interrupt stops the running cell, marks the result as an error, preserves
  Python state, and recreates the JavaScript kernel.

## The JavaScript and Python kernels

The JavaScript kernel runs as an ES module on the same Node binary that runs
Mercury:

- `require()` resolves from `process.cwd()` (the working directory), reloading
  edited local modules before each cell while keeping `node_modules` cached;
  top-level `import` and dynamic `await import(…)` also reload relative local
  modules on each cell (`module`, `exports`, `__dirname`, `__filename` and
  `import.meta` are undefined).
- Global `crypto` is the Web Crypto API (`crypto.subtle`, `crypto.randomUUID()`,
  `crypto.getRandomValues()`); import `node:crypto` for `createHash`,
  `createHmac` and `randomBytes`. Standard Node globals (`process`, `Buffer`,
  `fetch`, `URL`, timers) and top-level `await` are available.

The Python kernel runs on `MERCURY_EVAL_PYTHON`, the active virtualenv,
`.venv` in the working directory, or `python3` on `PATH`, capturing the final
expression's value and any figures after each cell.

## Inside a cell, results and switches

Both kernels expose the same helpers: `tool.<Name>(…)` invokes any session tool
under the session's permission mode (throwing on a refused tool call, while
`tool.attempt` returns the refusal as a value; a `Bash` command returns
`{ code, stdout, stderr }` with the merged capture in `stdout` and `stderr`
empty regardless of exit code). `agent(…)`, `parallel(…)` and `pipeline(…)`
delegate to crewmates; `completion(…)` runs a tool-free model call;
`display(…)` renders rich text, markdown, JSON (up to 10,000 characters before
marking a cut) or images; `read_file` and `write_file` call `Read` and `Write`;
and `tool.Inspect({ ref })` (or `tool.Inspect(ref=ref)` in Python) reads a
`mercury://` resource. Provider credentials are stripped from the kernel
environment. With Samples enabled ([SAMPLES.md](SAMPLES.md)),
`sample({ name, title?, html, ask? })` saves a versioned HTML sample when you
asked to see one.

The final expression's value prints after `⇒`. `timeoutSeconds` defaults to
`30`, clamps to `600` with a note, and accepts `0` for no cell timeout (tool,
agent, completion and permission waits do not count against the cell timeout,
and permission waits pause the 30-minute wall ceiling). `MERCURY_EVAL=0`
removes the tool; `MERCURY_EVAL_JS=0` and `MERCURY_EVAL_PY=0` remove one
language each from the tool schema.
