# The crew

Every Mercury session can delegate work to crewmates through the `Crewmate`
tool, tracked live in `/crewmates` and `/runs` and reachable by id or name.

## The crew view

`/crewmates` opens the Crew view, listing the focused session's crewmates live
with name, model, status, tokens and elapsed time, one row each. Crewmates
follow the session's permission mode. On the board, `↵` opens a crewmate's row
in its own view, `m` makes a crewmate's chat the main one, `c` clears a
settled row, `r` resumes a stopped row, `x` twice stops a running row, and `p`
parks or resumes the crew at the next safe point. `Esc` or clicking the chat
outside the Crew view closes it (or returns from an opened row to the list
first); the same rule closes `/runs`, and closing a view never stops its work.

## The two spawn switches

Every session has two switches, Crewmates and Workflows, set in the Boot Menu's
Agents section for new sessions and sticky per session. With Crewmates off,
the `Crewmate` tool leaves that session's roster and any attempt to spawn one
from inside the session (the tool, a forking skill, a workflow agent hook, or
fleet tools) returns one receipt: `"crewmates are off for this session ·
/crewmates on, or the boot menu's Agents section"`. Workflows off does the same
for the `Workflow` tool while keeping `/runs` readable. The Session Concourse
still launches top-level sessions.

Inside a session, `/crewmates on|off` and `/workflows on|off` print their
two-line receipt in the chat at once. When no turn is running, the switch
takes effect immediately; while a turn runs, the runner applies the switch as
soon as that turn ends, ahead of any queued line waiting for the next turn, and
running spawns finish normally. Bare `/crewmates` opens the Crew view and bare
`/workflows` opens the board; `/health`'s **Crewmates & workflows** row reports
both switches and their sources.

The global setting **Crewmates while backgrounded** (off by default in the Boot
Menu's Agents section and `/config`) controls whether a backgrounded session
may launch crewmates and workflows. When off, a backgrounded session works
single-handed until you focus it or grant workflows-allowed; when on, it
launches under its own Crewmates and Workflows switches and permission mode
([SESSIONS.md](SESSIONS.md)).

## Starting a crewmate

A crewmate starts through the `Crewmate` tool, with or without a `name`. Named
crewmates accept follow-up work via `ResumeCrewmate` (running or finished) and
notes via `SendMessage` while running; unnamed crewmates return their report
and can be resumed by the id in their launch receipt. A crewmate runs the
model named at launch or the default from `/config`; a call naming the
parent's own family keeps the parent's exact model, another family uses that
family's preferred model, and an explicit model id keeps that choice.

To choose a model, the launching agent reads `mercury://models`:
`mercury://models` lists the providers the operator is signed into and the
models each reaches, read live (reporting the same selectable model count as
`/model` alongside any unavailable rows and their reasons), and
`mercury://models/known` lists the models this build knows from its pin tables,
marked as known instead of live. A family word (`grok`, `glm`, `kimi`,
`deepseek`, `muse`, `mistral`) runs that family's newest live row; when the
provider is signed in but its model list cannot be read, the word runs the
family's pinned default (xAI: Grok 4.7) and the launch receipt says so. An
exact id of a signed-in family runs when the live list names it (or when this
build knows it if the list is unreachable). When an id is on neither page, the
agent may use `WebSearch` on the provider's published models page (listed in
`mercury://models`) to inform its question and then ask the operator for the model id
with `AskUserQuestion` (web text never launches a model). A provider with no
sign-in refuses outright, naming `/logins`; no
launch ever moves to another provider on its own.

A `Crewmate` call may pass an existing absolute directory in `cwd`. Starting
outside the session's starting folder asks for ordinary permission (Sovereign
mode does not ask), and that directory becomes the crewmate's own single
starting folder. With `isolation: "worktree"`, Mercury cuts a temporary git
worktree from that directory's current HEAD commit (or freezes it at
`worktree_at`) without fetching from remotes, and links the parent checkout's
`node_modules` and ignored `vendor/<pack>` directories via `.git/info/exclude`
so builds and checks run without reinstalling. Parallel launches cut their
worktrees sequentially. A crewmate continued by a later message wakes in the
directory it was launched in; if that directory no longer exists, the
continuation runs in the session's own directory and the receipt notes the
fallback, naming the directory that is gone. Leftover worktrees are never
deleted automatically; the session lists their paths for you to review.

