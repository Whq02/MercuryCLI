# The crew

Every Mercury session can delegate work to crewmates through the `Crewmate`
tool, tracked live in `/crewmates` and `/runs` and reachable by id or name.

## The crew view

`/crewmates` opens the Crew view: the focused session's crewmates live,
name, model, status, tokens, elapsed, one row each. Crewmates follow the
session's permission mode. `↵` opens a crewmate's row in its own view, `m`
makes a crewmate's chat the main one, `c` clears a settled row, `r` resumes
a stopped row, `x` twice stops a running row, and `p` parks or resumes the
crew at the next safe point. While the list is open, the mouse wheel and
`PageUp`/`PageDown` scroll the crewmates list while the chat behind it stays
still; a click selects a row, and a second click on the selected row or a
double click opens it as `↵` does. Esc or a
click on the chat outside the Crew view closes it; from an opened row, either
returns to the list first. The same rule closes the `/runs` board. Closing a
view never stops its work.

## The two spawn switches

Every session carries two switches, Crewmates and Workflows, set in the boot
menu's Agents section for the sessions started after the choice and sticky for
each session. With crewmates off, the Crewmate tool is absent from that
session's roster and every road that would spawn
one from inside the session (the tool, a skill that forks, a workflow's agent
hooks, the fleet tools) answers one receipt:
"crewmates are off for this session · /crewmates on, or the boot menu's
Agents section". Workflows off does the same for the Workflow tool and the
workflow launch roads; the run board stays readable. The concourse itself
keeps launching sessions; the switches are per focused session.

Inside a session, `/crewmates on|off` and `/workflows on|off` print their
two-line receipt in the chat at once (or the boot
menu opened there flips the switch) at the session's next turn boundary: the tool
leaves or rejoins the roster, a receipt says so, reasoning restarts on the
next turn, and a spawn already running finishes. Flipped while no turn runs,
the switch moves at once. Flipped while a turn runs, the receipt says the
switch applies when this turn ends, and the session's runner moves it at that
turn's end, before any line waiting for the next turn, so the next turn's
launches already read it; the session's record follows the runner's own word
that the switch moved, never a clock. A line sent after the flip, while the
same turn still runs, waits for the turn's end too and runs with the switched
roster. `/crewmates` alone opens the crew view and `/workflows` alone the board; the health
check's "Crewmates & workflows" row reads both switches with their sources.

Beside the two switches sits one global setting, "Crewmates while
backgrounded", off by default: the same row in the boot menu's Agents section
and in `/config`, one switch wherever it is flipped. It decides whether a
session you have left in the background may launch crewmates and workflows
when its brief says so. Off, a backgrounded session works single-handed and
waits for your visit or the one workflows-allowed grant, and its launch
refusal names this row as the third road. On, it launches as a focused session
does, under its own Crewmates and Workflows switches, which still rule first,
and its own permission mode, and a session started while the setting is on
carries the Crewmate and Workflow tools from its first request. The
workflows-allowed grant is untouched. [SESSIONS.md](SESSIONS.md) has the
focus law the setting sits beside.

## Starting a crewmate

A crewmate starts through the Crewmate tool, with a name or without one. A named
crewmate takes more work through ResumeCrewmate addressed to its name, running
or finished, and notes through SendMessage while it runs; an unnamed one works
its prompt once and returns its report, and is reached afterwards by the id
its launch receipt names. The model is the one the launch names, or the
configured crewmate default from `/config`; no crewmate's model is chosen for
it. A resume keeps the crewmate's recorded model and effort unless the
`ResumeCrewmate` call names `model` or `effort` for a finished crewmate. When a
Crewmate call names the parent's own model family, its crewmate keeps the
parent's exact model. A different family keeps
that family's preferred model; an exact model id keeps its explicit choice.
The launch receipt names the crewmate's engine and model on every provider,
the Anthropic route included.

The model that launches a crewmate reads what you can see: the page
`mercury://models` lists the providers the operator is signed into and the
models each reaches, read live (reporting the same selectable model count as
`/model` and `/logins` alongside any unavailable rows and their reasons), and
`mercury://models/known` lists the models this build knows from its pin
tables, marked as known instead of live. A family word (`grok`, `glm`,
`kimi`, `deepseek`, `muse`, `mistral`) runs that family's newest live row;
when the provider is signed in but its model list cannot be read, the word
runs the family's pinned default (xAI: Grok 4.7) and the launch receipt says
so. An exact id of a signed-in family runs when the live list names it, or,
when the list cannot be read, when this build knows it; when an id is on
neither page, the agent may use `WebSearch` on the provider's published models
page (listed in `mercury://models`) to inform its question and then
ask the operator for the model id with `AskUserQuestion` (web text never
launches a model). Only a
provider with no sign-in refuses a launch outright, naming `/logins`; no
launch ever moves to another provider on its own.

