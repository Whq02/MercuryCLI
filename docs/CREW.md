# The crew

Every Mercury session has a crew from the moment it starts: the crewmates
(sub-agents) it delegates to through the Agent tool. There is no create step
and no delete step — the crew is born with the session and its crewmates are
tracked live, not through files that must be set up first. Boards show them
all; a message to a crewmate reaches it by its id or its name.

## The crew view

`/crewmates` opens the Crew view: the focused session's crewmates live —
name, model, status, tokens, elapsed — one row each. There is no separate
members dialog and no per-crewmate permission switch — crewmates follow the
session's permission mode. `↵` opens a crewmate's row in its own view, `m`
makes a crewmate's chat the main one, `c` clears a settled row. Esc or a
click on the chat outside the Crew view closes it; from an opened row, either
returns to the list first. The same rule closes the `/runs` board. Closing a
view never stops its work.

## The two spawn switches

Every session carries two switches, Crewmates and Workflows, set in the boot
menu's Agents section for the sessions born after the choice and sticky for
each session. With crewmates off, the Agent tool is absent from that
session's roster — the model never sees it — and every road that would spawn
one from inside the session (the tool, a skill that forks, a workflow's agent
hooks, the fleet tools) answers one receipt:
"crewmates are off for this session — /subagents on, or the boot menu's
Agents section". Workflows off does the same for the Workflow tool and the
workflow launch roads; the run board stays readable. The concourse itself
keeps launching sessions — the switches are per focused session.

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
roster. Plain `/subagents` reads both switches with their sources; the health
check's "Crewmates & workflows" row does the same.

## Starting a crewmate

A crewmate starts through the Agent tool, with a name or without one. A named
crewmate takes further instructions through SendMessage addressed to its
name, after its first turn and after it has finished; an unnamed one works
its prompt once and returns its report, and is reached afterwards by the id
its launch receipt names. The model is the one the launch names, or the
configured crewmate default from `/config`; no crewmate's model is chosen for
it or changed in a resume. When an Agent call names the parent's own model
family, its crewmate keeps the parent's exact model. Engine models still pass
their provider's dispatch checks. A different family keeps that family's
preferred model; an exact model id keeps its explicit choice.

An Agent call may name the directory its crewmate works in with `cwd`: an
absolute directory that exists. Starting outside the session's starting
folder asks for ordinary permission: yes launches the crewmate there, no
leaves it unlaunched. Sovereign mode does not ask. The crewmate's shell,
file tools and environment section start there, and that directory is its
own single starting folder. A missing directory is
refused before anything is launched. With `isolation: "worktree"` the
temporary worktree is cut from that directory's repository at the commit that
directory's checkout is on — the branch the lead works in, never a remote's
copy of it, with nothing fetched — or, with `worktree_at`, frozen at the named
commit; and the crewmate runs in the worktree. Several crewmates launched
together each get their own worktree, cut one after another. A crewmate's
worktree carries links to its parent
checkout's `node_modules` and to each `vendor/<pack>` the checkout ignores,
hidden from git through the clone's exclude file, so the crewmate builds and
runs the checks there without an install. A crewmate continued by a later
message wakes in the directory it was launched in: the launch records the
directory beside the transcript and the continuation reads it back; a
recorded directory that no longer exists puts the continuation in the
session's own directory, and the message's receipt says so, naming the
directory that is gone. The same note accompanies an automatic resume and
queued guidance, and the continued crewmate receives it in its own prompt.

Nothing is deleted automatically. A crewmate's worktree and folder stay where
they are after it ends, and the session gets a reminder naming each leftover
worktree by its path; what to remove is the operator's decision.

## Stop, resume and usage limits

The crew own their stop. Esc in the chat interrupts the chat's own turn and
nothing else: the crewmates and workflows the turn launched keep running on
their own controllers, and the interrupted turn's receipt says how many. To
stop one, open the Crew view (or the `/runs` board), select it and press `x`
twice within two seconds — the first press names the crewmate the second
press stops. The stop reaches every kind of row the same way: a crewmate's
controller aborts and its running tool ends with it, a workflow run is
killed. The receipt is the runner's own word: applied once the row has left
`running`, or refused with the reason — an id the registry no longer holds, a
row that had already settled, a loop that did not end within the runner's
settle budget — and a refusal is painted under the rows. `p` parks every
agent and the chat at its next safe point (a stream or a tool in flight
finishes first) and resumes them.

Stop and resume work the same for every crewmate. A stopped crewmate keeps
its history: its row reads `stopped` with the reason and its transcript
stands on disk; `r` on its row continues it from where it was, the work
before the stop in its context, and the row may be pressed after it has left
the list. A message to a stopped or finished crewmate takes the same road:
SendMessage to its name or its id resumes it from its transcript with the
message as its next turn, and the answer names the new row and how it had
ended. Every stop, resume and failure reaches the main agent as a
notification of its own kind, never silently, a stop or resume from the crew
view included. The main agent's own door is the TaskStop tool, which takes a
task id, a crewmate's agent id (the id its launch receipt gave) or a launch
name.

