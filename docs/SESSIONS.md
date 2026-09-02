# Sessions

The session is the unit; every screen is a view. A session owns its
conversation, model, posture, workspace and running work, and it survives
whatever screen is looking at it — the chat, the Session Concourse board, a
live tile and the Boot face render sessions and never store their truth.
This page is how sessions are born, focused, closed and brought back, how
the folder you start in becomes a project, and the two boot switches that
shape the journey. Every session is hosted by the background daemon.

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
entered from the board. Enter stays instant because a warm runner already
stands behind the menu; the birth claims it instead of paying a spawn. The session is born wearing the
repository's MCPs & Skills record — or the preset armed on the face — and
the launch receipt names which ([KIT.md](KIT.md)). The board's own `+ new session · n`
tab, at the right end of its SESSIONS title, is the same birth from the
board: a blank session in the project the board shows, focused at once.

The boot's own options ride into the sessions it opens: `-n <name>` titles
the first session you open (one-shot; later ones name themselves — below),
and `--effort`, the permission mode and the runner-side options apply to
every session this screen births.
Every ↵ on New Session opens another session; whatever the chat held keeps
running and shows on the board. If the daemon that hosts sessions is not up,
the row says so, and ↵ again starts it and retries.

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
and never another's.

The status row under the composer says what the focused session is doing,
and for how long, from the session's runner itself: "thinking for 2m",
"running a tool for 4m (its own timeout at 10m)", "replying",
"compacting", "ready". Those durations are facts, never accusations — the
transcript standing still is not a sign of trouble, since a long think, a
long tool run and a real hang all leave it still. The row says the session
may be stuck only when the runner's stream has carried no event of any kind
for longer than its own watchdog's warning point, and then it names what it
saw: "no stream events for 3m — the session may be stuck (the watchdog
aborts at 5m)". A running tool is never called stuck; its own timeout is
the deadline the row names.

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
first press shows the hint on the row, the second completes). On a parked
row the first completed chord says there is nothing to stop; the same
gesture again clears the row from the board — the chat survives on disk,
and the Boot face and `/resume` still offer it — and a live row you
release is cleared the same way, so a removed row never returns beneath as
parked. Everything else the project
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
session — the row stays, wearing stopped and the next step — and the same
chord again removes it from the board; typing is never a control, so a
plain `x` lands in the composer like any other letter. The board's REPO picker
changes the folder new sessions launch in, the whole harness follows, and
the board follows with it — it renders the same list of projects the Boot
face's Projects rows do.
`/halt` is the screen's brake — it fires interrupt-first, acting while a
turn runs, and never rides into a session runner. Attention rides one bell: a session taps the
terminal bell once when it needs you or finishes a run, the status strip's ⚑
badge counts what needs you, and `/pings` quiets the tap for you — the rows
and the badge stay. A run finished in
another project pings the same way, once per finish — a boot never rings
old news — and lands as a NEEDS YOU row that is a door, settled when you
take it; an untrusted folder is never switched into silently — the chat
still opens, and the note says where the view stayed.

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
deletes `.mercury/`.

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
the paint; the chat lands ready on the first ↵ — a slow transcript never
leaves the press dead — the first words you type wait for that admission,
and the away recap paints as a display-only row, never in the model's
conversation. Whichever
door, the whole estate is live behind the chat — the daemon, the board and
every other running session — and a resume yields, drains, kills, swaps or
respawns nothing.

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

`/note`, `/minerva`, `/remember`, and — when the Taste Loop is on — `/good`
and `/meh` are yours alone: the line runs on the screen, never enters the
session's conversation, never starts a turn and never rides the wire of a
later turn. The law and its enforcement are in [TRUST.md](TRUST.md).

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
  "Context overflowed — folded and retried".
- If it still does not fit, one plain line says what was tried and what to
  do: `/compact` folds by hand when automatic compaction is off, `/clear`
  starts fresh, `/model` picks a model with a larger window. A headless run
  reports the same line as its error.

Each step runs at most once per stretch of work; a completed tool round
starts a fresh one. The coordinator's chat recovers the same way. The
provider's own refusal never becomes the reply. `MERCURY_OVERFLOW_RECOVERY=0`
turns the recovery off; `DISABLE_AUTO_COMPACT` keeps the automatic fold off
while leaving the pruning step and the plain line.

## Where the pieces live

- The coordinator, teammates and the mailbox are [TEAMS.md](TEAMS.md)'s.
- What a session loads — its kit, the menu, presets, the in-session dials —
  is [KIT.md](KIT.md)'s.
- Schedules that wake a session or birth one on the clock are
  [SATURN.md](SATURN.md)'s.
- Workspace trust and the user-private commands are [TRUST.md](TRUST.md)'s.
- The idle-retirement and birth-grace knobs are rows of the flag registry.
