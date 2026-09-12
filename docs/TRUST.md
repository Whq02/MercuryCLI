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

The dialog names the directory, asks whether it is a folder you created or
trust, and states plainly that Mercury will read, edit, and run the files there.
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
- **The file-suggestion command does not run.** A configured `fileSuggestion`
  command is still a command from workspace config; pre-trust it is skipped and
  the suggestion list stays empty.
- **Project-scope credential helpers do not run.** An `apiKeyHelper` configured
  in project or project-local settings is declined before trust, and an MCP server `headersHelper` from project or
  local scope is not executed — the server gets no dynamic headers and the
  refusal is logged.
- **Workspace reads wait.** The instruction-file scan warm-up and the
  system-context prefetch are deferred until the verdict.

## Commands that never reach the model

`/note`, `/minerva`, `/remember`, and — when the Taste Loop is on — `/good`
and `/meh` are user-private: the line runs on the screen alone, on every
seat — it never enters the session's conversation,
never starts a turn, and never rides the wire of a later turn; it lands in the
project notepad or the memory estate and nothing else sees it (`/minerva`
spends one call on the Minerva container alone). The dispatch rule folds a
user-private command into the screen seat, so a session runner's table never
carries it. `/halt` sits on the
same seat: the screen's brake fires interrupt-first, acting while a turn runs,
and never rides into a session runner.

## Non-interactive sessions

Headless and SDK sessions have no trust dialog; trust is implicit in having
been embedded, so the hook gate stays open there and project-scope helpers run.

## What managed policy changes

Managed policy settings tighten the hook surface beyond the trust gate:

- `disableAllHooks` in policy settings disables every hook, managed ones
  included.
- `allowManagedHooksOnly` restricts execution to hooks the policy settings
  define. The same posture takes effect when non-managed settings disable all
  hooks while policy does not. Under managed-only, the file-suggestion command
  likewise runs only from policy settings.

Adjacent to workspace trust sits the Sovereign-mode consent:
`skipSovereignConsentPrompt` is honoured from the user, local, flag, and
policy settings sources — the project source is deliberately excluded, so a
hostile repository cannot pre-accept the Sovereign-mode consent dialog.

## The permission-posture record

The boot decision writes one composition record into the project config: whether
Sovereign mode — the one bypass — is armed, what armed it (the Boot Menu's
Sovereign mode row as standing consent, the CLI flag, or the session's own
choice), whether the consent dialog was shown or suppressed, and whether
workspace trust was accepted. A fresh config read alone answers "what permission
posture does this project run under"; `mercury doctor` and `/health` show it
as the `Sovereign mode` row.

## Release provenance — what "signed" means

Every release archive carries a `manifest.json`, and from 1.0.0-beta.3 on that
manifest carries a signature: an Ed25519 signature over the release record
(the version, the platform target, the packaging time, the source tree, the
SHA-256 of the runtime bundle and a digest of every other shipped byte). The
signing key is the Mercury release key, id `627b54b734ca0e72`, whose public
half is compiled into every build as its trust roster. The private key is held by the
operator alone: it never enters the repository, and it reaches the hosted
release workflow only as a repository secret for the packaging step.

Signing is advisory at boot and in `/health` and the doctor: those checks
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
  at every bare boot — and `mercury doctor` says it every time. Update and
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

- `mercury doctor` — the rows **Artifact signature** (the bundle's bytes) and
  **Payload signature** (`--deep`: the whole payload tree).
- From an extracted archive, the shipped verifier:
  `node mercury/verify-artifact.mjs --deep` prints the verdict and exits
  0 signed · 3 unsigned · 4 unrecognized-key · 5 tampered · 6 malformed.
- A release published without the key is a decision, never an accident: its
  archives end in `-unsigned`, its notes say so at the top, and `mercury
  update` in earlier installs does not pick them up.
