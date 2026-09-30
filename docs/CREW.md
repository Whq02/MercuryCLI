# The crew

Every Mercury session has a crew from the moment it starts: the sub-agents it
delegates to, the named crewmates it starts and chats with, and the daemon's
named seats, all on one roster. There is no create step and no delete step —
the crew is born with the session and its helpers are tracked live, not
through files that must be set up first. Boards show it all; live
communication carries its messages, tasks, file claims and who is busy.

## The crew view

`/crewmates` is the Crew view (`/crewmates` still opens it, as the old name):
the focused session's sub-agents live — name, model, status, tokens,
elapsed — and the named, long-lived crewmates the daemon keeps for the
repository, one color-coded chat each, side by side. It is the one roster
screen: there is no separate members dialog, and no per-member permission
switch — crewmates follow the lead's permission mode. There is no eager boot
spawn: every named crewmate is an explicit, billed operator act through the
spawn wizard. Esc or a click on the chat outside the Crew view closes it; from
an opened crewmate card, either returns to the list first. The same rule
closes the `/runs` board. Closing a view never stops its work.

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

## Starting a crewmate

Starting a crewmate takes a name, a working folder, an optional git worktree
and a model, and every door — the Agent tool with a name, the Crew view's
spawn key, the daemon's seat — goes through the same road. The model is the
one the operator names; no crewmate's model is chosen for it or changed in a
resume. A named crewmate is answered only once its first turn has settled. A
crewmate whose first dispatch fails — a provider refusal, a spent window, an
error before its first response — is refused by name with the cause and is
not on the roster; a later message to it is refused with the same cause
instead of starting it again — a crewmate that failed is started again by
the Agent tool or resumed with `r`, never by a message. A crewmate that fails
later leaves the roster the same way, so the Crew view never lists a dead
seat as running. When an Agent call names the parent's own model family, its
sub-agent or named crewmate keeps the parent's exact model. Engine models
still pass their provider's dispatch checks. A different family keeps that
family's preferred model; an exact model id keeps its explicit choice.

An Agent call may name the directory its sub-agent works in with `cwd`: an
absolute directory that exists. Starting outside the session's starting
folder asks for ordinary permission: yes launches the sub-agent there, no
leaves it unlaunched. Sovereign mode does not ask. The sub-agent's shell,
file tools and environment section start there, and that directory is its
own single starting folder. A missing directory is
refused before anything is launched. With `isolation: "worktree"` the
temporary worktree is cut from that directory's repository at the commit that
directory's checkout is on — the branch the lead works in, never a remote's
copy of it, with nothing fetched — or, with `worktree_at`, frozen at the named
commit; and the sub-agent runs in the worktree. Several sub-agents launched
together each get their own worktree, cut one after another. A sub-agent's
worktree carries links to its parent
checkout's `node_modules` and to each `vendor/<pack>` the checkout ignores,
hidden from git through the clone's exclude file, so the sub-agent builds and
runs the checks there without an install. A sub-agent continued by a later
message wakes in the directory it was launched in: the launch records the
directory beside the transcript and the continuation reads it back; a
recorded directory that no longer exists puts the continuation in the
session's own directory, and the message's receipt says so, naming the
directory that is gone. The same note accompanies an automatic resume, a crew
resume and queued guidance, and the continued sub-agent receives it in its
own prompt.

Nothing is deleted automatically. When crewmates are cleaned up, their
worktrees and folders stay where they are and the lead gets a reminder
naming each leftover worktree by its path; what to remove is the lead's
decision.

Named crewmates spawn on demand over the daemon's authed control socket. The
RPC carries only intent — a name and a model choice — and the daemon
enforces the policy server-side, where a client bug cannot bypass it:

- a validated model table: every row a session may run on this account, no
  family and no tier refused;
- permission mode `flow` — classifier-adjudicated asks — unless the operator's
  `MERCURY_DAEMON_PERMISSION_MODE` says otherwise;
- a read-only reconnaissance tool allowlist;
- child environment that prevents a named crewmate from fanning out workflow
  DAGs of its own;
- a name allowlist (`[a-z0-9-]` — the name reaches file paths and env);
- a spend guard: at most six live named crewmates, enforced at the spawn
  itself.

`MERCURY_CREW=0` disables the board and refuses the spawn RPC.

## Stop, resume and usage limits

The crew own their stop. Esc in the chat interrupts the chat's own turn and
nothing else: the sub-agents and workflows the turn launched keep running on
their own controllers, and the interrupted turn's receipt says how many. To
stop one, open the Crew view (or the `/runs` board), select it and press `x`
twice within two seconds — the first press names the crewmate the second
press stops. The stop reaches every kind of row the same way: a dispatched
sub-agent's controller aborts and its running tool ends with it, a named
crewmate's loop ends, a workflow run is killed. The receipt is the runner's
own word: applied once the row has left `running`, or refused with the
reason — an id the registry no longer holds, a row that had already settled,
a loop that did not end within the runner's settle budget — and a refusal is
painted under the rows.

