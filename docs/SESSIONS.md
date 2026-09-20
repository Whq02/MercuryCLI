# Sessions

The session is the unit; every screen is a view. A session owns its
conversation, model, posture, workspace and running work, and it survives
whatever screen is looking at it — the chat, the Session Concourse board, a
live tile and the Boot face render sessions and never store their truth.
This page is how sessions are born, focused, closed and brought back, how
the folder you start in becomes a project, and the two boot switches that
shape the journey. Every session is hosted by the background daemon.
On Windows, each frame reads the window size from the console so the cockpit follows it even when no resize event arrives.

## A fresh boot has no chat

A bare interactive `mercury` lands on the Boot face — the card of New
Session · Continue Last Session · Boot Menu · MCPs & Skills · Agents ·
Doctor / Health Check · Saturn Scheduler · Logins · Session Concourse, and
the merged Sessions · Projects door — and there is no chat behind it. The
boot menu, the kit menu ([KIT.md](KIT.md)), the agent studio, the health
certificate, the scheduler board ([SATURN.md](SATURN.md)), the sign-in
catalogue and the session-and-repository picker open in place, as layers of
the face itself —
esc lands back on the row, the face never flashing chat chrome around a
dialog — while the Session
Concourse row is the board itself, one screen to the right. A chat exists
only once you enter
one: New Session, Continue, a pick on the Sessions · Projects screen, or a
row on the concourse board. Until
then the screen's chrome (the model chip, the mode readout, the folder row)
reads the screen's own facts, and a screen left
with no chat returns to the Boot face on its own.

Where a boot lands is the Boot face unless something outranks it: an
explicit journey (`--continue`, `--resume`, a prompt argument), or the
`MERCURY_CONCOURSE` policy — `always` makes the board the boot home, `auto`
lands the board when more than one session is live or one is waiting on you.

## The strip walks only the screens that exist

shift+← and shift+→ move between the screens that are there, and nothing
else. A fresh boot has two: the Boot face and the Session Concourse —
shift+→ from the face is the board, and shift+→ from the board moves
nothing, because there is no chat to go to; nothing bounces and nothing
flashes. The chat joins the strip the moment a session is focused — ↵ on
New Session, ↵ on a board row, a resume — and leaves it when the last chat
closes. Every move lands on the nearest screen that exists in that
direction, and the dim key-map row on the Boot face and on the board names
only the moves that exist: "⇧→ concourse" on a fresh boot, "⇧→ chat" once a
session is focused, "⇧→ no chat open" when nothing lies to the right,
repainted the instant a screen appears or vanishes. On the board, esc returns
to the focused chat while one exists — and to the boot menu when none does,
exactly as its legend reads — and the FOCUSED CHAT crumb is a door only
while a chat exists.

## New Session is born on Enter

↵ on New Session creates a real session for the current folder on the model
the chip shows, and enters it. The session, the chat and its board row come
into being together — the record is on the board before the chat paints —
and no words are sent: the session is blank and ready, exactly like a row
entered from the board. A `/mission` typed in the moment before the seat
lands still belongs to the chat you opened: it moves to the session at
admission, its card and its Stop hook with it, and the rail shows it once
the seat is in. Enter stays instant because a warm runner already
stands behind the menu; the birth claims it instead of paying a spawn. The session is born wearing the
repository's MCPs & Skills record — or the preset armed on the face — and
the launch receipt names which ([KIT.md](KIT.md)). The board's own `+ new session · n`
tab, at the right end of its SESSIONS title, is the same birth from the
board: a blank session in the project the board shows, focused at once.
The chat paints while the birth lands, and its first frame already names
the model, the effort and the permission mode the birth resolved; once the
session's own record and facts are read they take over, the same words
standing. A word the birth did not resolve stays unpainted until the
session's record names it.

The boot's own options ride into the sessions it opens: `-n <name>` titles
the first session you open (one-shot; later ones name themselves — below),
and `--effort`, the permission mode and the runner-side options apply to
every session this screen births.

