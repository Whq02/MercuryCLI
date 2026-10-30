# The debugger

Mercury's `Debug` tool is a real debugger speaking the Debug Adapter
Protocol: breakpoints, stepping, stack, scopes, variables, and evaluation
against a live process (launched or attached, in the terminal, driven by
the model under the same permission gates as every other tool).

## The operations

`launch` and `attach` are the permissioned doors; everything after them
inspects or steps the stopped program: `breakpoints`, `threads`, `stack`,
`scopes`, `variables`, `evaluate`, `continue`, `next`, `stepIn`,
`stepOut`, `pause`, `output`, `status`, `disconnect`. Higher-frequency
inspection ops (`loadedSources`, `modules`, `exceptionBreakpoints`,
`source`, `completions`, `setVariable`) and the native-debugging set
(`functionBreakpoints`, `dataBreakpoints` to stop on the write or read of a
variable, `instructionBreakpoints`, `disassemble`, `readMemory`,
`writeMemory`, `restart`) are
capability-gated against what the adapter actually announced, with precise
refusals. `customRequest` is the escape hatch: any DAP request verbatim,
permission-gated because an arbitrary request can mutate the debuggee.

## Stop waits and cancellation

`timeoutMs` sets how long `launch`, `attach`, `continue`, stepping, `pause`,
and `restart` wait for a stop. It defaults to 10,000 milliseconds; longer
waits are allowed. Reaching the deadline reports that the program is still
running and does not terminate it. Cancelling a call interrupts its pending
requests and stop waits immediately. A cancelled step can leave the program
running: use `status` to inspect it or `disconnect` to end the session.

## Adapter-requested programs

Adapters can request a program through DAP `runInTerminal`. The requested
command, working directory and environment go through the same permission
checks and guards as Bash. An approved command starts directly from its
argument list; its process ID is returned to the adapter. Both `integrated`
and `external` requests use session-managed processes without opening a
terminal window. Standard output and standard error appear in Debug's bounded
output buffer, tagged `[debuggee]`. Disconnecting or terminating the session
ends these processes and their descendants.

## Adapters

Built-in adapter rows cover python (`debugpy`, vendored in the build with
an installed-module fallback), js (`js-debug` for Node/TypeScript, vendored in
the build; `MERCURY_JS_DEBUG_DAP` pins a custom copy), lldb, gdb, codelldb,
go, dotnet, ruby, php, bash, dart (`dart debug_adapter` from the Dart SDK), flutter
(`flutter debug-adapter` from the Flutter SDK), kotlin
(`kotlin-debug-adapter`), elixir (the elixir-ls debug adapter) and godot; a
row that needs a binary appears when that binary is on PATH, and `/health`
names the install for the ones that are not. Custom adapters are one JSON row
each (command, transport, file types, launch defaults) via
`MERCURY_DAP_ADAPTERS` or the `dap-adapters.json` file in the config home;
that is also the road for a custom adapter installation.

The python adapter runs on the Python runtime every release archive carries
(`vendor/python`, CPython 3.14), so a machine needs no Python of its own to
debug a script; the program under debug runs on the project's interpreter (the
`MERCURY_PYTHON` pin, the active or project venv, a PATH `python3`) when that
interpreter is 3.10 or newer, otherwise on the bundled one.

