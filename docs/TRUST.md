# Workspace trust

Workspace configuration can ask Mercury to run things — hooks, helper commands,
server configs live in the folder being opened. Workspace trust is the gate in
front of all of it: until the operator grants trust for the directory, nothing a
workspace config file asked for gets to execute.

## What a grant is

A trust grant is a per-directory record (`hasTrustDialogAccepted`) persisted in
the project records of the global config, keyed by normalized path. A grant on a directory covers every descendant:
the read side walks ancestors, so trusting a repository root covers its
subfolders and worktrees without extra records.

Within a session, trust only ever transitions from absent to granted — never the
reverse. A granted verdict latches; an absent verdict is recomputed on every
check so a mid-session acceptance is picked up immediately.

The home directory is the one exception: accepting there keeps the grant in
session memory only, because persisting a grant on `$HOME` would trust
everything, forever.

## When Mercury asks

Interactive boot evaluates trust after onboarding, every time, and shows the
trust dialog whenever the working directory is not already covered by a grant. Permission mode does not change this — bypass
affects tool execution, not workspace trust.

The dialog names the directory, says to trust a folder only when you know what
is in it — its settings can run hooks and helper commands and its files can
carry instructions for the model — and states plainly that Mercury reads, edits
and runs files there.
When the directory sits inside a repository, it also states that the grant will
cover the whole repository — the persisted grant root is the project-config
path, the git root when one exists, and that sentence is derived live from the
same owner the write uses so the wording and the grant can never disagree.
Accepting records the grant (session-only in the home directory, persisted
everywhere else); declining exits Mercury.

The `/realms` surface manages trusted project folders directly: `/realms add
<path>` grants trust to a folder.

## What the gate holds closed

Until trust is granted in an interactive session:

- **No hook runs.** Every hook execution — tool events, session events, extension
  hooks — asks the trust gate first. The gate is blanket by design: the hooks
  config is captured before the trust dialog resolves, so rather than reasoning
  about which code paths could fire a hook pre-trust, every execution asks the
  one question.
- **The file-suggestion command does not run.** A configured `files.suggester`
  command is still a command from workspace config; pre-trust it is skipped and
  the suggestion list stays empty.
- **Project-scope credential helpers do not run.** A `credentials.keyCommand` configured
  in project or project-local settings is declined before trust, and an MCP server `headersHelper` from project or
  local scope is not executed — the server gets no dynamic headers and the
  refusal is logged.
- **Workspace reads wait.** The instruction-file scan warm-up and the
  system-context prefetch are deferred until the verdict.

## Starting folder and file permissions

The starting folder is the directory in which the session begins. A shell
`cd` changes where commands run, not that starting folder. An agent launched
in another folder, including a sibling worktree, has that folder as its own
starting folder.

- **Implement mode** allows ordinary writes and edits inside the starting
  folder. Outside it, Mercury asks for permission; approving the action lets
  it proceed.
- **Default mode** asks for writes and edits in either place unless a
  permission rule already allows them.
- **Sovereign mode** does not ask because of a file's
  location. Capability gates, explicit deny rules and wards still apply.
- **Flow, Apollo and dontAsk** keep their existing permission
  behaviour; a folder does not add a separate refusal.

Sensitive files, such as credentials and Mercury configuration, retain their
own permission checks. The sandbox is a separate feature and keeps its own
filesystem restrictions. A hosted runner puts a permission ask to its host;
without an answer, it is not approval. A hostless `mercury run` denies a
call that still needs approval after its rules and mode are applied.

## Commands that never reach the model

A user-private command runs on the screen alone, on every seat — it never
enters the session's conversation, never starts a turn, and never rides the
wire of a later turn. The dispatch rule folds a user-private command into the
screen seat, so a session runner's table never carries it. `/daemon halt` sits on the
same seat: the screen's brake fires interrupt-first, acting while a turn runs,
and never rides into a session runner.

## Commands every session refuses

A short list of command shapes never runs, whatever the permission mode and
whether or not anyone is watching: the tool call is refused before any
permission question, with a sentence in the tool result that names the rule
and tells the model to surface the refusal rather than rephrase around it;
the self-daemonizing shape's sentence also names the road it stands in for
— a long command runs with the Bash tool's `run_in_background` flag.
The list is the supply-chain shapes — an auto-confirmed `npx -y`, an install
from a git URL pinned to a commit, `curl … | bash`, a self-daemonizing
`nohup … &`, a crontab, systemd or autostart install, a write of the global
git config, of `core.hooksPath` or into `.git/hooks` — and the shapes that
destroy a machine — `sudo`, a raw write to a device, a disk format or
repartition, a shutdown or reboot, a fork bomb, and a recursive delete of the
filesystem root, the home directory or a system directory. Reads stay clear
(`git config --get`, `fdisk -l`, `diskutil list`), so does a recursive delete
inside the project or a scratch directory, and so does a script that only
mentions one of these words inside a quoted string or a heredoc. The same
list rides interactive, headless `run`, crew and runner sessions alike, and it never
stands down within a session. `MERCURY_WARDS=warn` lets a refuse-list hit
proceed and leaves one warning row on the transcript naming the ward, the
tool call and the match — painted in the session, recorded on a headless
run's transcript, and kept for a hosted chat or a resume — while project and
builtin rules still deny, even a call that matches both; `MERCURY_WARDS=0`
turns every ward off; project rules in `.mercury/wards.json` add to the list
and never remove from it.

