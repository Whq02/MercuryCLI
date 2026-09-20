# Mercury on Windows — install from source

The release route on Windows is one line in PowerShell 7 — the
`irm … | iex` command in the README's Install section — and needs Git and
nothing else. This page is the other route: building Mercury from source on
a Windows machine, for an agent (or a person) with a terminal and no release
archive. Follow it top to bottom. Every step has a check; do not move to the
next step until the check passes. Nothing here needs admin rights unless the
installer you pick asks for them.

Time: about 15 minutes, most of it downloads.

---

## 0. What you are building

Mercury is one JavaScript file (`dist\mercury.mjs`) that Node runs. (A
release archive carries its own Node beside that file and needs only Git;
this page builds from source, which needs Node and bun too.) You will:

1. install three tools (Git, Node, bun),
2. clone the repository,
3. run two commands that produce `dist\mercury.mjs`,
4. run it.

Mercury keeps its settings and sessions in `%USERPROFILE%\.mercury`
(`C:\Users\<you>\.mercury`). The build never writes there; the first run
creates it.

---

## 1. Open the right terminal

Two different things: the **host** and the **shell**. Windows Terminal is the
host — the full interface is designed for it (the VS Code integrated terminal
also qualifies); a standalone PowerShell 7 console window shows a
terminal-check card first, and its first row — `1`, Continue anyway —
continues with a reduced presentation.
PowerShell 7 (`pwsh`) is the shell to run inside that host. Not `cmd.exe`,
not the old blue "Windows PowerShell 5". Every command below is PowerShell.

Check:

```powershell
$PSVersionTable.PSVersion
```

Expect a version starting with `7`. If it starts with `5`, install PowerShell 7:

```powershell
winget install --id Microsoft.PowerShell --source winget
```

then close the terminal and open **PowerShell 7** as a Windows Terminal
profile (Windows Terminal lists it in its new-tab menu once installed — the
Start-menu "PowerShell 7" entry opens a standalone console, which works but
meets the terminal-check card first). Run the check again.

There is no minimum terminal size. Small windows use a compact layout and
prioritize the input; enlarging the window restores the hidden detail. The
full cockpit starts at 100 columns and 26 rows. Maximised is fine.