A crewmate whose turn ends on a provider's refusal of an image it was sent
carries on once on its own: the image goes to it as `[image]` with a line
saying so, and a second refusal ends the turn as it would have. A crewmate
that hits a usage limit pauses instead of being marked failed: its row reads paused with the
reset time the provider stated, and it starts again by itself at that time,
or as soon as the operator logs in on another account — with the same model.

A workflow that ends with agent failures says so in the first line of its
notification: the count, then the first failing agent and its cause — an
error's words, a refusal's stop reason — and its run record carries the
same failure lines beside the per-agent rows.

## Messages

SendMessage carries a plain message to a crewmate of this session by the id
its launch receipt names or by the name its launch gave it, and from a
background crewmate to `main`, the agent that launched it. A running
receiver reads it at its next tool boundary, else at the end of its turn; a
receiver between turns starts a turn for it; a receiver that has finished is
resumed from its transcript with the message as its next turn. A name two
launches carried reaches the newest.

## File leases

The in-process `mercury` MCP server every session carries holds exact
project file leases: `mcp__mercury__lease_take` takes the named
repo-relative paths for the calling session and agent, `mcp__mercury__lease_release`
releases the named paths or every lease the caller holds, and
`mcp__mercury__lease_list` lists the leases with their holders. A path another
live holder has taken is named and refused; a holder's end frees its leases.
The Godot engine's file operations respect the leases; elsewhere a lease is
the crew's own coordination, read before an edit. The same server serves
`render_tui`, the TUI capture.

## Roles

Two agents are built in. `mercury-crew` is the default for delegated work of
every kind — research, multi-step changes, running and checking commands,
carrying a brief such as a design, a review or a verification to its end —
with the session's full tool set. `mercury-scout` is the read-only
reconnaissance agent: it locates files, searches code and answers
how-does-this-work questions with paths, line numbers and excerpts. It
carries only the tools that read — its shell runs read-only commands, and a
call that would write or change state is refused — so it cannot write.
Everything else is your own: an
agent definition file adds a kind of agent with its own prompt, tools and
model, and `/agents` opens the Agent Studio for building and tuning those
definitions. The Agent tool's roster and `mercury roster` list the two
built-ins first, then your own agents.

A crewmate's kind is an agent definition — built-in, custom, or from an
extension — resolved by the Agent tool's `subagent_type`, so a given kind is
the same agent however it was launched. A saved crewmate record whose type
Mercury does not know resumes as `mercury-crew`.

Three briefs ride as skills and launch options rather than as agent kinds:
`/verify` hands the session's work to the `verifier` skill, which red-teams it
in a crewmate of its own and ends with a `VERDICT: PASS`, `FAIL` or `PARTIAL`
line; an Agent launch with `isolation: "worktree"`, `worktree_at` and
`review_receipt` is a review of a committed change on a frozen worktree whose
one permitted write is the receipt's `## Review` section, ending with
`REVIEW: CLEAN` or `REVIEW: FINDINGS <count>`; and the `mercury-docs` skill
answers how to use Mercury from the documentation that ships with the
install, with `https://mercury-cli.ai/llms.txt` as its map.

The living-crew directory (`/crew`) is the canonical agent-identity registry:
it binds agent principals, seat and crew forms, provider identities, and
external adapter seats into stable crew agent ids with role links. Identity
derives from the founding binding, so a rename, reconnect, or restart never
mints a duplicate.

## Boards

`/runs` opens the work board (`/tasks` opens the same board), including
workflow runs and background shells. `/crewmates` is the Crew view: the
session's crewmates live; each crewmate row carries the count of notices
delivered to it that no turn of its own has read yet ([SESSIONS.md](SESSIONS.md),
"A notice an agent has not read"). A command a crewmate runs in the
background is a shell task of the session like any other: it has its row on
the `/runs` board while it runs, the session's waiting line counts it, and
when it finishes the notice goes to the agent that launched it, read at that
agent's next turn. A crewmate with nothing to do until then waits with the
Sleep tool, which every crewmate's roster carries, in a foreground and a
background run alike: the wait names a ceiling (at most an hour, the same as
the session's own) and ends the moment the shells that crewmate launched
settle, so the notice is read at that boundary and never after a full timer.
`/crew` shows the directory with presence and external seat attach/detach.
`/sessions` manages this project's sessions.

## Saved conversations

A saved conversation reopens with its recorded crewmate rows and work. An
unknown stored agent type resumes as `mercury-crew`; the two built-in types
and your custom definitions are the choices for a fresh launch.

## The concourse

The Session Concourse — the board of the project you are in (its running
sessions and its parked chats), the hop into a row, the live tiles, NEEDS
YOU, the strip that walks only the screens that exist, and
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
