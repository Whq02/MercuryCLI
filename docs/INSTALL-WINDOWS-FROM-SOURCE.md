# Mercury on Windows: install from source

Build and run Mercury from a source checkout on Windows 10 or 11 using
PowerShell 7, Git, Node 24 LTS and bun 1.3, with a verification check after
each step. (For the one-line release installer `irm https://mercury-cli.ai/install.ps1 | iex`,
see [README.md](../README.md#install); that archive bundles its own Node
runtime and needs only Git.)

## 0. What you are building

Mercury bundles into `dist\mercury.mjs`, run by Node 24 LTS. Settings and
sessions live in `%USERPROFILE%\.mercury` (`C:\Users\<you>\.mercury`), created
on first run.

## 1. Open the right terminal

Run **PowerShell 7** (`pwsh`) inside **Windows Terminal** or the **VS Code
integrated terminal** (not `cmd.exe` or Windows PowerShell 5; a host that lacks
full terminal capabilities shows a check card whose `1` option continues into
the interface).

```powershell
$PSVersionTable.PSVersion
```

Expect a version starting with `7`. If it starts with `5`:

```powershell
winget install --id Microsoft.PowerShell --source winget
```

Then open a new **PowerShell 7** tab in Windows Terminal and re-check. The full
layout starts at 100 columns by 26 rows; smaller windows use the compact
layout.

Mercury sets UTF-8 (`65001`) on interactive start so box-drawing glyphs render
cleanly. To verify or set the console code page manually:

```powershell
chcp
chcp 65001
```

## 2. Install Git

```powershell
git --version
```

If missing, install Git for Windows and reopen the terminal:

```powershell
winget install --id Git.Git --source winget
```

Git for Windows provides `bash.exe` for the Bash tool. Release archives (and
source builds that run step 7's `build-brush.ts`) also include the bundled
`brush` shell engine, selected automatically when `bash.exe` is absent (or
explicitly via `$env:MERCURY_SHELL_ENGINE = "brush"` or `/config` → **Shell
engine**; `"system"` restricts Bash to `bash.exe`, and `MERCURY_GIT_BASH_PATH`
points to a custom `bash.exe` path). On Windows, `brush` requires `cmd /c npm …`
to invoke `.cmd` shims and an absolute program path after `cd`. Without either
`bash.exe` or the `brush` pack, the PowerShell tool remains available and
`/health`'s **Bash tool shell** (`shell`) row explains how to enable Bash.

## 3. Install Node 24

Mercury requires Node **24.x** at **`>=24.20.0 <25`** (`.node-version` pins
`24.20.0`, the first Node 24 release with the fix for `nodejs/node#56645`,
which prevents exit aborts `0xC0000409` after tool calls in headless `run`).

```powershell
node --version
```

Expect `v24.20.0` or newer 24.x. If missing or outside 24.x:

```powershell
winget install --id OpenJS.NodeJS.LTS --source winget
```

(If winget installs another major version, download the 64-bit Node 24 LTS `.msi`
from <https://nodejs.org/en/download>.) `/health`'s **Node & ripgrep**
(`runtime`) row reports the active Node (`MERCURY_NODE`, vendored
`vendor\node\node.exe`, or `PATH`).

## 4. Install bun 1.3

```powershell
bun --version
```

Expect `1.3.<x>`. To install or upgrade:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
bun upgrade
```

## 5. Clone the repository

```powershell
mkdir C:\src -Force | Out-Null
cd C:\src
git clone https://github.com/Whq02/MercuryCLI.git mercury
cd C:\src\mercury
git rev-parse --short HEAD
Test-Path build.ts
```

## 6. Install dependencies

```powershell
bun install --frozen-lockfile
Test-Path node_modules
```

This installs JavaScript dependencies and the bundled `ripgrep` binary.

## 7. Fetch and build optional packs

Fetch the five prebuilt packs (Pyright, `debugpy`, `js-debug`, extra
tree-sitter grammars, and the `win-x64` Node runtime):

```powershell
bun run scripts/vendor/fetch-pyright.ts
bun run scripts/vendor/fetch-debugpy.ts
bun run scripts/vendor/fetch-js-debug.ts
bun run scripts/vendor/fetch-grammars.ts
bun run scripts/vendor/fetch-node.ts
```

With a Rust MSVC toolchain (`cargo`, <https://rustup.rs>) installed, build the
native addons:

- Voice capture: `bun run scripts/vendor/build-voice.ts`
- On-device Whisper transcriber (also needs `winget install Kitware.CMake`):
  `bun run scripts/vendor/build-whisper.ts`
- Bundled shell engine: `bun run scripts/vendor/build-brush.ts`
- Local semantic memory embedding addon and 118 MB `bge-base-en-v1.5` model:
  `bun run scripts/vendor/build-embed.ts` and
  `bun run scripts/vendor/fetch-embed-models.ts` (without them, Mneme memory
  lookup runs word match only)

Build the desktop driver for the Computer tool with the same Rust toolchain
(cargo) before step 8:

```powershell
bun run scripts/vendor/build-desktop.ts
```

Without this pack, the Computer tool is unavailable. Skipped packs are listed
in `dist\manifest.json` under `degraded` while the rest of Mercury builds and
runs normally.

## 8. Build

```powershell
bun run build.ts
Test-Path dist\mercury.mjs
Test-Path dist\manifest.json
```

## 9. Run it

Check version and health:

```powershell
node dist\mercury.mjs --version
node dist\mercury.mjs health --json
```

Start Mercury interactively:

```powershell
node dist\mercury.mjs
```

After first-run theme selection, provider sign-in (`/logins`, `/accounts`) and
workspace trust, a bare launch opens the Boot face (`New Session` ·
`Continue Last Session` once session history exists · `Boot Menu` ·
`MCPs & Skills` · `Agents` · `Health Check` · `Saturn Scheduler` · `Logins` ·
`Session Concourse` · `Sessions · Projects`; set `$env:MERCURY_SPLASH = "off"`
to skip the launch animation). Paste clipboard screenshots in chat with
**alt+v** or drag image files onto the window.

On Windows, the built-in recursive-delete ward ([TRUST.md](TRUST.md)) refuses
deletes of drive roots (`C:\`), your own or other users' homes (`C:\Users`,
`C:\Users\<name>`, `%USERPROFILE%`), system folders (`C:\Windows`, `C:\Program
Files`, `C:\Program Files (x86)`, `C:\ProgramData`), and share roots
(`\\server\share`, `//server/share`) across `rm -r`, `Remove-Item -Recurse`,
`rd /s` and PowerShell `Get-ChildItem | Remove-Item -Recurse` pipelines in
every slash, Git Bash (`/c/…`) and environment-variable spelling. The `/health`
process sweep (`mercury health processes`) inspects Mercury processes through
the Windows management interface and ends only confirmed stale processes owned
by your user that have no live console window.

### Running headless prompts

PowerShell uses `mercury.ps1` (if script execution is restricted, run
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`), passing multiline
prompts and `%NAME%` intact:

```powershell
mercury run --format rows "Line one`nLine two with %NAME% kept"
```

From `cmd.exe`, pipe prompts over standard input so `%NAME%` and line breaks
are preserved:

```bat
mercury run --format rows - < prompt.txt
```

## 10. Optional `mercury` shell function and updating

Add a `mercury` function to your PowerShell profile:

```powershell
if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }
Add-Content $PROFILE 'function mercury { node C:\src\mercury\dist\mercury.mjs @args }'
. $PROFILE
mercury --version
```

To update the checkout later:

```powershell
cd C:\src\mercury
git pull
bun install --frozen-lockfile
bun run build.ts
```

## When something goes wrong

For a quick report (OS, what you tried, what broke, no health dump required),
run `/bug --short <what you tried>` inside Mercury or open
[mercury-cli.ai/report](https://mercury-cli.ai/report). For a full report, use
`/bug <what happened>` or include `node dist\mercury.mjs health --json`, your
`node --version` / `bun --version` / `git --version` output, the exact command
and a screenshot.

| You see | Meaning | Fix |
|---|---|---|
| `'bun' is not recognized` | Terminal opened before bun was installed | Open a new PowerShell 7 window |
| `The engine "node" is incompatible` | Node major version is not 24 | Install `OpenJS.NodeJS.LTS` (`>=24.20.0 <25`, step 3) |
| `dist\manifest.json` lists `degraded` packs | An optional vendor fetch or native build was skipped | Re-run the pack script in step 7 and `bun run build.ts` |
| Immediate exit naming `mercury run` | `stdout` is piped or redirected (non-TTY) | Run in an interactive Windows Terminal tab or pass a prompt to `run` |
| "Bash tool absent" or `shell` check warning | Neither `bash.exe` nor `brush` is present | Install Git for Windows (step 2), set `MERCURY_GIT_BASH_PATH`, or run `bun run scripts/vendor/build-brush.ts` |
| Startup stops naming `MERCURY_GIT_BASH_PATH` | Variable points to a missing file | Fix or unset `MERCURY_GIT_BASH_PATH` |