A Crewmate call may name the directory its crewmate works in with `cwd`: an
absolute directory that exists. Starting outside the session's starting
folder asks for ordinary permission: yes launches the crewmate there, no
leaves it unlaunched. Sovereign mode does not ask. The crewmate's shell,
file tools and environment section start there, and that directory is its
own single starting folder. A missing directory is
refused before anything is launched. With `isolation: "worktree"` the
temporary worktree is cut from that directory's repository at the commit that
directory's checkout is on (the branch the lead works in, never a remote's
copy of it, with nothing fetched) or, with `worktree_at`, frozen at the named
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
worktree by its path; what to remove is your decision.

## Stop, resume and usage limits

When a crewmate finishes, its completion notice row in the chat carries the
timestamp when the crewmate finished (`completedAt`) as its row clock. If the
notice is delivered to the parent turn a minute or more after completion, the
row appends `· delivered HH:MM:SS` as a second clock; deliveries within a
minute show the finish clock alone.

The crew own their stop. Esc in the chat interrupts the chat's own turn and
nothing else: the crewmates and workflows the turn launched keep running on
their own controllers, and the interrupted turn's receipt says how many. To
stop one, open the Crew view (or the `/runs` board), select it and press `x`
twice within two seconds (the first press names the crewmate the second
press stops). The stop reaches every kind of row the same way: a crewmate's
controller aborts and its running tool ends with it, a workflow run is
killed. The receipt is the runner's own word: applied once the row has left
`running`, or refused with the reason (an id the registry no longer holds, a
row that had already settled, or a loop that did not end within the runner's
settle budget), and a refusal is painted under the rows. `p` parks every
crewmate and the chat at its next safe point (a stream or a tool in flight
finishes first) and resumes them.

Stop and resume work the same for every crewmate. A stopped crewmate keeps
its history: its row reads `stopped` with the reason and its transcript
stands on disk; `r` on its row continues it from where it was, the work
before the stop in its context, and the row may be pressed after it has left
the list. ResumeCrewmate to a stopped or finished crewmate takes the same road:
addressed by its name or id, it resumes from its transcript with the message
as its next turn, and the answer names the new row and how it had ended. Every stop, resume and failure reaches the main agent as a
notification of its own kind, never silently, a stop or resume from the crew
view included. The main agent's own door is the TaskStop tool, which takes a
task id, a crewmate's agent id (the id its launch receipt gave) or a launch
name.

A crewmate whose turn ends on a provider's refusal of an image it was sent
carries on once on its own: the image goes to it as `[image]` with a line
saying so, and a second refusal ends the turn as it would have. A crewmate
that hits a usage limit pauses instead of being marked failed: its row reads paused with the
reset time the provider stated, and it starts again by itself at that time,
or as soon as you log in on another account, with the same model.

A workflow that ends with crewmate failures says so in the first line of its
notification: the count, then the first failing crewmate and its cause (an
error's words or a refusal's stop reason), and its run record carries the
same failure lines beside the per-crewmate rows.

## Messages

SendMessage carries a plain note to a running crewmate by the id its launch
receipt names or by the name its launch gave it, and from a background
crewmate to `main`, the agent that launched it. A running receiver reads it
at its next tool boundary, else at the end of its turn; the main agent
between turns starts a turn for it. SendMessage never starts a finished
crewmate: its refusal names ResumeCrewmate with the same `to` and `message`.

ResumeCrewmate gives a crewmate more work by the same id or name. A completed,
failed or stopped crewmate resumes from its transcript in the background;
a running one receives the message without starting a second run. A crewmate
settles as completed only when its turn ends with an empty message queue, so
a message queued while it worked starts its next turn in the same seat before
the completion notice reaches the main agent. When a stopped crewmate is
resumed, consecutive user records are merged on the Anthropic wire while
resume text stays separate from tool results. A crewmate launched with an output
schema keeps its StructuredOutput tool on the resumed turn. A name two
launches carried reaches the newest.

## Live crew board

Swarm is on for new sessions when `swarm.enabled` in your user `settings.json` (the Swarm row in `/config`) is on; the master defaults to on, and `false` turns it off. `/swarm off` turns it off for this session's future launches while existing board crewmates keep their board; `/swarm on` turns it back on. `/swarm status` shows the switch. Resumed sessions keep their choice. Headless and SDK sessions follow the same default.

