import { mercuryGodotEnabled } from '../../services/lsp/godotLane.js'

export const DEBUG_TOOL_NAME = 'Debug' as const

export const DEBUG_WIRE_DESCRIPTION =
  'Drives a real debugger over the Debug Adapter Protocol: launch or attach, breakpoints, stepping, stacks, scopes, variables, evaluate, memory and raw adapter requests, in named sessions that belong to this agent and are reaped when its run ends. A stop comes back with its reason, thread and top frames; a wait that outlasts timeoutMs comes back with the debuggee still running. launch, attach and customRequest ask permission.'

const DEBUG_TOOL_MANUAL = `## Operations
launch runs program under the adapter and reports the first stop; file + lines set breakpoints before the first instruction runs. attach joins a running debuggee by pid, port or program, with the same session from there.
threads lists the debuggee's threads. stack lists the stopped thread's frames, each with its frameId and, for native frames, [ip <memoryReference>]. scopes lists a frame's scopes, each with a variablesReference; variables expands one. evaluate runs an expression in the debuggee; an expandable result carries [variablesReference N], which variables expands.
continue, next, stepIn and stepOut each wait for the next stop. pause interrupts a running debuggee; restart re-runs it.
output drains buffered program and adapter output; status summarizes sessions, breakpoints and the last stop.
breakpoints sets a file's breakpoints; functionBreakpoints breaks on entry by function name; dataBreakpoints stops on a variable's write or read; instructionBreakpoints stops at a machine instruction; exceptionBreakpoints lists or arms the adapter's exception filters.
loadedSources and modules list what the debuggee loaded; source returns generated or in-memory source by sourceReference; completions completes a debug-console expression; setVariable writes a variable in the debuggee.
disassemble decodes machine code at a memory reference; readMemory hex-dumps debuggee memory; writeMemory patches it.
customRequest sends a DAP request verbatim and returns the raw response.
disconnect terminates the debuggee and reaps the adapter.

## Waits and terminals
An adapter's runInTerminal request runs as a session-managed process under shell permissions; no terminal window opens, and its bounded stdout and stderr appear in output tagged [debuggee].

## Adapters
"python" (debugpy — pip install debugpy), "lldb" (lldb-dap, native binaries: C/C++/Rust/Swift), "codelldb" (CodeLLDB on PATH or downloaded once with approval; preferred for Cargo projects when present), "gdb" (gdb -i=dap — present only when a DAP-capable gdb 14+ is on PATH), "go" (dlv dap over a loopback socket — present when dlv is on PATH), "js" (the js-debug DAP server — present when MERCURY_JS_DEBUG_DAP points at dapDebugServer.js or ~/.js-debug holds the unpacked release), "dotnet" (netcoredbg, when on PATH), "ruby" (rdbg, when on PATH), "php" (PHP Debug downloaded once with approval; PHP with Xdebug required), "bash" (vscode-bash-debug with bashdb and compatible Bash; no automatic download), "dart" (dart debug_adapter, when the Dart SDK is on PATH), "flutter" (flutter debug-adapter, when the Flutter SDK is on PATH), "kotlin" (kotlin-debug-adapter, when on PATH), "elixir" (the elixir-ls debug adapter, when on PATH)\${godotAdapter}. adapter is inferred from the program extension when omitted (.py → python; .go → go; .js/.ts → js; .cs → dotnet; .rb → ruby; .php → php; .sh/.bash → bash; .dart → flutter when the nearest pubspec.yaml has a Flutter dependency, otherwise dart; .kt → kotlin; .ex/.exs → elixir;\${godotExtensions} else lldb, or gdb when lldb-dap is absent and gdb 14+ is present).\${godotSpecifics}`

const GODOT_ADAPTER = ', and — when the Godot lane is armed (MERCURY_GODOT=1) — "godot" (the running Godot editor\'s debug adapter over a loopback bridge)'
const GODOT_EXTENSIONS = ' project.godot/.tscn/.gd → godot;'
const GODOT_SPECIFICS = `

## Godot
program is the project directory (or its project.godot); args[0] selects the scene — "main" (default), "current", or a .tscn path — and the remaining args pass to the game as playArgs. The Godot editor must be running with that project open; launch makes it run the project. Breakpoints take absolute .gd paths.`

export function getDebugToolDescription(godot: boolean = mercuryGodotEnabled()): string {
  return DEBUG_TOOL_MANUAL.replace('${godotAdapter}', godot ? GODOT_ADAPTER : '')
    .replace('${godotExtensions}', godot ? GODOT_EXTENSIONS : '')
    .replace('${godotSpecifics}', godot ? GODOT_SPECIFICS : '')
}
