# Teams

Mercury runs multi-agent work as teams: named agents the operator chats
with, a durable file-backed mailbox between them, one role registry shared with
in-session subagents, and boards to watch it all. Team state is plain files
under `<config home>/teams`, and every load-bearing team operation is
journaled (see [DURABILITY.md](DURABILITY.md)).

## Teams on disk

A team lives at `<config home>/teams/<team>/`: `config.json` holds the roster
(one truth, locked writers), `inboxes/` the per-agent mailboxes, and `dedup/`
the consumption ledgers. A roster file that does not read as a roster is left
as it is and named on the health report's store quarantines row (bytes left
in place), and the team reads as absent until the file is repaired or
removed. Task lists live beside it under
`<config home>/tasks/<team>/`, and every spawn appends an audit row to the
spawn ledger. Team creation and deletion are multi-record journal operations —
an interrupted create rolls forward or compensates at the next boot rather
than leaving a half-team behind.

A team outlives its lead's session. When the lead exits — a quit, a closed
terminal, a signal — the team's config, inboxes and leases stay where they
are; only its pane-backed teammates are closed. Resuming the lead's session
finds the team on disk and the resumed session is part of it again, in the
cockpit and headless alike: TeamBrief names the team and its roster, the
Agent tool spawns into it, and TeamCreate refuses the name as one this
session already leads. Only TeamDelete removes a team (a headless lead
removes its own before its final answer). A create never answers success
without its config file on disk: a stale journal entry for a team whose
folder is gone is not replayed as a result, the team is created afresh.

## The two spawn switches