Swarm is a high-cost option: sharing board messages costs context, and the Swarm row in `/config` turns it off. The context allowances and the post length have no cap unless you set one in `/config`; two loop guards stay on (four posts a minute, 120 posts per agent in a wave); a cap guards against a fault, and the lead can lift it with `/swarm uncap`.

A crewmate launched or resumed with swarm on is told, in its system prompt, its name, its team, the seats already on the board, and when to post and read; the lead's brief adds the task's own habits. SendMessage and ResumeCrewmate from the lead, and SendMessage back to `main`, stay direct, whole and uncharged whether swarm is on or off. The board keeps only the first 400 characters plus `… (sent directly)` for the timeline. That mirror is not delivered to the model or charged by a board read.

With the board on, `/swarm` opens **Crew chat** in the Workbench. It combines board posts and crew traffic in one live timeline, with each author's name, time, team and kind. Mirrored messages carry a `traffic` tag. Replies sit under their ask. A message wraps to three lines in the timeline; the thread holds the whole text. `↑↓` moves, `↵` opens a thread, `←→` selects General or a team, and `esc` closes. The view is read-only, with no composer, and is absent when the board is off.

With swarm on, board messages show in the chat. Each message has its time and author; each crewmate has its own colour, the same in the Workbench. Messages wait for the lead's current block to finish. At the end of its turn, they move into an expandable count. Messages received while the lead is idle stay visible.

The channel is on by default, with nothing shown until the crew is active. `/swarm on` also shows the wave's launch line. `/swarmchat` alone turns it off for this session; typed again, it turns it back on. Choose `/swarmchat all`, `/swarmchat team <name>` or `/swarmchat main` to select new messages; `main` shows posts addressed directly to the lead. The Workbench keeps the full board.

CrewBoard posts questions, answers, blockers and results. A result or blocker may include `about` with a description, path or URL; it needs neither a task id nor an evidence reference. `@seat`, `@team` and `@all` in the text or the optional `to` list address enrolled members. Unknown mentions are returned in the receipt without refusing the post. An @mention delivers the full text, `about` and thread at the recipient's next boundary; an ask or blocker addressed to the lead with `@main` or `@all`, and a result, answer or correction addressed to `@main` by name, wake an idle lead, batching waiting posts into one turn.

The lead can give a Crewmate launch a `team` label or assign one later with CrewBoard's `swarm_team` operation (`seat` and `team`), and name a team's captain with `captain: true` on the launch or with `swarm_captain` (`team` and `seat`). Replies in a thread a seat started arrive whole at that seat's next boundary. Posts reach their author's team by default. A seat may subscribe to another team with a CrewBoard read using `team` and `watch: true`; task and file relevance also select delivery. Teams are labels for delivery and channels. There are no private messages: everyone can read every post. A read without a team selects the general timeline.

The lead names a captain for a team of five or more crewmates. A smaller team has one when you ask, or when a crewmate asks and the lead agrees. Captains gather their team's work and report it to the lead.

`/general <text>` posts to every crewmate. `/team <name> <text>` posts to that team's captain, or all its members when it has none. `/whisper <name> <text>` posts to one crewmate. Names complete as you type. Your posts carry your own label and colour and reach the lead too. Every board post remains readable by the crew. Ordinary prompts go only to the lead.

Crewmates can park with a declared wait for another crewmate's post, a file or subject, a message kind, or their team's traffic. A matching message or a post addressed to them can resume their conversation. Broadcasts do not resume parked crewmates. The status shows what each waiting crewmate needs. If its worktree is unavailable, it stays parked and the lead receives the path.

A read without `since` continues from the seat's cursor, starting at its enrollment. Whole events already handed to its model, through a read or a boundary message, are skipped without another charge. The receipt counts those seen events and names the re-read road: `since: 0` or `since: <seq>` deliberately reads them again and is charged. Truncated events stay unread and can return whole on the next read. Reads pack oldest-first; `limitTokens` requests a smaller page. A tiny page still returns the id envelope at its actual cost. Board context is charged conservatively in UTF-8 bytes.

Only live seats count against the wave. Relevance-selected delivery degrades to an index or waits first; mentions, thread replies and requested reads are refused only when the recipient's own allowance is spent. Each seat and allowance can raise one notice to the lead's next boundary. `/swarm uncap` lifts context and post-length allowances for the live wave, `/swarm cap` restores them, and `/swarm status` shows the override. Post-rate, post-count and discussion guards stay on.

