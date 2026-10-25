# Installation, requirements and building from source

Release archives install Mercury on macOS, Linux and Windows with Node 24 LTS and ripgrep bundled alongside the CLI; `git` is the only separate requirement.

## Install

Release archives are available for Apple silicon and Intel Macs, Linux x64
and arm64, and Windows x64 and arm64. Install `git` separately; each archive
includes Node and ripgrep, so a separate Node installation is unnecessary.

Choose one installation method:

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS and Linux (x64 and arm64)
irm https://mercury-cli.ai/install.ps1 | iex        # Windows (x64 and arm64), in PowerShell 7
brew install Whq02/mercury/mercury                 # Homebrew: macOS and Linux x64
npm install -g mercury-tech-cli                    # npm; `bun install -g mercury-tech-cli` is the same package
mise use -g npm:mercury-tech-cli                   # mise, through the npm package
```

The install addresses keep approximate script-request counts by source and UTC
day (completed installs are not counted); the counter stores no IP address, user-agent string
or cookie.

Open a new terminal, or run the `export PATH=…` line the shell installer
prints, then run `mercury --version` to check it and `mercury` from a
repository to start your first session ([SESSIONS.md](SESSIONS.md)). On Windows PowerShell, and
after a Homebrew, npm, bun or mise install, `mercury` works in the same
terminal.

### How the installation methods differ

The shell and PowerShell installers fetch the newest release for your
platform, check its SHA-256 against `SHA256SUMS.txt`, unpack it, and run the
archive's own `mercury install` command.

Homebrew and the npm package are each pinned to a particular release and are
republished after a tag, so they can lag behind the newest release. Homebrew
commands use the full tap name `Whq02/mercury/mercury` (bare `mercury` in
`homebrew-core` is a different program). The npm package, `mercury-tech-cli`,
is a launcher that downloads its pinned release; mise installs that same
package. `mercury install --uninstall` removes the installed release and command
shim while keeping your configuration and sessions (also run `npm uninstall -g
mercury-tech-cli` if you installed the npm launcher).

Mercury's installation is user-local and does not require administrator
access. You can safely rerun an installation command.

### Installation paths

Release versions live under the config home at `~/.mercury/versions/<version>`
(`%USERPROFILE%\.mercury\versions` on Windows). The `mercury` command is
installed in `~/.local/bin` on macOS and Linux, or
`%LOCALAPPDATA%\Mercury\bin` on Windows.

`mercury install` adds the command's directory to PATH once: a guarded line
in your shell startup file, or an entry in the Windows user PATH. A new
terminal picks up the change automatically.

### Updates

Use `mercury update` with any installation method.

For an installation made with the shell or PowerShell installer, or with
`mercury install`, it updates Mercury in place. `--check` checks for updates,
`--status` reports update status, and `--rollback` returns to the previous
version, which stays on disk.

For Homebrew, it asks before running `brew upgrade Whq02/mercury/mercury`.
The default answer is no; enter `y` to approve. Mercury streams the command's
output and checks the installed version afterwards. Use `--yes` to skip the
prompt in scripts.

The npm launcher uses the same release layout as the installers and delegates
each run to the installed release. `mercury update` therefore updates an npm
installation in place through Mercury's own update channel.
`npm update -g mercury-tech-cli` changes only the release the package installs
on its first run. This also applies when using mise.

`--check` reads the same release list for every installation method and tells
you how to update yours. When an update is available, the home screen shows
`vX.Y.Z available · mercury update` once in its bottom-right corner, and the
chat shows a temporary notice. Set `MERCURY_UPDATE_NOTICE=0` to hide both.

Install and update requests fetch the public release list and archives
anonymously. You can run them without an account or token. If an anonymous
request is refused, Mercury consults a signed-in GitHub CLI (`gh`).

After an update, Mercury checks whether the command on your PATH points to
the updated installation. If another installation takes precedence, or the
updated command is missing from PATH, it explains the problem and the fix.
`mercury health` reports the same issue.

### Release verification

Before activating a release, Mercury checks its archive against
`SHA256SUMS.txt`. It also requires a payload signed by the Mercury release
key in its compiled-in trust roster before staging the update. A rejected
signature leaves the active installation unchanged.

Use `--allow-unsigned` to accept an unsigned payload. Mercury still rejects
unknown signing keys, malformed signing blocks and tampered contents. The
command result and its local record both show that you allowed an unsigned
payload.

From 1.0.0-beta.3, archives are signed during packaging and their signatures
are verified before publication. A verified installation adds no signature
notice at startup. `mercury health` reports the signing key `627b54b734ca0e72`.

The 1.0.0-beta.2 archives are unsigned. These installations report
unsigned provenance once per install when you start Mercury interactively
without a command or flag. The health check continues to show that status. It means
the archive manifest has no signature; the download is still checked against
`SHA256SUMS.txt`.

[TRUST.md](TRUST.md) explains the verification results and how to
check an archive manually.
[TERMINAL-RUNTIME.md](TERMINAL-RUNTIME.md) covers startup verification.

### Platform notes

Release archives exist for every platform listed above. Any other machine
builds from source.

Intel Mac archives are available from 1.0.0-beta.3. They are cross-packaged on
an Apple silicon runner and tested at startup under Rosetta before
publication. Intel Macs using 1.0.0-beta.2 need a source build.

## Requirements

Release archives include Node 24 LTS. The launcher, `mercury install` and
`mercury update` use that bundled runtime; `git` is the only separate
requirement for the release itself.

To build from source, you need:

- **Node 24 LTS**, in the supported range `>=24.20.0 <25`. `.node-version`
  pins the patch used for builds and included in release archives.
- **bun 1.3.x** for the build. It is not bundled with releases.
- **git**. On Windows, run PowerShell 7 inside Windows Terminal or the
  VS Code terminal. See
  [INSTALL-WINDOWS-FROM-SOURCE.md](INSTALL-WINDOWS-FROM-SOURCE.md).

The Node minimum includes the fix for nodejs/node#56645. Below 24.20.0,
headless `run` commands that call a tool abort on exit on Windows.

Launchers select Node in this order: the explicit `MERCURY_NODE` binary, the
bundled runtime, then a compatible Node installation on PATH. If the runtime
is missing, the launcher reports an error.

### Windows shells

Release archives include Mercury's bash-compatible shell engine (`brush`),
and on Windows it serves the Bash tool by default: it finds a `.cmd` or
`.bat` program such as `npm` by its bare name through PATHEXT, passes `%VAR%`
and `^` to a batch file unchanged, runs a program named by a relative path
after `cd`, and keeps shell state between calls. Git for Windows' `bash.exe`
is not required; when it is installed, `MERCURY_SHELL_ENGINE=system` or
`system` in `/config` under Shell engine runs the Bash tool on `bash.exe`
alone.

Read the health check's `shell` row to see which shell is active and why: the
bundled engine (the Windows default, or armed by the pin or the setting), or
Git Bash when the engine was turned off or its pack is absent.

On macOS and Linux the system shell is the default; set
`MERCURY_SHELL_ENGINE=brush`, or choose `brush` in `/config` under Shell
engine, to run the Bash tool on the bundled engine there too, with persistent
shell state.

A source build without the engine pack or Git for Windows still starts, but
the Bash tool is unavailable. The PowerShell tool remains available, and the
`shell` diagnostic explains how to restore Bash support.

## Build from source

Mercury builds with bun and runs on Node 24 LTS. Install [the source-build requirements](#requirements), including bun 1.3.x:

```sh
curl -fsSL https://bun.sh/install | bash           # macOS and Linux
powershell -c "irm bun.sh/install.ps1 | iex"       # Windows, in PowerShell 7
bun --version                                      # 1.3.x
```

Then, in a clone of this repository:

```sh
bun run setup                      # once; bun install + the vendored packs
bun run build.ts                   # writes dist/mercury.mjs + dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

