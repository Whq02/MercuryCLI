# The debugger

Mercury's `Debug` tool is a real debugger speaking the Debug Adapter
Protocol: breakpoints, stepping, stack, scopes, variables, and evaluation
against a live process — launched or attached, in the terminal, driven by
the model under the same permission gates as every other tool.

## The operations

`launch` and `attach` are the permissioned doors; everything after them
inspects or steps the stopped program: `breakpoints`, `threads`, `stack`,
`scopes`, `variables`, `evaluate`, `continue`, `next`, `stepIn`,
`stepOut`, `pause`, `output`, `status`, `disconnect`. Higher-frequency
inspection ops — `loadedSources`, `modules`, `exceptionBreakpoints`,
`source`, `completions`, `setVariable` — and the native-debugging set —
`functionBreakpoints`, `disassemble`, `readMemory`, `restart` — are
capability-gated against what the adapter actually announced, with precise
refusals. `customRequest` is the escape hatch: any DAP request verbatim,
permission-gated because an arbitrary request can mutate the debuggee.

## Adapters

Built-in adapter rows cover python (debugpy — the build vendors it, with
an installed-module fallback), js (js-debug for Node/TypeScript — the
build vendors it; `MERCURY_JS_DEBUG_DAP` pins a custom copy), lldb, gdb,
go, dotnet, ruby, and godot. Custom adapters are one JSON row each —
command, transport, file types, launch defaults — via `MERCURY_DAP_ADAPTERS`
or the `dap-adapters.json` file in the config home.

On macOS, a native adapter (lldb, gdb) that starts and then never answers
is usually the operating system, not the adapter: without Developer Mode,
`task_for_pid` waits for an interactive authorisation a debug adapter
cannot give, and the grant lasts one boot. The debugger's timeout message
and the doctor's IDE plane row read the setting live
(`DevToolsSecurity -status`) and name the durable fix:
`sudo DevToolsSecurity -enable`.

## Child-session trees

Modern adapters debug real programs as families of sessions: js-debug
starts one session per Node process, a test runner may start one per
file. When an adapter asks to start a child session, the child joins the
same debug tree, and every operation addresses root and children
uniformly — the tree is bounded (at most 16 children, 4 deep, by
default), so a runaway adapter cannot fork forever.

## One-gesture test-debug

The `Test` tool's `debug` op takes a failing test straight into the
debugger — no launch configuration written, no runner arguments
reconstructed by hand. The debug lanes are python (pytest and unittest)
and node-test (via js-debug); `run`/`rerunFailed` cover the remaining
runners, and asking `debug` of one answers with exactly that.

## Gates

`MERCURY_DAP` (default-on) carries the tool; `=0` removes it from the
catalog. `MERCURY_DAP_ADAPTERS`, `MERCURY_DAP_ADAPTERS_FILE`,
`MERCURY_JS_DEBUG_DAP`, and `MERCURY_DEBUGPY_VENDOR_DIR` tune the adapter
table and the vendored payload roots — all registered rows of the in-code
registry (`src/substrate/flagRegistry.ts`; rendered on demand to an
untracked path).