Dart files use the Dart SDK's stdio adapter. A `flutter` dependency in the
nearest `pubspec.yaml` selects Flutter's stdio adapter instead. Install the
[Dart SDK](https://dart.dev/get-dart) or [Flutter SDK](https://docs.flutter.dev/install)
and put its `bin` directory on PATH; Mercury downloads neither SDK.
Both launch requests take the program path, optional arguments and working
directory. Custom adapter rows still override the built-in rows.

`codelldb` uses [CodeLLDB](https://github.com/vadimcn/codelldb/releases)
over stdio for Rust, C and C++. Mercury prefers it for Cargo projects when
it is on PATH or already installed in the config home; other native programs
keep lldb-dap as their default. An explicit `adapter: "codelldb"` launch can
ask to download the pinned platform release once. CodeLLDB is MIT-licensed;
its VSIX includes LLDB. The archive's size and SHA-256 are checked before
extraction into `<configHome>/adapters/codelldb`; the MIT licence from the
pinned upstream tag is installed beside the adapter. Nothing is added to the Mercury
build. A refusal or non-interactive launch downloads nothing.

PHP files select `php`. Mercury can download the pinned
[PHP Debug adapter](https://github.com/xdebug/vscode-php-debug/releases)
(MIT) once with approval, unpack its VSIX under `<configHome>/adapters/php`,
and run `extension/out/phpDebug.js` under Node. Its licence is kept in the
unpacked extension. The PHP runtime and Xdebug extension are separate
prerequisites and are never installed by Mercury. Check
`php -m | grep -i xdebug`; the [Xdebug installation guide](https://xdebug.org/docs/install)
recommends `pie install xdebug/xdebug` and `zend_extension=xdebug` in PHP's
configuration. The guide also documents `pecl install xdebug` as a legacy
method. The adapter launches CLI scripts with Xdebug enabled and a local,
automatically allocated connection port.

Shell files (`.sh`, `.bash`) select `bash` when
[vscode-bash-debug](https://github.com/rogalmic/vscode-bash-debug) and bashdb
are installed. Put `bash-debug-adapter` on PATH or unpack the extension so
its entry is `<configHome>/adapters/bash/extension/out/bashDebug.js`.
Bash and bashdb must also be on PATH, with bashdb's library beside its
script or under the installation prefix's `share/bashdb` or `lib/bashdb`.
A custom adapter row can set `pathBashdbLib` for another layout.
The adapter requires Bash 4 or newer; macOS's `/bin/bash` 3.2 is not
supported. [bashdb](https://github.com/Trepan-Debuggers/bashdb) is maintained
and its current 5.2 branch supports Bash 5.2 and newer. The adapter's latest
release is from 2021, so choose a compatible pair; Mercury downloads neither.

On macOS, a native adapter (lldb, gdb, codelldb) that starts and then never answers
is usually waiting on the operating system: without Developer Mode,
`task_for_pid` waits for an interactive authorisation a debug adapter
cannot give, and the grant lasts one boot. The debugger's timeout message
and the health check's IDE plane row read the setting live
(`DevToolsSecurity -status`) and name the durable fix:
`sudo DevToolsSecurity -enable`.

## Child-session trees

Modern adapters debug real programs as families of sessions: js-debug
starts one session per Node process, a test runner may start one per
file. When an adapter asks to start a child session, the child joins the
same debug tree, and every operation addresses root and children
uniformly; the tree is bounded (at most 16 children, 4 deep, by
default), so a runaway adapter cannot fork forever.

## One-gesture test-debug

The `Test` tool's `debug` op takes a failing test straight into the
debugger (no launch configuration written, no runner arguments
reconstructed by hand) and stops on the first line of the one test you
named, with its locals readable. Python tests (pytest and unittest) run
under debugpy; node-test, vitest and jest tests under js-debug (vitest in
one worker with its timeout off, jest in-band); Go tests under Delve's DAP
server (`dlv`), built in test mode for their package; cargo tests under lldb-dap
or gdb, from the test binary cargo itself builds, run with `--exact`. The
test is spelled as its runner names it: `file::name` or a bare name from
the latest run for the Node runners, `TestName`, `TestName/subtest` or
`dir::TestName` for Go, `module::path::test_name` for cargo. A debugger
that is not installed answers `unavailable` with its install line (Delve:
`go install github.com/go-delve/delve/cmd/dlv@latest`; lldb-dap or gdb
from the toolchain).

`run` on a vitest, jest or Go project answers passed, failed and skipped
counts and the failing cases from the runner's own machine reporter
(vitest's and jest's JSON report, `go test -json`), as node-test and cargo
already do from their summaries; `rerunFailed` selects exactly those
failures by the names the reporter recorded.

## Gates

`MERCURY_DAP` (default-on) carries the tool; `=0` removes it from the
catalog. So does a machine on which no debug adapter is reachable: the
Debug tool is withheld from the catalog,
the `Tools withheld` row of `mercury health` and `/health` names it with
the adapters to arm, and a session already running picks the tool up at
its next `/clear` or compaction. The census that decides it reads the
filesystem only (the vendored packs, PATH, the adapter tables) and a memo
for the two toolchain probes, `xcrun -f lldb-dap` on macOS and
`gdb --version`, which run once per process in the background; a catalog
built before they answer withholds the tool with words saying the probe
has not answered yet, and the next build reads the answer. The health check
waits for the probes before it writes its row, so a boot never stalls on
a spawn and the certificate never names a probe still in flight.
`MERCURY_DAP_ADAPTERS`, `MERCURY_DAP_ADAPTERS_FILE`,
`MERCURY_JS_DEBUG_DAP`, `MERCURY_DEBUGPY_VENDOR_DIR` and `MERCURY_PYTHON_VENDOR_DIR` tune the
adapter table and the vendored payload roots, all registered rows of the in-code
registry (`src/substrate/flagRegistry.ts`; rendered on demand to an
untracked path).