The **Swarm limits** group in `/config` sets these user-only `settings.json` values. Values outside their ranges are clamped and named in settings validation. Each wave keeps the limits its board opened with, including after reopening; changes apply to new waves. A nonzero wave allowance is never below the seat allowance. Zero removes the chosen context or post-length cap.

| Key | What it sets |
| --- | --- |
| `swarm.seatAllowance` | Requested board-context tokens per seat: no cap by default (0); 1,000–5,000,000 caps it. |
| `swarm.waveAllowance` | Live-wave board context before unsolicited delivery degrades: no cap by default (0); from the seat allowance to 20,000,000 caps it. |
| `swarm.postChars` | Characters per post: no cap by default (0); 400–20,000 caps it. Direct messages to and from the lead are exempt. |
| `swarm.postsPerMinute` | Posts per minute per seat: 4 by default; 1–30. The burst is twice this rate. |
| `swarm.postsPerSeat` | Posts per seat per wave: 120 by default; 10–1,000. |

A `correction` names an earlier event id in `corrects` and appends the replacement words beside the original in its thread. The earlier post stays readable and links to its correction. Corrections and answers to your own posts do not consume the two question-and-answer rounds allowed per thread.

## File leases

The in-process `mercury` MCP server every session carries holds exact
project file leases: `mcp__mercury__lease_take` takes the named
repo-relative paths for the calling session and agent, `mcp__mercury__lease_release`
releases the named paths or every lease the caller holds when paths are omitted
or `null`, and `mcp__mercury__lease_list` lists the leases with their session and
agent holders. The session director can pass `agentId` to release that agent's
leases, or `all: true` for every holder in its own session, never another
session's. A path another live holder has taken is named and refused. A
crewmate's leases are freed when it finishes, fails or is stopped; a resumed
crewmate can take them again.
The Godot engine's file operations respect the leases; elsewhere a lease is
the crew's own coordination, read before an edit. The same server serves
`render_tui`, the TUI capture.

## Roles

Two agents are built in. `mercury-crew` is the default for delegated work of
every kind (research, multi-step changes, running and checking commands, and
carrying a brief such as a design, a review or a verification to its end)
with the session's full tool set: every tool the main chat has, in the
foreground and in the background alike, except the few that need you present
(AskUserQuestion, ApolloReview, AskAdvisor) or reach past the crewmate's own
work (Computer, Journal, Workflow, CronCreate, CronDelete,
ScheduleWakeup, RecordConvention, and the Crewmate tool itself).
TaskStop lets a crewmate stop only its own background command. The
processes a crewmate starts (background shells, Eval kernels, the services
it starts for the session, debug sessions, its browser) end when it ends; a
service it starts with the `project` lifecycle outlives it, as that lifecycle
says. `mercury-scout` is the read-only
reconnaissance agent: it locates files, searches code and answers
how-does-this-work questions with paths, line numbers and excerpts. It
carries only the tools that read (its shell runs read-only commands, and a
call that would write or change state is refused), so it cannot write.
Everything else is your own: an
agent definition file adds a kind of agent with its own prompt, tools and
model, and `/agents` opens the Agent Studio for building and tuning those
definitions. The Crewmate tool's roster and `mercury roster` list the two
built-ins first, then your own agents.

A crewmate's kind is an agent definition (built-in, custom, or from an
extension) resolved by the Crewmate tool's `crewmate_type`, so a given kind is
the same crewmate however it was launched. A saved crewmate record whose type
Mercury does not know resumes as `mercury-crew`.

Three briefs run as commands, skills and launch options instead of separate agent kinds:
`/verify` hands the session's work and an adversarial brief directly to a
crewmate through the Crewmate tool, ending with a `VERDICT: PASS`, `FAIL` or `PARTIAL`
line; a Crewmate launch with `isolation: "worktree"`, `worktree_at` and
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
unknown stored crewmate type resumes as `mercury-crew`; the two built-in types
and your custom definitions are the choices for a fresh launch.

## The concourse

The Session Concourse (the board of the project you are in with its running
sessions and its parked chats, switching into a row, the live tiles, NEEDS
YOU, the navigation strip that walks only the screens that exist, and
how chats are started, focused, closed and resumed) is covered in
[SESSIONS.md](SESSIONS.md). This section describes the coordinator behind
the board.

Behind the board sits the switchboard coordinator: one terminal, you,
and your Mercury sessions running beside each other. The
coordinator launches, watches, messages, pauses, resumes, queues and
reconciles sessions and answers questions from the repository it sits on; it
never does a session's work or reaches inside one, and every verb settles as
a receipt row you see. The coordinator surface is experimental and
says so itself on the board: trust receipts, never assumed success.