One more thing: the console must use the UTF-8 code page, or the interface's
box-drawing renders as garbage (`ΓöÇ`-style on code page 437; accented-letter
salad on 850 — the exact letters depend on the console's default). Mercury sets it itself on every
interactive start — the release launcher and the bundle both do — so normally
there is nothing to do. If the box-drawing still renders wrong, check and set
it by hand:

```powershell
chcp
```

If it prints anything other than `Active code page: 65001`:

```powershell
chcp 65001
```

(Or set 65001 as the default in Windows Terminal's profile settings.)

---

## 2. Install Git

Check:

```powershell
git --version
```

If that prints a version, skip to step 3. If it says the command is not
recognised:

```powershell
winget install --id Git.Git --source winget
```

Close the terminal, open a new one, run the check again.

Git for Windows also installs `bash.exe`, the shell Mercury's Bash tool runs
under when it is found. A release archive carries its own bash-compatible
shell engine as well (brush, built from its published crate), and a box
with no `bash.exe` runs the Bash tool through it with nothing to set: the
`doctor` report's **Bash tool shell** row (check id `shell`) then says
"the bundled shell engine at … — no bash.exe was found on this machine",
and with Git for Windows present it says "git-bash at … — found on this
machine". A source build gets the same engine once step 7 builds it. Two
things the engine cannot do on Windows at this version: run a `.cmd` shim
such as `npm` or `npx` directly (`cmd /c npm …` works, or `node` on the
script), and find a program named by a relative path after a `cd` (use its
absolute path). Without either shell — no Git for Windows and no engine
pack — Mercury still starts, but the Bash tool is missing from the model's
tool list (the PowerShell tool stays), the **Bash tool shell** row warns,
and a notice at the start of a session names the ways out: install Git for
Windows; set `MERCURY_GIT_BASH_PATH` to your `bash.exe` when Git is
installed somewhere Mercury does not look; or build the engine (step 7).
`$env:MERCURY_SHELL_ENGINE = "system"` (or the `shellEngine` setting written
as `system`) keeps the Bash tool on `bash.exe` alone, and `brush` runs it on
the engine even when `bash.exe` is present; the `/config` row **Shell
engine** shows `system` for the default, which lets the engine arm itself.
A `MERCURY_GIT_BASH_PATH` that points at a file that does not exist stops
Mercury at start with a message saying so — fix the path.

---

## 3. Install Node 24

Mercury runs on Node **24.x** — not 22, not 25 — and within 24, at least
**24.20.0**. The floor matters on Windows specifically: 24.20.0 is the first
Node 24 that carries the fix for nodejs/node#56645, and below it a headless
`-p` run that dispatched any tool aborts at exit with 0xC0000409. The exact
patch the project builds with is written in the repository file
`.node-version` (currently `24.20.0`); any 24.20.0 or newer 24.x works.

Check:

```powershell
node --version
```

Expect `v24.20.0` or a newer 24. If Node is missing, the major version is
not 24, or the patch is below 24.20.0:

```powershell
winget install --id OpenJS.NodeJS.LTS --source winget
```

(The `.LTS` id matters: the plain `OpenJS.NodeJS` id installs the current
major, which the project's `engines` field refuses.) Close the terminal, open
a new one, run the check again. If winget installed
a version other than 24, install the LTS-24 build from
<https://nodejs.org/en/download> instead (pick "Windows Installer (.msi)",
64-bit, version 24).

The `doctor` health report you will meet in step 9 reads this same policy:
its **Node & ripgrep** row (check id `runtime`) shows which Node it runs on
(the vendored runtime beside the build, an explicit `MERCURY_NODE`, or the
PATH Node it found) against the supported range, and when its fix line says to install Node
24.20.0 or newer it means this floor — the nodejs/node#56645 exit abort is
what it is protecting you from. On a Node below the floor you rarely get
that far: every `node dist\mercury.mjs` route, `doctor` included, refuses at
boot with the same sentence and exits non-zero, so an "unsupported Node"
message anywhere is always this step's fix.

---

## 4. Install bun 1.3

bun is the build tool. Mercury needs the **1.3** series.

Check:

```powershell
bun --version
```

Expect `1.3.<something>`. If bun is missing:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Close the terminal, open a new one, run the check again. If the check prints
a version that does not start with `1.3`:

```powershell
bun upgrade
```

---

## 5. Clone the repository

Pick a folder path you can type easily — `C:\src` is a good choice. Spaces
in the path are fine.

```powershell
mkdir C:\src -Force | Out-Null
cd C:\src
git clone https://github.com/Whq02/MercuryCLI.git mercury
cd C:\src\mercury
```

Check:

```powershell
git rev-parse --short HEAD
Test-Path build.ts
```

Expect a short hash on the first line and `True` on the second.

---

## 6. Install the dependencies

```powershell
bun install --frozen-lockfile
```

This downloads the JavaScript packages and the bundled `ripgrep` search
binary. It can take a few minutes. It must finish with no red error block.

Check:

```powershell
Test-Path node_modules
```

Expect `True`.

If it fails with a network error, run the same command again — it resumes.
If it fails with anything about `lockfile`, you are on the wrong bun version;
go back to step 4.

---

## 7. Fetch the optional language packs

These five commands download pinned, hash-verified helpers: the Python
language server, the Python debugger, the Node/TypeScript debug adapter,
extra tree-sitter grammars for the structural code tools, and this
machine's own Node runtime (the official `win-x64` build, vendored beside
the bundle so a release archive made from this build needs no Node
install). Mercury builds and runs **without** them (the build prints a
warning naming what was skipped, and the affected features say so honestly
at runtime), but a full install has them.

```powershell
bun run scripts/vendor/fetch-pyright.ts
bun run scripts/vendor/fetch-debugpy.ts
bun run scripts/vendor/fetch-js-debug.ts
bun run scripts/vendor/fetch-grammars.ts
bun run scripts/vendor/fetch-node.ts
```

Three more packs are built rather than fetched, each with a Rust toolchain
installed (https://rustup.rs, the MSVC toolchain): the voice capture addon
(`bun run scripts/vendor/build-voice.ts`), the on-device transcriber addon
(`bun run scripts/vendor/build-whisper.ts`, which also needs cmake beside
cargo: `winget install Kitware.CMake`) and the shell engine
(`bun run scripts/vendor/build-brush.ts` — upstream publishes no Windows
binary, so the engine is compiled from its published crate; the first build
takes several minutes). Without cargo, or without cmake for the transcriber,
each says so and skips: Mercury runs without voice input, voice takes go to a
cloud transcriber, and the Bash tool keeps Git for Windows' bash (the doctor
names each remedy). A release archive always carries the engine; only a
source build without cargo lacks it.

Each should end without an error. `fetch-debugpy` unpacks the wheel with the
first extractor it finds — `unzip`, `python3`, `tar.exe` (ships with Windows
10 1803 and later), `python`, `py -3` — so a stock Windows box needs nothing
extra. If every candidate is missing, the fetch says so, the build records
`degraded: python-debugger`, and everything else still works. If a fetch
fails on a download, retry it once; if it still fails, continue — nothing
below depends on it.

---

## 8. Build

```powershell
bun run build.ts
```

Takes about a minute. The last lines list the outputs.

Check:

```powershell
Test-Path dist\mercury.mjs
Test-Path dist\manifest.json
```

Expect `True` and `True`. If `manifest.json` is missing the build was
degraded — read the build output for the first line containing `error` and
fix that before continuing.

---

## 9. Run it

Version check (no interface, safe anywhere):

```powershell
node dist\mercury.mjs --version
```

Health check — this prints a JSON report and is the single most useful thing
to paste when asking for help:

```powershell
node dist\mercury.mjs doctor --json
```

Redirecting the output to a file (`> doctor.json`) is fine: a piped run is
not an interactive terminal, so the terminal-profile row reads as
environmental and the verdict is unaffected. To run a single check, name it:
`node dist\mercury.mjs doctor --only <check-id>` (the ids are the `id` fields
in the JSON).

The Windows leg of the process sweep lives in
`src/daemon/processSweepWindows.ts`. `collectWindowsProcesses()` reads every
process through CIM (no third-party module): real executable path, arguments,
birth time and token, owner SID, and the terminal facts — the Win32 session id,
whether a console window is attached, and whether that logon session is still
connected. A process whose console host is still alive reads as having a live
terminal; one with no console does not, whatever its session; when the
console cannot be read, a connected interactive session counts as live and a
disconnected one leaves the read unknown. An unknown read stays `null` and is
never permission to stop anything, and a failed table reads `complete: false`
rather than an empty success.
`signalWindowsProcess(expected, force)` is the platform's stop for the shared
sweep owner: it holds the target's process handle, refuses a process that is
not the current user's, rechecks pid, birth, executable and user against
`expected`, refuses a live or unknown terminal, re-reads all of that once more
immediately before acting, then runs `taskkill /PID` (with `/F` when forced)
against that one process — never a tree, never a bare parent relation. On
Windows the polite stop reaches only a process with a window: for a
console-less one `taskkill` answers that it can only be ended forcefully, and
the signal reports that as `sent: false` with the reason, so the shared owner
moves to its forced rung. A stop whose receipt is lost answers `sent: false`
with a reason that says the outcome is unknown. A console counts as attached when the process still has
one to attach to, which on Windows means its host (a console window or a
pseudoconsole) is still alive. Nothing here ends a process on its own or adds
a doctor row; the shared owner decides, on request.

Start Mercury (needs the 100-column window from step 1):

```powershell
node dist\mercury.mjs
```

The first run asks you to choose a theme, then to sign in to a model
provider. Type `/logins` later to add or change providers, and `/accounts`
to see them. Type `/exit` to leave.

To attach a screenshot, copy it and press **alt+v** in the chat (on Windows
the terminal owns ctrl+v, and an image-only clipboard gives it nothing to
paste); Mercury also says so when you come back to it with an image on the
clipboard. Dragging an image file onto the window attaches it too. A big
screenshot is shrunk to the model provider's limits, never refused for its
size; `node dist\mercury.mjs doctor --json` names the image processor in
its `iface-image-processor` row.

Where you land: every start with no explicit journey lands on the Boot face
— the card of New Session · Continue Last Session (once session history
exists) · Boot Menu · MCPs & Skills · Agents · Doctor / Health Check ·
Saturn Scheduler · Logins · Session Concourse · Sessions · Projects —
whether Mercury was started as
`node dist\mercury.mjs` or through the `mercury` launcher of a release
install. Starting with a prompt argument, `--continue`, or `--resume` goes
straight into the chat. Inside the chat, shift+← walks back to the concourse
and the Boot face at any time; with `--chat` (or the concourse switched off)
shift+← is the Boot face directly — the strip is the face and the chat alone.

A source build started this way paints the launch splash first — the
circuit-trace animation before the Boot face — exactly as a release
install's `mercury` launcher does: the build copies the splash beside
`dist\mercury.mjs`, and a bare `node dist\mercury.mjs` runs it before the
face. `$env:MERCURY_SPLASH = "off"` skips it on both roads; a start with any
argument (a prompt, `--continue`, a verb) goes straight to its destination.

---

## 10. Make a `mercury` command (optional)

So you can type `mercury` from any folder. Add this to your PowerShell
profile:

```powershell
if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }
Add-Content $PROFILE 'function mercury { node C:\src\mercury\dist\mercury.mjs @args }'
. $PROFILE
```

Check:

```powershell
mercury --version
```

---

## 11. Updating later

```powershell
cd C:\src\mercury
git pull
bun install --frozen-lockfile
bun run build.ts
```

If `git pull` complains about local changes you did not make, run
`git status` and paste the output when asking for help — do not force
anything.

---

## When something goes wrong

Collect these four things and send them:

1. `node dist\mercury.mjs doctor --json` output (or the error it prints),
2. `node --version`, `bun --version`, `git --version`,
3. the exact command you ran and the full text it printed,
4. a screenshot if the problem is on the screen.

Common cases:

| You see | It means | Do |
|---|---|---|
| `'bun' is not recognized` | terminal opened before bun was installed | close the terminal, open a new one |
| `The engine "node" is incompatible` or a Node version error | wrong Node major | step 3 — must be 24.x |
| `dist\manifest.json` lists names under `degraded` | a vendor fetch was skipped or failed — the build itself still succeeds and prints `BUILD OK` | re-run the fetch it names (step 7), then build again |
| compact controls or clipped detail | the window has little space | enlarge it to show more; the input and exit keys remain available |
| an immediate exit that mentions `--print` | stdout is not a terminal (piped or redirected), which Mercury reads as a headless run | run from an interactive Windows Terminal window, or pass a prompt for a headless run |
| a "Bash tool absent" notice, or the `doctor` **Bash tool shell** row warns | neither `bash.exe` nor the shell engine serves: Git for Windows is missing or not where Mercury looks, and this source build has no engine pack (a release archive always carries one) or `MERCURY_SHELL_ENGINE=system` turned the engine off | step 2, or set `MERCURY_GIT_BASH_PATH` to your `bash.exe`, or build the engine (step 7), or unset `MERCURY_SHELL_ENGINE` |
| Mercury stops at start naming `MERCURY_GIT_BASH_PATH` | that variable points at a file that does not exist | fix or remove the variable |