Every session carries two switches, Sub-agents and Workflows, set in the boot
menu's Agents section for the sessions born after the choice and sticky for
each session. With sub-agents off, the Agent tool is absent from that
session's roster — the model never sees it — and every road that would spawn
one from inside the session (the tool, a skill that forks, a workflow's agent
hooks, the fleet tools, the Crew view's spawn key) answers one receipt:
"sub-agents are off for this session — /subagents on, or the boot menu's
Agents section". Workflows off does the same for the Workflow tool and the
workflow launch roads; the run board stays readable. The concourse itself
keeps launching sessions and crew seats — the switches are per focused
session.

Inside a session, `/subagents on|off` and `/workflows on|off` (or the boot
menu opened there) flip a switch at the session's next turn boundary: the tool
leaves or rejoins the roster, a receipt says so, reasoning restarts on the
next turn, and a spawn already running finishes. Flipped while no turn runs,
the switch moves at once. Flipped while a turn runs, the receipt says the
switch applies when this turn ends, and the session's runner moves it at that
turn's end, before any line waiting for the next turn, so the next turn's
launches already read it; the session's record follows the runner's own word
that the switch moved, never a clock. A line sent after the flip, while the
same turn still runs, waits for the turn's end too and runs with the switched
roster. Plain `/subagents` reads both
switches with their sources; the doctor's "Sub-agents & workflows" row does
the same.

## Named agents and spawning

`/teammates` is the Crew view: the focused session's sub-agents live — name,
model, status, tokens, elapsed — and the named, long-lived agents the daemon
keeps for the repository, one color-coded chat each, side by side. There is
no eager boot spawn: every named agent is an explicit, billed operator act
through the spawn wizard.

The crew own their stop. Esc in the chat interrupts the chat's own turn and
nothing else: the sub-agents and workflows the turn launched keep running on
their own controllers, and the interrupted turn's receipt says how many. To
stop one, open the Crew view (or the `/tasks` board), select it and press `x`
twice within two seconds — the first press names the agent the second press
stops. The stop reaches every kind of row the same way: a dispatched
sub-agent's controller aborts and its running tool ends with it, a named
teammate's loop ends, a workflow run is killed. The receipt is the runner's
own word: applied once the row has left `running`, or refused with the
reason — an id the registry no longer holds, a row that had already settled,
a loop that did not end within the runner's settle budget — and a refusal is
painted under the rows. A stopped agent's row reads `stopped` with the reason
and its transcript stands on disk; `r` resumes it from that transcript under
the same id. A stopped teammate keeps no transcript to resume, so `r` on its
row spawns it again from its prompt under a new row. Every stop, resume and
failure reaches the main agent as a notification of its own kind, never
silently, a stop or resume from the crew view included. A teammate spawned
into a team that does not exist is refused, and no row is left standing for
it. The main agent's own door is
the TaskStop tool, which takes a task id, a named teammate's agent id
(`name@team`, the id its spawn receipt gave) or its bare name, or a launch
name.

A named teammate spawned into a team with the Agent tool is answered only
once its first turn has settled. A seat whose first dispatch fails — a
provider refusal, a spent window, an error before its first response — is
refused by name with the cause, is not on the roster, and a later message to
it is refused with the same cause instead of landing in an inbox nobody
reads. A seat that fails later leaves the roster the same way, so the team
view and the brief never list a dead seat as running. When an Agent call
names the parent's own model family, its sub-agent or named teammate keeps
the parent's exact model. Engine models still pass their provider's dispatch
checks. A different family keeps that family's preferred model; an exact
model id keeps its explicit choice.

An Agent call may name the directory its sub-agent works in with `cwd`: an
absolute directory that exists. A directory inside a workspace the session
already trusts — one of the session's working directories, or a folder the
operator has trusted — is used as named. Any other folder is a permission
question to the operator, asked once per folder per session with the folder
named: yes launches the sub-agent there, no leaves it unlaunched, and in
sovereign mode the question answers itself yes. The sub-agent's shell, its
file tools and its environment section start there. A missing directory is
refused before anything is launched, and a named teammate spawn does not take
the parameter. With `isolation: "worktree"` the temporary worktree is cut from
that directory's repository and the sub-agent runs in the worktree. A
sub-agent's worktree carries links to its parent checkout's `node_modules`
and to each `vendor/<pack>` the checkout ignores, hidden from git through the
clone's exclude file, so the sub-agent builds and runs the checks there
without an install, and a worktree it left otherwise untouched still cleans
itself up. A sub-agent continued by a later message wakes in the directory it
was launched in: the launch records the directory beside the transcript and
the continuation reads it back; a recorded directory that no longer exists
puts the continuation in the session's own directory, and the message's
receipt says so, naming the directory that is gone. The same note accompanies
an automatic resume, a crew resume and queued guidance, and the continued
sub-agent receives it in its own prompt.

A workflow that ends with agent failures says so in the first line of its
notification: the count, then the first failing agent and its cause — an
error's words, a refusal's stop reason — and its run record carries the
same failure lines beside the per-agent rows.

Named agents spawn on demand over the daemon's authed control socket. The RPC
carries only intent — a name and a model choice — and the daemon enforces the
policy server-side, where a client bug cannot bypass it:

- a validated model table: every row a session may run on this account, no
  family and no tier refused;
- permission mode `flow` — classifier-adjudicated asks — unless the operator's
  `MERCURY_DAEMON_PERMISSION_MODE` says otherwise;
- a read-only reconnaissance tool allowlist;
- child environment that prevents a named agent from fanning out workflow
  DAGs of its own;
- a name allowlist (`[a-z0-9-]` — the name reaches file paths and env);
- a spend guard: at most six live named agents, enforced at the spawn itself.

`MERCURY_CREW=0` disables the board and refuses the spawn RPC.

## The mailbox

Each (team, agent) pair has one inbox file:
`<teams>/<team>/inboxes/<agent>.json`, a bare JSON array of messages. Versioning is structural — every element is
validated on read, unknown fields are tolerated, and no field may become
required — because builds of different vintages run concurrently against the
same inboxes.

A send lands durably and exactly once: every message carries its own id and
sequence, and a crash between delivery and acknowledgement replays as a
no-op instead of a duplicate act. Operator messages to a named agent ride
this bus, and its replies ride its own SendMessage into the lead's inbox.

One delivery rule guards permission posture: inbound agent messages arriving
while the session runs in a bypass-permissions mode are held, visibly, until
the operator returns to a prompting mode (`MERCURY_INBOX_HOLD_BYPASS`); in
prompting modes messages deliver as always.

## File leases

Teammates keep off each other's files with leases, through the coordination
tools every session carries as `mcp__mercury__lease_claim`,
`mcp__mercury__lease_release`, `mcp__mercury__lease_list` and
`mcp__mercury__lease_take`. The list a lease verb takes is called `paths` on
every one of them: repo-relative file paths, and for the team lease a path may
be a glob, a pattern ending in `/**` that covers a folder and everything beneath it. A claim or a release sent with the older word
`globs` is read as the same list, and a claim sent with neither is refused
with words that name both. A team claim renews the caller's lease and replaces
its set; claiming an empty set releases it. `lease_take` and a `lease_release`
with a list act on exact project files and need no team; a `lease_release`
with no list drops the caller's team lease. Another live holder is named and
refused, and an edit under another agent's lease is denied before it runs.

## Roles

Named-agent roles resolve through one resolver, whichever way the agent launches. A role is an agent definition — built-in,
custom, or from an extension — the same registry the in-session subagent tool
loads, so a given role is the same agent no matter how it was launched. `/agents` opens the Agent Studio for
building and tuning those definitions.

The living-crew directory (`/crew`) is the
canonical agent-identity registry: it binds agent principals, seat, roster and
crew forms, provider identities, and external adapter seats into stable crew
agent ids with role links. Identity derives from the founding binding, so a
rename, reconnect, or restart never mints a duplicate.

## Boards

`/team` opens the crew board on `/tasks` — the named agents, their phases and
handoffs. `/teammates` is the Crew view: the session's sub-agents live, and the
named agents' chats; each sub-agent row carries the count of notices delivered
to it that no turn of its own has read yet ([SESSIONS.md](SESSIONS.md), "A
notice an agent has not read"). A command a sub-agent runs in the background
is a shell task of the session like any other: it has its row on the `/tasks`
board while it runs, the session's waiting line counts it, and when it
finishes the notice goes to the agent that launched it, read at that agent's
next turn. A sub-agent with nothing to do until then waits with the Sleep
tool, which every sub-agent's roster carries, in a foreground and a
background run alike: the wait names a ceiling (at most an hour, the same as
the session's own) and ends the moment the shells that sub-agent launched
settle, so the notice is read at that boundary and never after a full timer.
`/crew` shows the directory with presence and external
seat attach/detach. `/sessions` manages this project's sessions, including
named-agent chats.

## The concourse

The Session Concourse — the board of the project you are in (its running
sessions and its parked chats), the hop into a row, the live tiles, NEEDS
YOU, the pings bell, the strip that walks only the screens that exist, and
how chats are born, focused, closed and brought back — is
[SESSIONS.md](SESSIONS.md)'s page. This section is the coordinator behind
the board.

Behind the board sits the switchboard coordinator: one terminal, the
operator, and their Mercury sessions running beside each other. The
coordinator launches, watches, messages, pauses, resumes, queues and
reconciles sessions and answers questions from the repository it sits on; it
never does a session's work or reaches inside one, and every verb settles as
a receipt row the operator sees. The coordinator surface is experimental and
says so itself on the board: trust receipts, never assumed success.
