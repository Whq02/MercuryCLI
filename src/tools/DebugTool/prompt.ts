export const DEBUG_TOOL_NAME = 'Debug' as const

export const DEBUG_TOOL_DESCRIPTION = `Drive a real debugger over the Debug Adapter Protocol (DAP) — breakpoints, stepping, stacks, scopes, variables, evaluate — instead of print-statement archaeology.

The debugging loop:
1. op:"launch" with program (and optional adapter/args/stopOnEntry) plus optional file+lines to set breakpoints before the first instruction runs. The call reports the first stop (entry or breakpoint). op:"attach" (pid, port [+host], or program) joins an ALREADY-RUNNING debuggee instead — same session lifecycle from there; a bare port auto-picks the python adapter (the debugpy listen socket is the common shape).
2. Inspect: op:"stack" (frames for the stopped thread; native frames carry [ip <memoryReference>]), op:"scopes" (frameId from the stack), op:"variables" (variablesReference from scopes/variables — nested structures expand by reference), op:"evaluate" (expression, optional frameId; runs in the debuggee).
3. Move: op:"continue" | "next" | "stepIn" | "stepOut" — each waits for the next stop and reports it with the new stack top. next/stepIn accept granularity:"instruction" for one-machine-instruction steps (capability-gated). op:"pause" interrupts a running debuggee. op:"restart" re-runs the debuggee (capability-gated; adapters without it answer with the disconnect+relaunch path).
4. op:"output" drains buffered program/adapter output; op:"status" summarizes sessions, breakpoints, and last stop.
5. Breakpoint richness: the breakpoints op takes file + lines, OR file + breakpoints:[{line, condition?, hitCondition?, logMessage?}] for conditional/hit-count/log breakpoints (each feature capability-gated). op:"functionBreakpoints" (functions: [names]) breaks on entry by symbol name — no line number needed.
6. Deeper inspection (each capability-gated — an adapter that lacks it answers precisely): op:"loadedSources" and op:"modules" list what the debuggee actually loaded; op:"source" retrieves generated/in-memory source by sourceReference; op:"completions" (text, optional frameId) completes REPL expressions; op:"setVariable" (variablesReference + name + value) mutates debuggee state; op:"exceptionBreakpoints" lists the adapter's exception filters (re-run with filters: [ids] to arm break-on-throw); op:"disassemble" (memoryReference from a frame's [ip …], optional instructionCount ≤64) decodes machine code; op:"readMemory" (memoryReference, count ≤4096) hex-dumps debuggee memory.
7. op:"customRequest" (method + optional body JSON) sends any DAP request verbatim and returns the raw response — the escape hatch for adapter-specific commands (permission-gated).
8. ALWAYS finish with op:"disconnect" — it terminates the debuggee and reaps the adapter.

Adapters: "python" (debugpy — pip install debugpy), "lldb" (lldb-dap, native binaries: C/C++/Rust/Swift), "gdb" (gdb -i=dap — present only when a DAP-capable gdb 14+ is on PATH), "go" (dlv dap over a loopback socket — present when dlv is on PATH), "js" (the js-debug DAP server — present when MERCURY_JS_DEBUG_DAP points at dapDebugServer.js or ~/.js-debug holds the unpacked release), "dotnet" (netcoredbg, when on PATH), "ruby" (rdbg, when on PATH), and — when the Godot lane is armed (MERCURY_GODOT=1) — "godot" (the running Godot editor's debug adapter over a loopback bridge). adapter is inferred from the program extension when omitted (.py → python; .go → go; .js/.ts → js; .cs → dotnet; .rb → ruby; project.godot/.tscn/.gd → godot; else lldb, or gdb when lldb-dap is absent and gdb 14+ is present). Custom adapters register via the MERCURY_DAP_ADAPTERS env or <configHome>/dap-adapters.json (JSON rows: {"key":{"command":"…","args":[…],"connect":"stdio"|"tcp","fileTypes":[".ext"],"rootMarkers":["…"],"launchDefaults":{…},"attachDefaults":{…}}}; "\${port}" in args is substituted with a free loopback port for tcp rows).

Godot specifics: program is the project directory (or its project.godot); args[0] selects the scene — "main" (default), "current", or a .tscn path; remaining args pass to the game as playArgs. The Godot editor must be running with that project open (godot --editor --headless works; a macOS app-bundle install spells it <Godot.app>/Contents/MacOS/Godot); launch makes the EDITOR run the project, and the editor refuses with WRONG_PATH if a different project is open. Breakpoints take absolute .gd paths.

Sessions are named (default "main"); a second launch on the same session name replaces it. Breakpoints (op:"breakpoints", file + lines) replace the full set for that file.

Prefer this tool over sprinkling prints whenever a failure needs runtime state: a hung process, a wrong value mid-computation, a segfault frame, an assertion you cannot reproduce by reading.`

export function getDebugToolDescription(): string {
  return DEBUG_TOOL_DESCRIPTION
}
