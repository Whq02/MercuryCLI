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

Adjacent to workspace trust sits the bypass-permissions consent:
`skipDangerousModePermissionPrompt` is honoured from the user, local, flag, and
policy settings sources — the project source is deliberately excluded, so a
hostile repository cannot pre-accept the bypass-permissions dialog.

## The permission-posture record

The boot decision writes one composition record into the project config: whether
bypass is armed, what armed it (standing env consent, CLI flag, or session
choice), whether the consent dialog was shown or suppressed, and whether
workspace trust was accepted. A fresh config read alone answers "what permission
posture does this project run under".
