# Workspace trust

Workspace trust gates project hooks, credential helpers, and project MCP
servers until you trust the folder, alongside permission modes and built-in
command safety rules.

Workspace configuration can ask Mercury to run things: hooks, helper commands,
and server configs live in the folder being opened. Until you grant trust for
the directory, nothing a workspace config file asked for gets to execute.

## What a grant is

A trust grant is a per-directory record (`hasTrustDialogAccepted`) persisted in
the project records of the global config, keyed by normalized path. A grant on a directory covers every descendant:
the read side walks ancestors, so trusting a repository root covers its
subfolders and worktrees without extra records.

Within a session, trust only ever transitions from absent to granted.
A granted verdict latches; an absent verdict is recomputed on every
check so a mid-session acceptance is picked up immediately.

The home directory is the one exception: accepting there keeps the grant in
session memory only, because persisting a grant on `$HOME` would trust
everything, forever.

## When Mercury asks

Interactive boot evaluates trust after onboarding, every time, and shows the
trust dialog whenever the working directory is not already covered by a grant. Permission mode does not change this: bypass
affects tool execution while workspace trust remains required.

The dialog names the directory, says to trust a folder only when you know what
is in it (its settings can run hooks and helper commands and its files can
carry instructions for the model), and states plainly that Mercury reads, edits
and runs files there.
When the directory sits inside a repository, it also states that the grant will
cover the whole repository (the persisted grant root is the project-config
path, the git root when one exists, and that sentence is derived live from the
same owner the write uses so the wording and the grant always match).
Accepting records the grant (session-only in the home directory, persisted
everywhere else); declining exits Mercury.

The `/realms` surface manages trusted project folders directly: `/realms add
<path>` grants trust to a folder.

## What the gate holds closed

Until trust is granted in an interactive session:

- **No hook runs.** Every hook execution (tool events, session events, extension
  hooks) asks the trust gate first. The gate is blanket by design: the hooks
  config is captured before the trust dialog resolves, so every execution asks the
  one question.
- **The file-suggestion command does not run.** A configured `files.suggester`
  command is still a command from workspace config; pre-trust it is skipped and
  the suggestion list stays empty.
- **Project-scope credential helpers do not run.** A `credentials.keyCommand` configured
  in project or project-local settings is declined before trust, and an MCP server `headersHelper` from project or
  local scope is not executed (the server gets no dynamic headers and the
  refusal is logged).
- **Workspace reads wait.** The instruction-file scan warm-up and the
  system-context prefetch are deferred until the verdict.

## Hidden characters in what the model reads