### Terminal support

The full-screen interface needs a real TTY, but has no minimum terminal size.
The full layout starts at 100 columns by 26 rows; smaller windows use a
compact layout.

Mercury uses 24-bit colour when the terminal advertises support through
`COLORTERM=truecolor` or is recognised as iTerm2, Ghostty, WezTerm, Kitty,
Windows Terminal or VS Code. Other terminals use 256 colours, including
Apple's Terminal on macOS 15 and earlier.

The health check's Terminal color row reports the detected depth and the reason.
Set `MERCURY_TRUECOLOR=1` for a terminal that supports true colour but does not
advertise it, or `MERCURY_TRUECOLOR=0` to force 256 colours.

### Optional components

`setup` fetches the bundled capability packs: pyright, debugpy, js-debug,
extra grammars, the platform's Node runtime, and brush. If a download fails,
that pack is skipped and the build and affected tools report the missing
component. Running `bun install` alone produces a build without those packs.

To build voice support, run `setup` with Rust installed. That builds
`native/voice`. Add cmake to build `native/whisper` as well. With Rust
installed, `setup` also builds the desktop driver addon (`native/desktop`) that
the `Computer` tool runs through. With Rust installed,
`setup` also builds the local embedding addon (`native/embed`,
`bun run scripts/vendor/build-embed.ts`) and fetches the 118 MB BGE model
(`bun run scripts/vendor/fetch-embed-models.ts --default`); without cargo the
pack is skipped, setup says so, and Mneme memory lookup runs word match only.
Every release archive carries the embedding pack built for its platform;
on Linux and Windows the maths runs a
vectorised kernel, so a Recall by meaning takes about a tenth of a second (a
few hundredths on macOS, which uses Accelerate). If a native build
lacks its tools, setup skips it and the health check reports the missing
addon. The Windows shell engine is compiled on your machine too because
upstream has no Windows binary.

See [Windows shells](#windows-shells) and
[TERMINAL-RUNTIME.md](TERMINAL-RUNTIME.md) for the `brush` shell
engine.

The build writes only to `dist/`. Configuration and sessions live in
`~/.mercury`, or the directory set by `MERCURY_CONFIG_DIR`, and are created on
first run. On Windows, run `node dist\mercury.mjs` directly.

### Installing a source build as a command

`scripts/ops/deploy-runtime.sh` publishes a clean-tree build to a fresh
`<config home>/runtime/builds/<build>` folder and points `runtime/current` at it
(`runtime/dist` is the older name for the same link). `scripts/ops/deploy-launcher.sh`
installs the launcher at `<config home>/bin/mercury`. Add that directory to PATH; for zsh:

```sh
echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc
```

The launcher stops with an error if the runtime is missing. It does not
switch to another build. Node selection follows the order in
[Requirements](#requirements). For a release installation, run `mercury
install` or `mercury update`, which leave source checkouts unchanged; see
[Updates](#updates).

[AGENTS.md](../AGENTS.md) is the short build-and-run guide.
[BUILD-NOTES.md](../BUILD-NOTES.md) covers the build in more detail.
