# Workspace trust

Workspace trust gates project hooks, helpers and MCP servers until you grant
trust for the directory, alongside permission modes and built-in command wards.

## What a grant is

A trust grant (`hasTrustDialogAccepted`) is stored per normalized directory path
in the global config. Grants cover all descendants, so trusting a repository
root covers its subdirectories and worktrees. Within a session, trust only
moves from absent to granted; accepting trust in `$HOME` applies to the
current session in memory only so `$HOME` is never trusted permanently.

## When Mercury asks and what the gate holds closed

Interactive boots evaluate trust after onboarding and show the trust dialog
whenever the working directory is not covered by a grant, regardless of
permission mode. The dialog names the directory (and the repository root when
inside a git repository), warns that project settings can run hooks, helper
commands and model instructions, and exits if declined. `/realms` manages
trusted project folders (`/realms add <path>`).

Until trust is granted in an interactive session (or in a headless `mercury run`
inside an untrusted folder):

- **No project hook runs** (tool events, session events or extension hooks).
- **No project `files.suggester` command runs.**
- **No project-scope `credentials.keyCommand`, MCP server or `headersHelper` runs.**
- **Project instruction scans and system-context prefetches wait** until trust
  is granted (user settings and managed policy still apply).

## Hidden characters in what the model reads

Instruction files (`MERCURY.md`, `@imports`, rules folders, `AGENTS.md`),
skill `SKILL.md` files and settings files load without modification and are
scanned for invisible characters that affect prompts (zero-width spaces and
joiners, bidirectional overrides and marks, soft hyphens, tag characters, bare
variation selectors and interior byte-order marks; standard emoji sequences and
Arabic or Indic joiners are allowed). `/health`'s **Hidden characters** row is
`ok` when clean or warns with each file, line, column and character class, and
the chat (or `stderr` in `mercury run`) prints a one-line warning at the next
turn. MCP tool descriptions have these characters stripped when listed.

## Starting folder and file permissions

The starting folder is the directory where the session begins (`cd` in the
shell changes the shell's working directory without moving the session's
starting folder). An agent launched in another directory or worktree has that
directory as its own starting folder.

- **Implement mode** allows ordinary writes and edits inside the starting
  folder. Outside it, Mercury asks for permission; approving the action lets
  it proceed.
- **Default mode** asks before writes and edits unless a permission rule allows
  them.
- **Sovereign mode** skips all permission cards (file paths, shell commands,
  Windows UNC paths, hook asks, computer-use actions, and changing or removing
  a pinned memory rule you asked for, which `/memory` records as changed under
  sovereign). Capability gates, explicit deny rules and built-in wards still
  apply, and model questions (`AskUserQuestion`, Apollo interviews) still
  appear.
- **Flow mode** allows what Implement mode allows plus read-only tools.
  Approving a permission card saves a project rule where possible; destructive
  calls always ask. Unanswered cards expire after ten minutes. Without a host,
  calls passing Flow's safety floors run while unapproved pushes, installs and
  destructive commands are refused.
- **Apollo and dontAsk** keep their own permission rules (`dontAsk` denies any
  call that would require a prompt).

On Windows, opening a UNC path (`\\server\share`) can send NTLM/Kerberos
credentials to a remote SMB or WebDAV host, so file and shell tools ask before
accessing UNC paths in every asking mode unless pre-authorised by a rule.

## Bash command permissions and user-private commands

The Bash tool parses commands, arguments and redirections before checking
permission rules, file boundaries and read-only allowlists. Quoted strings and
quoted heredocs are treated as data. Commands whose effect cannot be resolved
statically (such as command substitutions feeding a recursive delete, dynamic
paths, or unparsed syntax) require approval in asking modes and are denied in
hostless runs.

User-private slash commands (including `/daemon halt`, which interrupts
immediately) execute in the UI process alone and never enter the conversation
or model requests.

## Commands every session refuses

A built-in set of wards refuses destructive and
supply-chain command shapes before any permission prompt, in every mode
(interactive, headless `run`, crewmates and `mercury runner` sessions):