The model and the effort a session runs follow one law. An explicit
`--model` or `--effort` on the command line wins, for a new session and for
a resumed one alike. Without the flag, a new session starts on your saved
choice — `/model` and `/effort` both save the pick as your default, and say
so — and, with nothing saved, on the family default. The board's New
Session strip births on the same saved choice; its own effort pick, when
you make one, holds for that one birth. A resumed session
keeps the model and effort it ran on unless the command line says
otherwise: `--continue --model <id> --effort <level>` brings the session
back on the launch's model and effort, its record is re-stamped, and the
resume card names which won when the launch's word and the session's saved
word differ. `/model default` clears the saved choice.
`/model` or `/effort` sent while a turn runs answers "applies when this turn
ends", and lands exactly there: at that turn's end, before any line waiting
for the next turn. A line sent after that pick, while the same turn still
runs, waits for the turn's end as well and runs as the next turn, on the
model and effort the pick named, so the order you gave is the order that
runs; its row keeps the plate `queued` until then. `/subagents` and
`/workflows` flipped while a turn runs hold a later line the same way: it
waits for the turn's end and runs with the switched roster. A line sent
before the pick keeps its place: it may still join the running turn at a
tool boundary, and a line that joined the running turn is that turn's own
and runs on its model. Sent while the session only waits on its background
work, or holds a finished task's notice, the pick applies at once.
Every ↵ on New Session opens another session; whatever the chat held keeps
running and shows on the board. If the daemon that hosts sessions is not up,
the row says so, and ↵ again starts it and retries.

One background daemon hosts every session on the machine, and it outlives
whichever window started it. Close that window and the daemon passes to
another that is still open, so the sessions your other windows hold keep
their runners and lose nothing; it shuts down only when the last window
closes, and parks every session on its way out so the next boot brings them
back. A window opened while that daemon is still on its way out waits the
beat it takes to leave, then starts its own; two daemons never share one
config home. A deploy that arrives while sessions are live waits for every one of
them — the ones open when it landed and any opened since — before it
restarts, and never cuts a live runner short.