## Notices, stop, resume and usage limits

When a crewmate finishes, its completion notice row in the chat carries the
timestamp when the crewmate finished (`completedAt`) as its row clock. If the
notice is delivered to the parent turn a minute or more after completion, the
row appends `· delivered HH:MM:SS` as a second clock; deliveries within a
minute show the finish clock alone. Each crewmate row in `/crewmates` also
shows the count of unread notices (`2 unread`) waiting for its next turn
([SESSIONS.md](SESSIONS.md)).

`Esc` in the chat interrupts the main agent's turn alone; running crewmates and
workflows continue on their own controllers. To stop a crewmate or workflow,
select its row in `/crewmates` or `/runs` and press `x` twice within two
seconds. The runner aborts the crewmate's controller (or kills the workflow)
and reports whether the stop applied or was refused. Pressing `p` parks every
crewmate and the chat at the next safe point and resumes them on a second press.

Stopped crewmates keep their transcripts on disk; pressing `r` on the row or
calling `ResumeCrewmate` with the crewmate's name or id continues from its
transcript with the new message as its next turn. The main agent can also stop
a task or crewmate through `TaskStop` by task id, agent id or launch name.

If a provider refuses an image sent to a crewmate, the crewmate retries once
with `[image]` in place of the image. When a crewmate hits a provider usage
limit or overload, its row pauses with the provider's reset time (or probes at
a bounded cadence up to one hour on an overload) and resumes automatically with
the same model when the window reopens or another account signs in. Workflow
notifications summarize crewmate failures on their first line with the count
and first failure cause.

## Messages and file leases

`SendMessage` delivers a note to a running crewmate by launch id or name (or to
`main` from a background crewmate), read at the receiver's next tool boundary
or turn end; calling `SendMessage` on a finished crewmate refuses and points to
`ResumeCrewmate`. `ResumeCrewmate` resumes a completed, failed or stopped
crewmate from its transcript in the background (preserving any
`StructuredOutput` schema) or queues the message for a running one; if two
launches shared a name, it targets the newest.

Every session's in-process `mercury` MCP server provides exact repo-relative
file leases: `mcp__mercury__lease_take`, `mcp__mercury__lease_release` and
`mcp__mercury__lease_list`. A path held by another live agent is refused with
the holder named, and leases release automatically when the holder ends. The
same server provides `render_tui` for PTY screen captures.

## Roles, boards and the concourse

Two built-in agents lead the roster (`mercury roster`): `mercury-crew` has the
session's full tool set for general delegated work, and `mercury-scout` is
strictly read-only for codebase reconnaissance. Custom agent definitions live
in `.mercury/agents` and `/agents` (the Agent Studio); unknown stored crewmate
types resume as `mercury-crew`. `/verify` delegates an adversarial verification
brief ending in `VERDICT: PASS`, `FAIL` or `PARTIAL`; a `Crewmate` call with
`isolation: "worktree"`, `worktree_at` and `review_receipt` runs a frozen-tree
review that can write only the receipt's `## Review` section (`REVIEW: CLEAN`
or `REVIEW: FINDINGS <count>`).

`/runs` (alias `/tasks`) shows workflow runs and background shells; background
shells launched by a crewmate appear there and wake a crewmate waiting in
`Sleep` (up to one hour) as soon as its shells settle. `/crew` shows the agent
identity directory, `/sessions` lists project sessions, and `/concourse` opens
the Session Concourse ([SESSIONS.md](SESSIONS.md)), where the experimental
switchboard coordinator launches, watches, messages and reconciles sessions
through receipt rows without reaching inside a session's work.