- **Supply-chain and persistence shapes**: auto-confirmed package runners
  (`npx -y`, `npm exec --yes`, `pnpm dlx -y`, `yarn dlx -y`), `pip`/`npm`/`pnpm`/`yarn`
  installs from a git URL pinned to a commit SHA, `curl … | bash` or `wget … | sh`,
  detached background spawns (`nohup … &`, `setsid … &`, `disown`; use the Bash
  tool's `run_in_background` parameter instead), `crontab` installs, systemd
  unit or XDG/macOS LaunchAgent persistence writes, global/system `git config`
  writes, `core.hooksPath` changes, and direct writes into `.git/config` or
  `.git/hooks/`.
- **Machine-destructive shapes**: privilege escalation (`sudo`, `doas`,
  `pkexec`), raw device writes (`dd of=/dev/…`), disk formatting or
  partitioning (`mkfs`, `fdisk`, `parted`, `diskutil erase`, `format`,
  `Format-Volume`, `Clear-Disk`, `Initialize-Disk`), system shutdown/reboot
  (`shutdown`, `reboot`, `halt`, `poweroff`, `Stop-Computer`,
  `Restart-Computer`), fork bombs, and recursive deletion of filesystem roots,
  home directories or system directories.

On macOS and Linux, the recursive-delete ward refuses `/`, `~`, `$HOME`,
`/Users`, `/Users/<name>`, `/home`, `/home/<name>`, `/root`, `/System`,
`/Library`, `/Applications`, `/Volumes/<name>` and system trees (`/etc`,
`/usr`, `/bin`, `/sbin`, `/var` outside `/var/tmp` and `/var/folders`). On
Windows, the same ward refuses drive roots (`C:\`), your own home, other users'
homes and the `Users` root (`C:\Users`, `C:\Users\<anyone>`), system folders
(`C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData`
at any depth), and share roots (`\\server\share`, `//server/share`) across
`rm -r`, `Remove-Item`/`ri`/`rd`/`rmdir`/`del`/`erase` with `-Recurse`, and
`rd`/`rmdir`/`del`/`erase` with `/s`, in either slash direction and any case,
including Git Bash `/c/Users` and `/c/Windows` paths and environment variables
(`%USERPROFILE%`, `%SystemDrive%`, `%HOMEDRIVE%`, `%HOMEPATH%`, `%SystemRoot%`,
`%windir%`, `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%ProgramW6432%`,
`%ProgramData%` and their `$env:` forms). On both platforms, deleting a home or
protected root through a PowerShell pipeline (`Get-ChildItem … | Remove-Item
-Recurse`) is refused by the same ward (`-WhatIf` previews remain allowed).
Recursive deletes inside your project, worktree or scratch directory, and words
inside quoted strings or heredocs, are unaffected.

`MERCURY_WARDS=warn` logs a transcript warning row instead of refusing (while
explicit deny rules still block), `MERCURY_WARDS=0` disables wards, and
`.mercury/wards.json` adds project-specific rules.

## Non-interactive sessions

Hosted sessions (`mercury runner`, `mercury acp`, daemon seats) send approval
requests to the host as `permission/request` (`holds_asks` lets the host manage
the clock; otherwise asks expire after 10 minutes in Flow or for crewmates, 3
minutes in Sovereign, or `MERCURY_PERMISSION_ASK_EXPIRY_MINUTES`, where `0`
disables expiry) and cancel expired asks with `$/cancel_request`.
No push is ever allowed by default under flow: `git push` requires a present
user or host unless pre-authorised by `Bash(git push *)` in `guardrails.allow`
or `--allowed-tools "Bash(git push *)"`.

In managed policy settings, `events.disabled` disables all hooks (including
managed ones), and `events.managedOnly` restricts hooks and `files.suggester`
to policy definitions. `guardrails.sovereignConsentSeen` is ignored in
repository `.mercury/settings.json` so a repository cannot pre-accept the
Sovereign consent dialog. `/health` reports the active Sovereign posture on its
`Sovereign mode` row.

## Release provenance: what "signed" means

From 1.0.0-beta.3 onward, every release archive's `manifest.json` carries an
Ed25519 signature under the compiled-in Mercury release key (`627b54b734ca0e72`)
covering the version, target platform, packaging timestamp, source tree SHA,
`mercury.mjs` SHA-256 and payload file digests. On macOS, the vendored `rg`
binary is copied and ad-hoc re-signed under `<config home>/cache/ripgrep/<digest>/rg`
on first use so the installed payload directory stays byte-identical to its
signed manifest.

`mercury update` and `mercury install` require a `signed` verdict before
staging or activating a release (`--allow-unsigned` accepts `unsigned` only and
records the exception; `unrecognized-key`, `malformed` and `tampered` are
always refused). Check signatures with `mercury health` (**Artifact signature**
and `--deep` **Payload signature**) or `node mercury/verify-artifact.mjs --deep`
(exit codes: `0` signed, `3` unsigned, `4` unrecognized-key, `5` tampered, `6`
malformed).