A chat you just opened is never reaped before your first message. An empty
background session retires after `MERCURY_SESSION_IDLE_RETIRE_MINUTES`
(default 10; 0 disables; the row stays on the board as stopped — "retired —
empty and idle for 10m" — until you release it), but a session born through
New Session that has not received your first message is excluded from that
judgment: without limit by default, or for the
`MERCURY_SESSION_NEWBORN_GRACE_MINUTES` you set, and the first message ends
the grace either way (the `MERCURY_CONCOURSE_…` spellings of both knobs are
accepted aliases until 2026-12-01, read only while the `MERCURY_SESSION_…`
ones are unset). A session born this way, never messaged, that the daemon finds
dead at its next reconcile is released quietly rather than painted NEEDS YOU
— there is nothing to bring back.

## A session names itself

A session's name is the best it has, in three stages: at birth, the fact —
"new session · <project> · ready"; at your first message, the first line of
the prompt; and once its second reply lands, a short minted title — the
small model writes one, once per session ever, and only into an empty name,
so a title you typed is never overwritten and the mint never runs twice; a
mint that cannot run (offline, refused) leaves the words standing. A name
never regresses to a lesser stage. `/title <words>` names the focused
session yourself — a typed name outranks and outlives the mint — and a
bare `/title` asks the model again, an explicit spend; `r` on a board row
renames it there. The worker id is a fact of the detail column and never a
session's title, in any world.

## The focused chat

One chat is on screen at a time: the focused one. The daemon records which
session a terminal is looking at, and a hop moves that mark from the chat
you leave to the one you land on, so exactly one session per terminal is
focused at any moment.

Focus carries your seat. The focused chat launches workflows and agents on
your own authority, under its own permission mode. A background session
keeps working single-handed and waits — until you visit it, or until it
holds the workflows-allowed grant (asked of the coordinator, chosen as
keep-and-background on leave, or the manual-start option); a hop flips both
answers at once. `/tasks`,
`/workflows` and the board's work chip show the focused session's own work
and never another's. A shell's row on the board, or in the cockpit rail's RUNS
lane, opens its card: the whole command, the directory it runs in, the time it
has run, its exit code once it has ended, and the last lines of its output,
read from the output file the session's runner writes on this machine, under a
count of the lines shown against the lines it has written. On a short window
the command yields rows to the output, so at least one line of it always
shows.

A block of pasted text longer than a couple of lines becomes a
`[Pasted text #N +L lines]` chip in the composer, and its words reach the
model whole when the line is sent. The chip carries the hash of its bytes,
and the bytes are kept under the config home from the moment of the paste,
so the chip survives a crash of the session, a relaunch and a refused send;
a draft too large to keep whole keeps the chip and resolves its bytes from
that store at the send. A chip whose bytes are gone is refused by name at
the send, never sent bare, and the housekeeping sweep keeps every paste a
draft or the prompt history can still recall.

An image goes into the composer three ways: paste it from the clipboard
with ctrl+v on macOS and Linux, or alt+v on Windows (the terminal owns
ctrl+v there, and an image-only clipboard gives it nothing to paste); drag
an image file onto the terminal; or paste its path. Each attaches as an
`[Image #N]` chip, saved under its own name in the session's image store
for the session's life, and the composer says what was attached — its size,
and what it was shrunk to when the provider's limits asked for it. Copy an
image and come back to Mercury and it tells you the key. An image is never
refused for its size: it is shrunk to the provider's published limits
(`/health` names the image processor on this machine); the one refusal
left is an image whose smallest encoding still exceeds them, and its words
say which limit and what size. Each provider's rule is its own: the Claude
API caps an image at 10 MB of base64 and 8000 px a side, while the OpenAI
API caps a request at 512 MB and an image at 30,000 patches of 32 px, so a
GPT session shrinks a large image to that patch count and never to a byte
figure. Should a provider still refuse an attached file's image, that image
leaves every later request of the session, a resumed one included, on the
OpenAI route as on the Anthropic one.

The status row under the composer carries the project and the CREW's
clock — the sub-agents and workflow agents the session's runner hosts —
past tense, by kind: "agents thought for 28m", "workflow thought for 12m",
both when both stand (the larger first). The row wears no glyph, and the
session's name paints on the title row alone. The main agent is narrated
once, by the transcript's thinking row and the card under the critter, and
never repeated here; a session with no crew reads "ready" when idle and
paints no clock while its main agent works. That is what makes esc read
true: esc interrupts the main agent alone, so the card's glyph stops while
the row's clock keeps counting for the crew that runs on. The row's
warnings stay its own: a request wait names what the runner waits on and the budget that
fires ("waiting for the first byte from Opus 5 — within 2m"); a held turn
names what it waits on ("waiting on 1 workflow · 2 agents"); an interrupt
says the request is torn down. The row says the session may be stuck only
when the runner's stream has carried no event of any kind — the provider's
heartbeats included — for longer than its own watchdog's warning point:
never sooner than five minutes of silence, and never later than the
watchdog's own cut. On the routes whose keep-alives feed the watchdog the
budget is two minutes (four in patient mode), so the cut comes first and
the row never says it there; on the OpenAI route, whose budget is fifteen
minutes, the row names what it saw from seven and a half: "no stream events
for 8m — the session may be stuck (the watchdog aborts at 15m)". Every
wait, warning and reissue line spells a minute or more in minutes ("within
2m", "within 2m of dispatch") and anything shorter in seconds. A
running tool is never called stuck. The chat pane's title row reads
"SESSION" on the left and the session's name on the right — no clock: every
row of the chat carries its own timestamp, and a clock that ticks is a
repaint a second on an idle screen.

## The concourse shows the project you are in

`/concourse`, the Boot face's Session Concourse row, or shift+→ from the
Boot face opens the Session Concourse — the control plane for the project
you are in, and its resume screen. The board is that project's: its
sessions that are running, held for a seat, or finished and waiting for a
merge, and beneath them, PARKED, the project's chats with no runner. It is
never a pile of everything: pick another project — the rail's REPO picker,
or a Projects pick on the Boot face — and the board shows that project's
sessions instead, while every other project's sessions keep running. What
runs elsewhere stays one glance away: each other project with activity
paints one small door line under OTHER PROJECTS, between the live rows and
PARKED — "N running in foo", its finished and needs-you counts trailing,
"switch to see them" in its NOW cell — and ↵ on it switches the view
through the REPO picker's own path; at most three lines paint, and a "+N
more projects with activity" line opens the picker itself (also ⌃g). The
Boot face's Projects rows carry the same numbers — "foo (3 running)" —
through the same one running predicate. The chat you are in rides a project
switch rather than vanishing: the board always adds the one focused
session, wherever it lives, wearing ✦ "from <its project>" beside its
title — live among the live rows, or leading PARKED when no runner stands
behind it — and ↵ enters it as ever; focus a session of the current
project and the carried row hands back to its own board silently. Two things on the board
stay machine-wide on purpose: the rail's counts ("N live", the seats
fraction) count every running session on the machine, and the NEEDS YOU
rail lists every open question whichever project asked it — a question
from another project still shows, because a question nobody sees is worse,
and that row is a door: ↵ switches the view to its project and opens the
chat.

↵ on a live row is the hop — the chat shows that session whole, the same
cockpit with its own model, its own consent card and numbers — while every
other session's runner keeps working. The parked rows are the project's
chats with no runner that were touched within the last week, newest first,
at most ten, each wearing its name — the stored title when one stands, else
its first words — and carrying "parked · <age>" where a live row shows
motion. ↵ on a parked row brings it back in place: its transcript paints at
once, the daemon admits the same durable session behind the paint, it
becomes the focused chat, and shift+←/→ work from there as usual. The
board's close key is a chord, never a letter: ctrl+x pressed twice (the
first press shows the hint on the row, the second completes), and the
chord is a ladder of three rungs. On a live row it stops the session (the
row stays, wearing stopped and the next step); on a stopped row it
archives — the row parks; on a parked row a first chord says the next one
deletes, and that next chord (or a chord straight after the archive)
deletes the record — the transcript survives on disk, and the Boot face and
`/resume` still offer the chat. A chat that was never messaged has nothing
to park: on its stopped row the hint reads "ctrl+x again removes it (the chat
held no message)", its archive rung releases it with the receipt "removed from
the board — the chat held no message", the row leaves the board, and when it
was the only chat the strip is back to its two stops. A door row
(another project, the repo picker) has nothing to close. Everything else the project
holds — chats older than a week, past the ten, cleared from the board, or
never given words — is counted into one last line, "N older chats · ↵ to
browse": ↵ unfolds that very list in place on the board — this project's
older chats, newest first, each wearing its name and age — ↑↓ or a click
chooses inside it, ↵ on one brings it back through the same door a parked
row rides, esc (or moving off the line) folds it back to the line, and a
list longer than the window ends in honest arithmetic ("+N more — /resume
lists everything"); the board keeps the frame throughout, and the close
chord on that line clears nothing. The project's whole history
is also a command away: `/sessions` in the chat (project-scoped; `a` widens
it to every project's history), where a chat is brought back, or cleared,
one at a time. Nothing deletes a transcript — no row or key unlinks a
chat, and the retention sweep (`cleanupPeriodDays`, default 30
days) ages only recordings and tool results, never
a session transcript: a chat is yours until your own act removes it.

Every live row is a tile: the NOW cell streams what the session is doing
right now — the reply's last line, or the tool it is running — and `→`
opens a peek of the selected row in place. A session's end is a visible
state: a runner that crashed paints NEEDS YOU with its reason line, the row
outlives every reconcile, your own next act on the session clears the fact,
and only your release removes the row. ctrl+x ctrl+x stops the selected
session — the row stays, wearing stopped and the next step — the chord
again archives it, and a third chord deletes it; typing is never a control,
so a plain `x` lands in the composer like any other letter. The board's REPO picker
changes the folder new sessions launch in, the whole harness follows, and
the board follows with it — it renders the same list of projects the Boot
face's Projects rows do.
`/halt` is the screen's brake — it fires interrupt-first, acting while a
turn runs, and never rides into a session runner. Attention rides one bell: a session taps the
terminal bell once when it needs you or finishes a run, the status strip's ⚑
badge counts what needs you, and `/pings` quiets the tap for you — the rows
and the badge stay. A session that finishes a run while you are elsewhere
is not a question: its row wears its state glyph and word in amber until
you open the chat again, and a run you watched to its end in the chat
leaves no mark. A question from another project stays a door — ↵ switches
the view to its project and opens the chat; an untrusted folder is never
switched into silently — the chat still opens, and the note says where the
view stayed.

The coordinator that sits behind the board — launching, watching, messaging
and queueing sessions — is [TEAMS.md](TEAMS.md)'s.

## The folder is the project

Open a terminal in any folder and run `mercury`: that folder is the project,
by its name, from the first frame — the Boot face's card and its Dir chip
name it, and a folder that is itself a `.mercury` home is called by its
parent's name. Nothing is written into the
folder until a chat is actually born there: looking at the Boot face and
leaving keeps the folder byte-for-byte as it was. The first chat born in the
folder, whichever door births it, initializes the catalog: an empty
`.mercury/` directory in the folder, and a small project card in Mercury's
own home beside that folder's transcripts. From then on the folder is one of
your projects everywhere — the Boot face's Projects rows, the board's REPO
picker and the board's own scope all render the one list. The estate stays
yours: Mercury writes no ignore rules, never touches `.gitignore`, and never
deletes `.mercury/`. The project folder holds shared configuration — the
settings, the gates and wards, the Apollo specs, the agents, the saved
workflow scripts — the way a team commits its shared config; everything a
machine or a session writes for itself (run manifests, ledgers, evidence,
test-run records, audit chains, local memory, the doctor's certificate)
lives in the config home beside that folder's transcripts. A local store
found in the project folder from before is read once and migrated on its
first touch; the folder keeps its copy, and the doctor's Project estate row
names it with the one `git rm --cached` line that untracks it.

## Closing chats

Releasing the last row on the board closes the last chat: the slot rests on
no session, the chat stop leaves the strip, and the board keeps the frame —
back to the two screens, with nothing created in its place and nothing
bouncing to the menu.
`/clear` in a chat starts fresh: the focused session is parked — its slot
released, its row on the board reading "parked · <age>", ↵ there brings it
back, its transcript kept — and a fresh session opens in the same folder on
the same model, blank and on the board at birth; the cleared chat is never
lost. With no chat open there is nothing to clear, and a session mid-turn is
never dropped under you: the refusal names the one action that unblocks it
(esc to interrupt, then `/clear`).

## Bringing a chat back

Continue Last Session, the face's Sessions · Projects screen (your sessions
above, your repositories beneath, one highlight — ⇥ jumps containers,
highlighting a repository filters the sessions to it, ↵ on a session brings
it back and ↵ on a repository opens its most recent chat; a repo with no
history opens a new session there instead), `/resume`, `-c`/`--continue`,
`-r`/`--resume <id|title>`, and ↵ on a parked row of the board all come back
through one door. A
session live on the board is simply entered. Otherwise its transcript paints
at once from its file and the daemon admits the same durable session behind
the paint; a session whose runner the daemon still holds (one mid-respawn
after a crash, or one the records read as gone) is entered the same way and
one receipt row says so — `<title>: a live runner still holds this session —
re-attached to it` — while a session with no runner at all is revived, and
a refusal names the daemon's own reason; the chat lands ready on the first
↵ — a slow transcript never leaves the press dead — the first words you
type wait for that admission, and the away recap paints as a display-only
row, never in the model's conversation. The session comes back on its own
model and effort, unless
the boot named a `--model` or `--effort`: then the launch's word wins and
the recap card says so. Whichever
door, the whole estate is live behind the chat — the daemon, the board and
every other running session — and a resume yields, drains, kills, swaps or
respawns nothing.

## The preserved-thinking record

Each session keeps one small record beside its samples and its computer-use
grant, `<config-home>/sessions/<session id>/prefix-ledger.json`: a digest of
every part of the last request Mercury sent for it — each block of the system
prompt (with its text, so a moved section can be named), each tool, each
message block — and the response ids the history carried; never a word of
the conversation, a tool's output or an image. A fresh process bringing the
session back compares its first request against it, so a dropped thinking
block is named by the part that moved, and a record a request behind (the
previous process ended before its last write) says so instead of naming a
part. The record is written in the background once a request is on the wire
— never in the request path, one write for a burst of requests — and flushed
when the process exits. It is removed with its session: when the row is
removed from the board, and when the operator's prune deletes the transcript.
An interactive boot sweeps the rest: a record whose transcript no longer
exists goes, and so does one older than `MERCURY_PREFIX_RECORD_RETENTION_DAYS`
(thirty days unset); a live session's record is never touched.

A thinking drop after a long idle is named the same way as any other, by the
part of the request that moved. Mercury no longer asks the server to clear
reasoning older than the last turn once a session has sat idle for an hour, so
such a drop is never attributed to an idle clear.

## Winding a chat back

`/rewind` (alias `/checkpoint`) lists the turns of the focused chat and
restores to one of them — the files, the conversation, or both. The session's
own runner does the work: every turn it captures a checkpoint of each file its
tools edit (Settings › File checkpointing is the switch; the row beneath it,
"Checkpoints in this session", is what this session's runner actually does),
and a restore is the runner's act, answered as a receipt. Restoring the code
puts every tracked file back to its saved bytes at that turn, all or nothing —
a file you edited by hand since the session last touched it is refused by
name and nothing is written until you reconcile it. Restoring the
conversation winds the chat back to before that turn: the later messages
leave the model's view and the chat, the turn's words return to the composer,
and the session keeps its identity — the transcript keeps every row (ctrl+o
shows them), the same session resumes, nothing is deleted. A point that has no
saved files offers the conversation restore only; a point before the last
`/compact` is refused by name; a turn still running is interrupted first.
"Create a branch session from here" and "Rerun from here on a new branch"
leave this chat untouched.

## `mercury --chat`

`--chat` is the plain world: the Boot face and a chat, and nothing else on
the strip — no Session Concourse stop at all in that boot, and no Session
Concourse row on the face either (New Session is the door). A `--chat` boot
lands on the Boot face like a bare boot; ↵ on New Session starts the chat.
From the chat, shift+← is the Boot face directly and shift+→ moves nothing;
the face's key-map row reads "⇧→ chat" while a session is focused and "⇧→
no chat open" otherwise. `/concourse` still opens the plain
live view of your sessions there.

## `mercury --concourse-off`

`--concourse-off` turns the Session Concourse off for this and every later
boot — a saved setting (`concourseEnabled` in the global config; absent
reads as on), written only by this switch and the `/config` row "Session
concourse", never repainted by anything else.
`--concourse-on` or that `/config` row turns it back on; off is never a
one-way door, and with both switches on one line the later one wins.

With it off the strip is the same plain world as `--chat`: the Boot face and
the chat, no concourse stop — shift+→ walks only screens that exist. The
plain live view of your sessions is still one door away for a look — the
Boot face's concourse row ("live view only — concourse off") or `/concourse`
— showing the rows and their tiles with ↵ to enter one and no coordinator
pane, composer or new-session tab; the pane names the way back. The Boot face keeps its
repositories road either way: a repository pick on the Sessions · Projects
screen still opens that repo's newest chat.

Both switches also admit their single-dash spellings — `-chat`,
`-concourse-off` and `-concourse-on` are the same switches, rewritten at
the command line's entry.

## Commands that never reach the model

`/note`, `/remember`, and — when the Taste Loop is on — `/good`
and `/meh` are yours alone: the line runs on the screen, never enters the
session's conversation, never starts a turn and never rides the wire of a
later turn. The law and its enforcement are in [TRUST.md](TRUST.md).

## Before the context fills

Mercury checks the estimated context before each request, on every provider
route. At 40% of the seated model's window it can prune older file results
that a later successful Read, Edit or Write of the same path superseded.
The latest result for a path, unique results, failed or unfinished operations,
skill and brief material, and the five most recent eligible results stay.
Small results stay when a replacement would not save tokens.

The **superseded-result prune threshold** is set with `MERCURY_PRUNE_PCT`,
a percentage from 0 to 100. The default is 40; 0 disables this early prune,
and an unset, blank or invalid value uses the default. Mercury clears only
when the eligible results can bring the estimate down to two-thirds of that
threshold: about 26.7% of the window at the default. Otherwise it leaves the
history alone and the existing overflow recovery remains available. The
threshold uses the model's window, independently of a smaller automatic-fold
window you may have chosen; that earlier fold can run before this prune.

The chat reports the context size, threshold, number of results pruned and
estimated tokens saved. The replacements persist across later requests and
resume. This uses the same clearing and persistence path as overflow
recovery, without waiting for a provider refusal. It may invalidate part of
the provider's cached prefix; fewer input tokens do not by themselves promise
lower billed cost for a cache-heavy conversation. `MERCURY_AUTO_COMPACT=0`
leaves this prune available; `MERCURY_COMPACT=0` disables the early prune.
The time-gap trigger and emergency recovery retain their existing rules.

## When the context overflows

A request can outgrow the model's window — a large paste, a long run of
tool results, a switch to a model with a smaller window. The conversation
compacts itself before that point when it can; when a request overflows
anyway, the turn recovers instead of ending:

- Superseded tool results older than the recent few are pruned when that
  alone covers the gap the provider named, and the request is retried. The
  chat says so: "context overflowed … — pruned N superseded tool results and
  retrying".
- Otherwise the conversation is folded — the same summary `/compact` makes,
  on the same session — your message is carried across the fold word for
  word, and the request is retried once. The chat says "context overflowed …
  — folding the conversation and retrying", and the fold's own row reads
  "Context overflowed — folded and retried". Both carry the same words in
  brackets: the provider's own numbers when it named them; when it named
  none, Mercury's own count of the conversation and the window it measured
  that count against.
- The fold's summary is written by a model whose window holds the
  conversation. After a switch to a model with a smaller window that is the
  model the conversation was built on, never the model that just refused
  the request; without such a model the summary is written on the seated
  model and narrowed until it fits, as before.
- If it still does not fit, one plain line says what was tried and what to
  do: `/compact` folds by hand when automatic compaction is off, `/clear`
  starts fresh, `/model` picks a model with a larger window. A headless run
  reports the same line as its error.

Each step runs at most once per stretch of work; a completed tool round
starts a fresh one. The coordinator's chat recovers the same way. The
provider's own refusal never becomes the reply. `MERCURY_OVERFLOW_RECOVERY=0`
turns the recovery off; `MERCURY_AUTO_COMPACT=0` keeps the automatic fold off
while leaving the pruning step and the plain line.

## A line sent while the model works

A plain line sent while a turn runs goes to the session at once and waits in
the runner's own queue; its row paints under the composer with the plate
`queued` and no clock. The runner reads that queue at every tool boundary of
the running turn: once a tool round's results are in, and before the next
request goes out, the line reaches the model with those results — introduced
in Mercury's words ("The operator sent a new message while you were
working:") and followed by what the message means for the active task: a
correction applies before the affected work goes on, a question gets a brief
answer and the task resumes, a stop or a replacement is followed, a separate
task is kept for afterwards, the original objective stands unless the
operator changes it, and the turn may not end without accounting for the
message. Several lines sent before one boundary arrive together, each its
own message, in the order sent. The row then lands in the transcript where
the delivery happened, between the tool rows, and carries the clock the line
was sent at, not the boundary's; a headless run (`-p
--input-format=stream-json`) reads that clock from the user frame's
`timestamp` and stamps the arrival when the frame carries none. A line sent
after the turn's last tool round waits for the turn's end, as does a slash
command sent at any point of the turn, and so does a line sent after a
`/model`, `/effort`, `/subagents` or `/workflows` made while the turn runs
(the pick lands first, and the line runs on it); lines that arrive between
turns are joined into one row as
before; esc interrupts the turn and anything still queued runs as the next
turn.
The line always reaches the session's own model. A sub-agent the model is
running (an Agent tool call) has tool boundaries of its own; those read only
the notes addressed to that agent, never the operator's lines, so a line sent
while a sub-agent works waits for the session's next boundary, the Agent
tool's return included, and lands in the session's transcript, not the
sub-agent's.

## A line sent while the session compacts

A line sent while the session's runner is folding (by hand with `/compact`,
or on its own) waits in the runner's own queue and is drawn as a queued row
with the plate `held`; the hint row says "held until the compaction lands — it
delivers once, on its own (↑ takes it back)". When the fold lands the runner
takes the held lines as its next turn, in the order they were sent, behind
nothing newer, each exactly once; a line sent after the fold rides behind
them. `↑` on an empty composer while a line is held takes it back into the
composer, the way it does for any queued line.

A queued or held row stands only while the runner holds that line. When the
runner reports that it no longer does — a runner that restarted after the
send, whose queue died with it — the row leaves on its own and the hint row
names the words once ("the runner restarted — “…” not taken; type it
again"); `↑` on such a row answers "the session did not take “…” — type it
again" and removes it. A row that stands for a line no runner holds is never
left on the screen.

The hint row under the composer is where every such receipt or notice
paints, for its seconds. While one stands it takes the whole row: the standing
hints (`? for shortcuts · ctrl+x p for commands + files`, and on a narrow
window the session counts and the way-back hint) step aside and return in the
same place when it clears, so a receipt's fact — the model id a
`/defaultprovider` switch resolved, say — is readable at 80 columns. The
composer never moves for a notice.

## A notice an agent has not read

Every notice delivered to an agent of a session — a sub-agent's completion,
a workflow's or a shell's, a monitor's tick, a message queued for a
sub-agent, a schedule's wake — is a row of the session's unread-notice
ledger from the moment it is delivered until a turn of that agent takes it.
The session facts carry the ledger (`notices`: each row names its agent, its
kind, the notice in a line, the clock it arrived at and what became of it),
and every sub-agent's work row carries the count of its own unread notices;
the Crew view (`/teammates`) paints that count on the agent's row — "2
unread" — and nothing when there is none.

An agent idle with unread notices past the deadline is nudged. The session's
own main thread is woken through its queue with a line, in Mercury's words,
that names how many notices waited, for how long, and each one; the notices
themselves arrive as the turns just before it. A named agent parked between
turns is woken with the notices' own text. Each notice is nudged once. A
busy agent is never nudged: its own next tool round reads them. A nudge that
finds the agent gone — its run ended, it was stopped, no such agent in the
session — retires the notice: the row reads `retired` and says why, and the
line nothing would read leaves the queue. The deadline is
`MERCURY_NOTICE_DEADLINE_MS`, a whole number of milliseconds at or above
1000; unset, it is three minutes.

A task notification the chat shows — one the runner took mid-turn, or between
turns as a plain message — the chat shows once, in its place; it is never
redrawn under every new message until it ages out.

Completions that land while the session waits between turns fold into one
turn. The runner holds the first for the task poll's second and carries every
completion that has arrived by then in one message, one block each, so a
burst of background commands ending together costs one turn, not one per
command. A completion that lands during a turn is read as soon as that turn
ends, together with any queued beside it. The chat paints the carried message
as one counted row, exactly as it paints a run of separate notices.

## Where the pieces live

- The coordinator, teammates and the mailbox are [TEAMS.md](TEAMS.md)'s.
- What a session loads — its kit, the menu, presets, the in-session dials —
  is [KIT.md](KIT.md)'s.
- Schedules that wake a session or birth one on the clock are
  [SATURN.md](SATURN.md)'s.
- Workspace trust and the user-private commands are [TRUST.md](TRUST.md)'s.
- The idle-retirement, birth-grace, unread-notice deadline and prefix-record
  retention knobs are rows of the flag registry.
- The box's state rides the session facts as the `box` row, for the agents
  as much as the screen: the load per core and the memory available (the
  last sample the process took, with the clock it was taken at), the
  box lock's slots with who holds each and who waits (the coordination
  directory `MERCURY_BOX_LOCK_DIR` names, else the one the session's last
  `with-box-lock.sh` command used). An agent reads it as
  `mercury://health/box` through the Inspect tool, and a Bash result whose
  command waited on the lock carries one line saying how long, who held the
  slots, and the load at that moment.
  This is visibility only: nothing here schedules or throttles.
- Two more rows ride the session facts from the runner: the first-party
  usage-window verdict its own replies stated (`usage.anthropicWindow`: the
  state, when it was seen, the account slot, the reset and the window the
  wire named) and the OpenAI model list it fetched for its requests
  (`openaiCatalogue`). The screen folds both into its own record and
  catalogue, so the offer card and the rail's context figure follow the
  session's own wire; an older runner carries neither, and the screen's own
  reads stand.
- A session's scratchpad — `<temp root>/mercury-<uid>/<project>/<session id>/scratchpad`
  (`MERCURY_TMPDIR` moves the root) — is the place the model is told to put
  temporary files: helper scripts, intermediate results, captures. It lies
  outside the project, so `git status` never sees it; the turn receipt
  counts an edit there as a scratchpad edit, not a file edit; and it is
  swept when the session ends — by the daemon when a hosted session's
  record settles, by the process itself when it is its own session.
