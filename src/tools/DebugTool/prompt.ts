import { mercuryGodotEnabled } from '../../services/lsp/godotLane.js'

export const DEBUG_TOOL_NAME = 'Debug' as const

export const DEBUG_WIRE_DESCRIPTION =
  'Drive a DAP debugger in agent-owned named sessions (reaped at run end): launch, attach, breakpoints, stepping, stacks, scopes, variables, evaluate, memory and raw requests. Stops return reason, thread and top frames; waits past timeoutMs return with the debuggee running. launch, attach and customRequest ask permission.'

const DEBUG_TOOL_MANUAL = `## Operations
launch runs program (setting file + lines before the first instruction) and reports the first stop; attach joins by pid, port or program.
threads lists threads; stack lists frames with frameId and native [ip <memoryReference>]; scopes lists frame scopes with variablesReference; variables expands one. evaluate runs an expression; an expandable result carries [variablesReference N], which variables expands.
continue, next, stepIn and stepOut wait for the next stop; pause interrupts; restart re-runs; disconnect terminates and reaps the adapter.
output drains program/adapter output; status summarizes sessions, breakpoints and last stop.
Breakpoint ops: breakpoints, functionBreakpoints, dataBreakpoints, instructionBreakpoints, exceptionBreakpoints.
Inspection/mutation ops: loadedSources, modules, source (in-memory/generated), completions, setVariable, disassemble, readMemory (hex dump), writeMemory, customRequest.

## Waits and terminals
runInTerminal requests run as session-managed processes under shell permissions (no window; bounded stdout/stderr appear in output tagged [debuggee]).

## Adapters
"python" (debugpy), "lldb" (lldb-dap: C/C++/Rust/Swift), "codelldb" (CodeLLDB on PATH or downloaded once with approval; preferred for Cargo projects when present), "gdb" (gdb -i=dap, 14+ on PATH), "go" (dlv dap on PATH), "js" (js-debug via MERCURY_JS_DEBUG_DAP or ~/.js-debug), "dotnet" (netcoredbg, when on PATH), "ruby" (rdbg, when on PATH), "php" (PHP Debug downloaded once with approval; PHP with Xdebug required), "bash" (vscode-bash-debug with bashdb and compatible Bash; no automatic download), "dart" (dart debug_adapter, when the Dart SDK is on PATH), "flutter" (flutter debug-adapter, when the Flutter SDK is on PATH), "kotlin" (kotlin-debug-adapter, when on PATH), "elixir" (the elixir-ls debug adapter, when on PATH)\${godotAdapter}. Omitted adapter is inferred (.py → python; .go → go; .js/.ts → js; .cs → dotnet; .rb → ruby; .php → php; .sh/.bash → bash; .dart → flutter when the nearest pubspec.yaml has a Flutter dependency, otherwise dart; .kt → kotlin; .ex/.exs → elixir;\${godotExtensions} else lldb, or gdb 14+ when lldb-dap is absent).\${godotSpecifics}`

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