Stop and resume work the same for every crewmate. A stopped crewmate keeps
its history: its row reads `stopped` with the reason and its transcript
stands on disk; `r` on its row continues it from where it was, the work
before the stop in its context, and the row may be pressed after it has left
the list. A message to a stopped or finished crewmate takes the same road:
SendMessage to its name resumes it from its transcript with the message as
its next turn, and the answer names the new row and how it had ended. Every
stop, resume and failure reaches the main agent as a notification of its own
kind, never silently, a stop or resume from the crew view included. The main
agent's own door is the TaskStop tool, which takes a task id, a named
crewmate's agent id (the id its spawn receipt gave) or its bare name, or a
launch name.

A crewmate that hits a usage limit pauses instead of being marked failed: its
row reads paused with the reset time the provider stated, and it starts again
by itself at that time, or as soon as the operator logs in on another
account — with the same model.

A workflow that ends with agent failures says so in the first line of its
notification: the count, then the first failing agent and its cause — an
error's words, a refusal's stop reason — and its run record carries the
same failure lines beside the per-agent rows.

## Live communication

SendMessage carries every message between agents, as it always has: a plain
message, a question and its answer, a shutdown request, a plan approval, the
dispatch, escalate, progress and control envelopes, a handoff — addressed by
name, by id, to `*` for everyone or to `main` for the lead, delivered at the
receiver's next tool boundary or turn end (a receiver between turns starts a
turn). Underneath, the crew's messages, its tasks, its file claims and who is
busy are read and written live through the LiveComms tool: a read returns
the state as it stands at that moment, and a write is visible to the next
read by any agent in the crew — a crewmate in the session, a daemon seat, the
lead — with no restart. The coordination tools every session carries
(`mcp__mercury__brief`, `mcp__mercury__coord_say` and the lease verbs) read
and write the same live state.

Every message rides LiveComms: one file per crew,
`<config home>/crew/livecomms/<crew>.json`, holding the crew's messages (each
addressed by name), its tasks and who is busy. There is no file per member.
Every row is validated on read and unknown fields are tolerated, so a build of
another vintage reads the same file.

## File claims

A file claim marks a file as one crewmate's, visible live to every crewmate
and the lead. Crewmates keep off each other's files with the lease verbs
every session carries: `mcp__mercury__lease_claim`,
`mcp__mercury__lease_release`, `mcp__mercury__lease_list` and
`mcp__mercury__lease_take`. The list a lease verb takes is called `paths` on
every one of them: repo-relative file paths, and for a crew claim a path may
be a glob, a pattern ending in `/**` that covers a folder and everything
beneath it. A claim or a release sent with the older word `globs` is read as
the same list, and a claim sent with neither is refused with words that name
both. A crew claim renews the caller's lease and replaces its set; claiming
an empty set releases it. `lease_take` and a `lease_release` with a list act
on exact project files; a `lease_release` with no list drops the caller's
crew claim. A second crewmate that tries to edit a claimed file is stopped
before the write and told which crewmate holds it; a lease denial is
coordination, not an error. A release by the holder, or the holder's end,
frees the file.

## Roles

Crewmate roles resolve through one resolver, whichever way the crewmate
launches. A role is an agent definition — built-in, custom, or from an
extension — the same registry the in-session subagent tool loads, so a given
role is the same agent no matter how it was launched. `/agents` opens the
Agent Studio for building and tuning those definitions.

The living-crew directory (`/crew`) is the canonical agent-identity registry:
it binds agent principals, seat, roster and crew forms, provider identities,
and external adapter seats into stable crew agent ids with role links.
Identity derives from the founding binding, so a rename, reconnect, or
restart never mints a duplicate.

## Boards

`/crew` opens the crew board on `/runs` (`/tasks` still opens the same board)
— the crewmates, their phases and handoffs. `/crewmates` is the Crew view:
the session's sub-agents live, and the named crewmates' chats; each sub-agent
row carries the count of notices delivered to it that no turn of its own has
read yet ([SESSIONS.md](SESSIONS.md), "A notice an agent has not read"). A
command a sub-agent runs in the background is a shell task of the session
like any other: it has its row on the `/runs` board while it runs, the
session's waiting line counts it, and when it finishes the notice goes to the
agent that launched it, read at that agent's next turn. A sub-agent with
nothing to do until then waits with the Sleep tool, which every sub-agent's
roster carries, in a foreground and a background run alike: the wait names a
ceiling (at most an hour, the same as the session's own) and ends the moment
the shells that sub-agent launched settle, so the notice is read at that
boundary and never after a full timer. `/crew` shows the directory with
presence and external seat attach/detach. `/sessions` manages this project's
sessions, including crewmate chats.

## Older transcripts

A transcript written by an earlier build still displays: its crewmate rows,
its brief rows, its mailbox rows and its old row kinds render as they did, and
the saved settings of an earlier build still read.

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