Instruction files (MERCURY.md and what it `@imports`, the rules folders,
AGENTS.md where it stands in), skills' SKILL.md files and the settings files
are read as written; Mercury never edits or refuses them. Each one is scanned
as it loads for characters a reader cannot see but a model reads: zero-width
spaces and joiners, direction overrides and marks, soft hyphens, tag
characters, variation selectors with nothing to vary, a byte-order mark inside
the text. Emoji sequences, keycaps, subdivision flags and the joiners inside
Arabic and Indic words are not findings. `/health` carries the row **Hidden
characters**: ok when nothing was found, otherwise a warning naming each file,
line, column and class in plain words ("an invisible character", "a direction
override"), with the files left exactly as they were. The chat gets one warning
line at the start of the next turn after such a file loads, said once until the
finding changes; a headless run prints the same line to stderr. MCP tool
definitions are stripped of these characters when a server lists them; the row
says when a server sent them, and that variation selectors survive the strip.

## Starting folder and file permissions

The starting folder is the directory in which the session begins. A shell
`cd` changes where commands run while leaving that starting folder unchanged. An agent launched
in another folder, including a sibling worktree, has that folder as its own
starting folder.

- **Implement mode** allows ordinary writes and edits inside the starting
  folder. Outside it, Mercury asks for permission; approving the action lets
  it proceed.
- **Default mode** asks for writes and edits in either place unless a
  permission rule already allows them.
- **Sovereign mode** asks nothing: not one permission card of any kind,
  including for a file's location, a command, a remote path on Windows, a
  hook's ask, the first act in an application, or changing or removing a pinned
  memory rule you asked for (which `/memory` records as changed under
  sovereign). You accept every risk; Flow mode is where
  the guardrails live. Capability gates, explicit deny rules and built-in command safety rules still
  apply, and a refusal is not a card. The model's own questions to you
  (AskUserQuestion, the Apollo review) are not permission cards and still
  appear.
- **Flow mode** allows what Implement mode allows and the read-only
  tools without asking. A yes on a permission card is remembered as a saved
  rule for the project where a rule can name the call; destructive calls
  always ask. A card unanswered for ten minutes is withdrawn and the call is
  refused with a denial the model reads (nobody answered within the limit;
  work that does not depend on the action continues). With no host, calls
  that pass Flow's floors and safety checks run without a card; unapproved
  pushes, installs and destructive calls do not. Broad dangerous allow rules
  are set aside while Flow is on.
- **Apollo and dontAsk** keep their existing permission
  behaviour; a folder does not add a separate refusal.

On Windows, a UNC path can send this machine's login to a remote SMB/WebDAV host: shell and file tools ask before opening it, including a share-hosted workspace, unless an explicit path or command rule grants access (in every mode that asks; Sovereign mode does not).

Sensitive files, such as credentials and Mercury configuration, retain their
own permission checks. A hosted runner puts a permission ask to its host;
without an answer, it is not approval. A hostless `mercury run` denies a
call that still needs approval after its rules and mode are applied.

## Bash command permissions

Bash reads a command with a shell parser before deciding whether it may run.
The parsed commands, arguments and redirections are checked against permission
rules, file access and the listed read-only forms. Quoted punctuation and a
quoted heredoc body are treated as data and never parsed as shell commands.

A command whose effect cannot be established asks for approval and names the
construct and a way to make it explicit. This includes a command substitution
feeding a recursive delete, a path supplied at runtime, and syntax the parser
cannot read. An unavailable parser returns an ordinary permission ask instead of
a read-only approval. Sovereign mode may answer that ask; a mode that still asks
needs a host to approve it, and a hostless call is refused. Deny rules still
win over an ask or an allow; file restrictions still apply.

## Commands that never reach the model

Private slash commands run locally in the terminal UI and are never sent to the
model: they never enter the session's conversation, never start a turn, and
never travel on a later turn. The dispatcher handles user-private commands in
the terminal UI, so a session runner's command table never carries them.
`/daemon halt` runs in the terminal UI the same way: it interrupts immediately
even while a turn is running, without routing through a session runner.

## Commands every session refuses

Built-in command safety rules (`wards`) refuse destructive shell commands in
every permission mode, whether or not anyone is watching: the tool call is
refused before any permission question, with a sentence in the tool result that
names the rule and tells the model to surface the refusal instead of rephrasing
around it. The self-daemonizing refusal also points to the Bash tool's
`run_in_background` flag for long commands.
The refused commands cover supply-chain shapes (an auto-confirmed `npx -y`, an
install from a git URL pinned to a commit, `curl … | bash`, a self-daemonizing
`nohup … &`, a crontab, systemd or autostart install, a write of the global
git config, of `core.hooksPath` or into `.git/hooks`) and commands that
destroy a machine (`sudo`, a raw write to a device, a disk format or
repartition, a shutdown or reboot, a fork bomb, and a recursive delete of the
filesystem root, the home directory or a system directory). On macOS and Linux,
the recursive-delete rule refuses `/`, `~`, `$HOME`, `/Users`, `/Users/<name>`,
`/home`, `/home/<name>`, `/root`, `/System`, `/Library`, `/Applications`,
`/Volumes/<name>` and system trees (`/etc`, `/usr`, `/bin`, `/sbin`, `/var`
outside `/var/tmp` and `/var/folders`). On Windows, the same rule refuses drive
roots (`C:\`), your own home, other users' homes and the `Users` root
(`C:\Users`, `C:\Users\<anyone>`), system folders (`C:\Windows`, `C:\Program
Files`, `C:\Program Files (x86)`, `C:\ProgramData` at any depth), and share
roots (`\\server\share`, `//server/share`) across `rm -r`,
`Remove-Item`/`ri`/`rd`/`rmdir`/`del`/`erase` with `-Recurse`, and
`rd`/`rmdir`/`del`/`erase` with `/s`, in either slash direction and any case,
including Git Bash `/c/Users` and `/c/Windows` paths and environment variables
(`$USERPROFILE`, `%USERPROFILE%`, `%SystemDrive%`, `%HOMEDRIVE%`, `%HOMEPATH%`,
`%SystemRoot%`, `%windir%`, `%ProgramFiles%`, `%ProgramFiles(x86)%`,
`%ProgramW6432%`, `%ProgramData%` and their `$env:` forms). On both platforms,
deleting a home or protected root through a PowerShell pipeline
(`Get-ChildItem … | Remove-Item -Recurse`) is refused by the same ward
(`-WhatIf` previews remain allowed). A delete of any kind inside another
user's home is refused by its own ward (`no-other-user-delete`) in every
permission mode, sovereign included: `rm` with or without `-r`, `Remove-Item`,
`del`, `rd`, `find … -delete`, and a pipeline into `Remove-Item`, for
`/Users/<other>`, `/home/<other>`, `C:\Users\<other>` and Git Bash
`/c/Users/<other>` in any spelling; your own home and the folder the session
started in are not that ward's business, and a listing or a read of another
user's folder stays with the ordinary permission check.
Reads stay clear
(`git config --get`, `fdisk -l`, `diskutil list`), so does a recursive delete
inside the project or a scratch directory, and so does a command that only
mentions one of these words inside a quoted string or a heredoc written to a
file (a search pattern, an echo, a commit message). A quoted path
after a delete verb is still the delete, an inline shell string (`bash -c "…"`,
`eval`, `Invoke-Expression`) or a heredoc fed to a shell (`bash <<'EOF'`,
`cat <<EOF | sh`) is read as the commands it runs, and a command split over
several lines with a trailing backslash, pipe or `&&` is read as the one line
the shell runs (a comment never continues a line). The same
list rides interactive, headless `run`, crew and runner sessions alike, and it never
stands down within a session. `MERCURY_WARDS=warn` lets a refuse-list hit
proceed and leaves one warning row on the transcript naming the ward, the
tool call and the match (shown in the session, recorded on a headless
run's transcript, and kept for a hosted chat or a resume), while project and
builtin rules still deny, even a call that matches both; `MERCURY_WARDS=0`
turns every ward off; project rules in `.mercury/wards.json` add to the list
and never remove from it.

## Safety floors

Five safety floors hold alongside the permission modes and wards:

- Writes to credential stores are refused unless an exact path rule grants them.
- Agent reads of Mercury's own stored credentials are refused.
- Cloud-metadata addresses are refused in `WebFetch` and `Browser`.
- Mercury's running binary and daemon are protected against writes, deletes and kills.
- Writing project instruction files or reading `.env` files asks for approval first.

## Non-interactive sessions

Headless sessions have no trust dialog. In a folder without a recorded trust
grant, `mercury run` proceeds without the project's instructions, hooks or MCP
servers. Project-scope API-key helpers do not execute there either. A trust
grant on the folder or an ancestor enables those project sources. The user's
own configuration and managed policy still apply.

A project MCP server (one defined in `.mercury/mcp.json`) needs more than the
trust grant: it starts in a headless run, and in `mercury mcp list` and
`mercury mcp get`, only after you approved it on the card an interactive start
in that folder shows, or with `kit.trustProjectServers` set in your user or
local settings. The approval is keyed to the server's definition as written
(its command, arguments, URL and environment variable names), so a changed
definition is asked about again. Until a server is approved, a run skips it,
says so on stderr and in a `notice` row, and continues.

A hosted session (a daemon-hosted session, an editor session or another
`mercury runner`) puts a call that needs approval to its host as
`permission/request`. The host answers allow or deny. A host declaring
`holds_asks` holds the ask; otherwise the runner's no-progress limit
applies. In either case a headless runner refuses an ask nobody answers
within its clock (ten minutes in Flow, three in Sovereign; a crewmate's ask
ten minutes in every other mode; a session's own ask in Default, Implement
or Apollo waits for you) and withdraws the ask with `$/cancel_request`
naming the expiry. `MERCURY_PERMISSION_ASK_EXPIRY_MINUTES` replaces every
clock that exists (0 disables them). An oculus session is one you started
from the screen ([SESSIONS.md](SESSIONS.md), Oculus). Its asks have no expiry
in any mode and wait until you answer or end the session.
The daemon declines an ask when no user is connected; the absence of a user
never grants permission.

No push is ever allowed by default under flow. A call Flow's rules leave
over goes to that host, `git push` among them. It needs a present user unless a permission rule
pre-authorises it: `Bash(git push *)` in `guardrails.allow`, or
`--allowed-tools "Bash(git push *)"` on a run, decides the push before any
ask. A deny rule refuses it outright; an ask rule requires approval under
that posture. A hostless `mercury run` has no one to answer, so an
unapproved ask is denied. The session's boot posture tells the model which
calls need a user and whether its rules pre-authorise a push.

## What managed policy changes

Managed policy settings tighten the hook surface beyond the trust gate:

- `events.disabled` in policy settings disables every hook, managed ones
  included.
- `events.managedOnly` restricts execution to hooks the policy settings
  define. The same posture takes effect when non-managed settings disable all
  hooks while policy does not. Under managed-only, the file-suggestion command
  likewise runs only from policy settings.

Adjacent to workspace trust sits the Sovereign-mode consent:
`guardrails.sovereignConsentSeen` is honoured from the user, local, flag, and
policy settings sources (the project source is deliberately excluded, so a
hostile repository cannot pre-accept the Sovereign-mode consent dialog).

## The permission-posture record

The boot decision writes one composition record into the project config: whether
Sovereign mode (the bypass mode) is armed, what armed it (the Boot Menu's
Sovereign mode row as standing consent, the CLI flag, or the session's own
choice), whether the consent dialog was shown or suppressed, and whether
workspace trust was accepted. A fresh config read alone answers "what permission
posture does this project run under"; `mercury health` and `/health` show it
as the `Sovereign mode` row. While the Boot Menu's `Sovereign mode` row is
on, a small amber warning line sits under it stating that nothing asks or stops
you and every action runs as you. Computer use follows the posture too: with
Sovereign mode on nothing asks, whatever the Boot Menu's `Access type` row
saves; with it off the row decides (`asks` by default)
([COMPUTER-USE.md](COMPUTER-USE.md)).

## Release signatures

Every release archive carries a `manifest.json` with an Ed25519 signature over the release record
(the version, the platform target, the packaging time, the source tree, the
SHA-256 of the runtime bundle and a digest of every other shipped byte). The
signing key is the Mercury release key, id `627b54b734ca0e72`, whose public
half is compiled into every build as its trust roster.

Signing is advisory at boot and in `/health` and the health check: those checks
report the verdict without blocking a boot. It is a gate on an update or
install: `mercury update` and `mercury install` require a `signed` payload
under the Mercury release key in the compiled-in trust roster before staging
or activating the new payload. Every other verdict refuses at `verify`, names
the verdict and recovery, records it locally, and leaves the active installation
untouched. `--allow-unsigned` is the one explicit exception on either command:
it accepts `unsigned` only, never an unknown key, a malformed signature or
tampered bytes, and records the exception in both the result and receipt.
The trust roster is compiled into the verifier and never read from the environment.
For an unexpected refusal, check that roster and the official release, then
report it through the repository's Security tab.
The verdicts are:

- **signed**: a valid signature under the release key; the bytes match what
  was packaged. The launcher says nothing.
- **unsigned**: the manifest carries no signature. Update and install refuse
  it unless `--allow-unsigned` is explicitly passed.
- **unrecognized-key**: a valid signature under a key that is not in this
  build's roster; update and install refuse it, including with `--allow-unsigned`.
- **malformed**: the signing block cannot be decoded; update and install
  refuse it, including with `--allow-unsigned`.
- **tampered**: the bytes differ from what was signed, or the signature does
  not verify; update and install refuse it before staging, including with
  `--allow-unsigned`. Download the release again, and if it repeats report
  it through the repository's Security tab.
An installed payload is never written after install. On macOS the vendored
search binary ships with the linker's own ad-hoc signature; the first search
re-signs a copy of it under the config home (`cache/ripgrep/<digest>/rg`,
keyed by the shipped file's digest) and runs that copy, so the payload stays
byte for byte what was signed: a clean install reads `signed` at every depth,
and `tampered` means the bytes really changed.

How to check:

- `mercury health`: the rows **Artifact signature** (the bundle's bytes) and
  **Payload signature** (`--deep`: the whole payload tree).
- From an extracted archive, the shipped verifier:
  `node mercury/verify-artifact.mjs --deep` prints the verdict and exits
  0 signed · 3 unsigned · 4 unrecognized-key · 5 tampered · 6 malformed.
- A release published without the key is a decision, never an accident: its
  archives end in `-unsigned`, its notes say so at the top, and `mercury
  update` in earlier installs does not pick them up.