## Non-interactive sessions

Headless sessions have no trust dialog. In a folder without a recorded trust
grant, `mercury run` proceeds without the project's instructions, hooks or MCP
servers. Project-scope API-key helpers do not execute there either. A trust
grant on the folder or an ancestor enables those project sources. The user's
own configuration and managed policy still apply.

A hosted session — a switchboard seat, an editor session or another
`mercury runner` — puts a call that needs approval to its host as
`permission/request`. The host answers allow or deny. A host declaring
`holds_asks` owns the ask's clock; otherwise the runner's no-progress limit
applies. A withdrawn ask sends `$/cancel_request`. The daemon declines an
ask when no operator is connected; the absence of an operator never grants
permission.

No push is ever allowed by default under flow. A call the flow check blocks
goes to that host, `git push` among them. It needs a present operator unless a permission rule
pre-authorises it: `Bash(git push *)` in `guardrails.allow`, or
`--allowed-tools "Bash(git push *)"` on a run, decides the push before any
ask. A deny rule refuses it outright; an ask rule requires approval under
that posture. A hostless `mercury run` has no one to answer, so an
unapproved ask is denied. The seat's boot posture tells the model which
calls need an operator and whether its rules pre-authorise a push.

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
policy settings sources — the project source is deliberately excluded, so a
hostile repository cannot pre-accept the Sovereign-mode consent dialog.

## The permission-posture record

The boot decision writes one composition record into the project config: whether
Sovereign mode — the one bypass — is armed, what armed it (the Boot Menu's
Sovereign mode row as standing consent, the CLI flag, or the session's own
choice), whether the consent dialog was shown or suppressed, and whether
workspace trust was accepted. A fresh config read alone answers "what permission
posture does this project run under"; `mercury health` and `/health` show it
as the `Sovereign mode` row. Computer use keeps one setting under the
posture, the Boot Menu's `Access type` row: unset, it follows Sovereign mode
(`full` with it on, `asks` with it off); a saved value wins either way
([COMPUTER-USE.md](COMPUTER-USE.md)).

## Release provenance — what "signed" means

Every release archive carries a `manifest.json`, and from 1.0.0-beta.3 on that
manifest carries a signature: an Ed25519 signature over the release record
(the version, the platform target, the packaging time, the source tree, the
SHA-256 of the runtime bundle and a digest of every other shipped byte). The
signing key is the Mercury release key, id `627b54b734ca0e72`, whose public
half is compiled into every build as its trust roster. The private key is held by the
operator alone: it never enters the repository, and it reaches the hosted
release workflow only as a repository secret for the packaging step.

Signing is advisory at boot and in `/health` and the health check: those checks
report the verdict without blocking a boot. It is a gate on an update or
install: `mercury update` and `mercury install` require a `signed` payload
under the Mercury release key in the compiled-in trust roster before staging
or activating the new payload. Every other verdict refuses at `verify`, names
the verdict and recovery, records it locally, and leaves the active installation
untouched. `--allow-unsigned` is the one explicit exception on either command:
it accepts `unsigned` only, never an unknown key, a malformed signature or
tampered bytes, and records the exception in both the result and receipt.
The trust roster is compiled into the verifier, not read from the environment.
For an unexpected refusal, check that roster and the official release, then
report it through the repository's Security tab.
The verdicts are:

- **signed** — a valid signature under the release key; the bytes are what
  was packaged. The launcher says nothing.
- **unsigned** — the manifest carries no signature. 1.0.0-beta.2 shipped this
  way: the hosted workflow never held the key, and every interactive launch of
  that release prints `mercury: provenance — unsigned …`. From 1.0.0-beta.3
  the launcher says it on a bare interactive boot (a plain `mercury`, no verb
  or flag) once per install — a marker beside the version pointer of the
  managed layout records that it was said; an archive run in place says it
  at every bare boot — and `mercury health` says it every time. Update and
  install refuse it unless `--allow-unsigned` is explicitly passed.
- **unrecognized-key** — a valid signature under a key that is not in this
  build's roster; update and install refuse it, including with `--allow-unsigned`.
- **malformed** — the signing block cannot be decoded; update and install
  refuse it, including with `--allow-unsigned`.
- **tampered** — the bytes differ from what was signed, or the signature does
  not verify; update and install refuse it before staging, including with
  `--allow-unsigned` — download the release again, and if it repeats report
  it through the repository's Security tab.

How to check:

- `mercury health` — the rows **Artifact signature** (the bundle's bytes) and
  **Payload signature** (`--deep`: the whole payload tree).
- From an extracted archive, the shipped verifier:
  `node mercury/verify-artifact.mjs --deep` prints the verdict and exits
  0 signed · 3 unsigned · 4 unrecognized-key · 5 tampered · 6 malformed.
- A release published without the key is a decision, never an accident: its
  archives end in `-unsigned`, its notes say so at the top, and `mercury
  update` in earlier installs does not pick them up.
