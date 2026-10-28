# Sessions

A session owns its conversation, model, permission mode, workspace and
running work, hosted by the background daemon across the home screen, chat and
Session Concourse.

The session is the unit; every screen is a view. It survives
whatever screen is looking at it (the chat, the Session Concourse board, a
live tile and the home screen render sessions and never store their state).
This page explains how sessions are started, focused, closed and resumed, how
the folder you start in becomes a project, and the two boot switches that
shape the navigation strip.
On Windows, each frame reads the window size from the console so the terminal UI follows it even when no resize event arrives.

## A fresh boot has no chat

On your first interactive run, choose an appearance, then sign in to a
provider. The screen previews theme changes as you browse. True Black is
the default; the other options are the oasis dark theme and Black and
white, which paints no colour at all: the terminal's own ink on its own
ground, the way Mercury looks on a terminal without colour. You can change
this later with `/appearance`. You can also choose "sign in later" to look
around without connecting an account; when a provider key in your environment
already signs a provider in, the sign-in step is not asked. Next, the
Guardrails step reminds you to check Mercury's edits and commands, and that
what it reads can carry instructions for the model. In a terminal Mercury knows
how to configure (Terminal.app, the VS Code family, Alacritty, Zed), a Terminal
keys step can configure newline keybindings in the terminal's own settings (on
macOS Terminal.app, it sets `Option+Enter` for a newline and silences the
terminal bell across every profile, which takes effect after restarting
Terminal.app; in the VS Code family, Alacritty and Zed, it writes
`Shift+Enter` for a newline). It is off unless you choose it, and a backup is
kept. Next, Mercury asks whether you trust the folder you opened; nothing
requested by a workspace configuration runs before you grant that trust, which
covers the whole repository ([TRUST.md](TRUST.md)).

Running `mercury` with no arguments opens the home screen: the card of New
Session · Continue Last Session · Boot Menu · MCPs & Skills · Agents ·
Health Check · Saturn Scheduler · Logins · Session Concourse, and
the merged Sessions · Projects picker, with no chat behind it. The
Boot Menu, the MCPs & Skills menu ([KIT.md](KIT.md)), the agent studio, the health
certificate, the scheduler board ([SATURN.md](SATURN.md)), the sign-in
catalogue and the session-and-repository picker open in place on the home screen
(`Esc` returns to the selected row without flashing chat chrome), while the Session
Concourse row opens the board one screen to the right. Pressing `m` on the home
screen (`m to select model-default`) opens the default model and effort picker
in place whenever `engine.sessionDefaults` is not `false`. The Boot Menu displays six section headings in screen order: **TRUST COMBO**
(`Content-rule wards`, `Debug tool (real debugger)`, `C/C++ IDE lane (clangd)`,
`Sovereign mode`), **COMPUTER USE** (`Computer use`, `Access type`),
**SAMPLES** (`Samples`), **AGENTS** (`Crewmates`, `Workflows`, `Crewmates while
backgrounded`, `JEV`), **MISCELLANEOUS** (`Launch animation`, `Godot language
lanes`, `Godot control surface (VULCAN)`, `Unity dev lanes`, `Blender dev
lanes`, `Aseprite dev lanes`, `Cap failover posture`, `Session Concourse at
boot`, `Seats`), and **PERFORMANCE** (`Motion`). The Boot Menu's Performance
section includes a Motion setting: `auto`, `full`, `reduced` or `off`. It
controls idle animation in the interface and is also available in `/config`. A chat exists
only once you enter
one: New Session, Continue, a pick on the Sessions · Projects screen, or a
row on the concourse board. Until
then the screen's chrome (the model chip, the mode readout, the folder row)
reads the screen's own state, and a screen left
with no chat returns to the home screen on its own.

Where a boot lands is the home screen unless something outranks it: an
explicit journey (`--continue`, `--resume`, a prompt argument), or the
`MERCURY_CONCOURSE` policy (`always` makes the board the boot home, and `auto`
opens the board when more than one session is live or one is waiting on you).

## The strip walks only the screens that exist

`Shift+←` and `Shift+→` move between the screens that exist, and nothing
else. A fresh boot has two: the home screen and the Session Concourse
(`Shift+→` from the home screen opens the board, and `Shift+→` from the board moves
nothing when there is no chat open). The chat joins the strip the moment a session is focused (`Enter` on
New Session, `Enter` on a board row, or a resume) and leaves it when the last chat
closes. Every move lands on the nearest screen that exists in that
direction, and the dim key-map row on the home screen and on the board names
only the moves that exist: `"⇧→ concourse"` on a fresh boot, `"⇧→ chat"` once a
session is focused, `"⇧→ no chat open"` when nothing lies to the right,
repainted the instant a screen appears or vanishes. On the board, `Esc` returns
to the focused chat while one exists (and to the home screen when none does,
matching its legend), and the FOCUSED CHAT crumb is active only
while a chat exists.

## Starting a new session

Pressing `Enter` on New Session creates a session for the current folder on your
default model, and opens it. The session, the chat and its board row are created
together (the record is on the board before the chat paints)
and no prompt is sent: the session starts blank and ready, just like a row
opened from the board. A `/mission` typed in the moment before the runner
is ready still belongs to the chat you opened: it moves to the session at
admission, its card and its Stop hook with it, and the rail shows it once
the runner is ready. Pressing `Enter` opens a chat immediately using a pre-warmed
background runner. The new session loads the
repository's MCPs & Skills selection (or the preset you selected on the home screen), and
the launch receipt names which ([KIT.md](KIT.md)). The board's `+ new session · n`
tab, at the right end of its SESSIONS title, starts a new session from the
board in the project the board shows, focused at once.
When every session slot is taken, the launch waits up to 20 seconds for one to free
and starts automatically when it does; otherwise the home screen reports how many live
sessions hold the slots and how to free one (stop or
park a session on the Session Concourse, or raise the ceiling with `/seats N`),
and pressing `Enter` waits again.
The board's door row (the empty board's entry, and the first row above the
sessions once there are any) names the model and the effort the next
session starts on; with that row under the cursor the bottom row shows `m
to select model-default`: pressing `m` opens the model picker over the board, and the
pick is saved as your default while the door row updates at once. If saving
fails or `MERCURY_MODEL` overrides the saved choice, the picker stays open
with the reason in its notice row; compact layouts omit that row. A failed
effort save keeps the prior effort selected. Pressing `Enter` on the row starts a session
as `n` does. On a session row, `m` opens that session's picker on its own
effort, with only the effort levels the session accepts.
The effort selection follows the session's settled value; a refused change
leaves it where it was.
The chat paints while the session starts, and its first frame already names
the model, the effort and the permission mode resolved at launch; once the
session's own record and facts are read they take over with the same values.
A value not resolved at launch stays unpainted until the
session's record names it.

The boot's own options apply to the sessions it opens: `--title <name>` titles
the first session you open (one-shot; later ones name themselves as described below),
and `--effort`, the permission mode and the runner-side options apply to
every session started from this screen.

The model and the effort a session runs follow one law. An explicit
`--model` or `--effort` on the command line wins, for a new session and for
a resumed one alike. Without the flag, a new session starts on your saved
choice (`/model` and `/effort` both save the pick as your default and say
so) and, with nothing saved, on the family default. A saved family word
follows its family's newest row (`sonnet` runs Sonnet 5.5 as `opus` runs Opus
5.5) while a saved full id such as `claude-sonnet-5` stays on that generation.
A saved choice whose
family cannot serve it (no sign-in for that family here, or a sign-in whose
catalogue refused it; a catalogue not fetched yet is not a refusal, so
the chat starts on the saved choice) does not block the launch: the chat starts on the
computed default (the most recent sign-in's newest usable row) and its first
row says so, naming the family, the reason and the commands (`/logins <family>`
connects it, `/model` changes the default); the saved choice is left as it
stands, so the next chat returns to it the moment that family signs in;
`/model` in that chat saves a new default and the next New Session runs it.
A claude.ai or ChatGPT sign-in is checked once when Mercury opens and
whenever `/health` runs: a sign-in past its expiry is renewed through its
refresh grant, and one the provider refuses shows as `<Family> sign-in
expired` on the boot screen's Logins row and in `/health` before a first
prompt is sent. A prompt that still meets an expired sign-in is not lost: the
error line paints, its words come back to the composer, and they are sent
again on their own once `/logins` lands a credential (or `/model` moves the
session to a signed-in family) while the composer holds them unchanged.
The board's New
Session strip starts on the same saved choice; its own effort pick, when
you make one, applies to that one session. A resumed session
keeps the model and effort it was on unless the command line says
otherwise: `--continue --model <id> --effort <level>` brings the session
back on the launch's model and effort, its record is re-stamped, and the
resume card names which won when the launch's word and the session's saved
word differ. `/model default` clears the saved choice. In the chat the
picker opens centred, as it does over the board; `view.modelPicker.centred: false`
in settings.json puts it back at the left edge. `/model <words>` echoes the
words you typed on the first line (with the resolved model id) and the switch
receipt on the second line (`Model now: <display> · saved as your default for
new sessions …`). When `memory.tellEngineSwitch` is `true` in settings, the
meta line sent to the model includes the switch timestamp with its UTC offset
and instructs the model to include the time zone when repeating the switch
time. Selecting an effort level in `/effort` or via `ctrl+e` inside `/model`
saves it to `<config home>/settings.json` (`Effort set to <level> · saved as
your default for future sessions`); if writing `settings.json` fails, both
`/model` and the effort picker name the file and the OS reason (`not saved as
your default: ~/.mercury/settings.json …`).
`/model` or `/effort` sent while a turn runs answers "applies when this turn
ends", and lands exactly there: at that turn's end, before any line waiting
for the next turn. A line sent after that pick, while the same turn still
runs, waits for the turn's end as well and runs as the next turn, on the
model and effort the pick named, so the order you gave is the order that
runs; its row keeps the plate `queued` until then. `/crewmates on|off` and
`/workflows` flipped while a turn runs hold a later line the same way: it
waits for the turn's end and runs with the switched roster. A line sent
before the pick keeps its place: it may still join the running turn at a
tool boundary, and a line that joined the running turn is that turn's own
and runs on its model. Sent while the session only waits on its background
work, or holds a finished task's notice, the pick applies at once.
While the turn waits inside a tool call with a sent line behind it, the
status row adds `ctrl+s s sends now`: ctrl held and `s` pressed twice within
two seconds sends the waiting line into the running turn at once. A
crewmate or a shell command the turn was waiting on moves to the background
and keeps running (its result arrives as a notification), a Sleep ends, and
the line opens the agent's next step; one `ctrl+s` alone stashes the draft
as before.
Every ↵ on New Session opens another session; whatever the chat held keeps
running and shows on the board. If the daemon that hosts sessions is not up,
the row says so, and ↵ again starts it and retries.

The active background daemon hosts the terminal's session seats, warm
runners and named crewmates as `mercury runner` children from its own build.
It sends their prompts, reads their rows and holds their permission asks,
and it outlives whichever window started it. Close that window and the daemon passes to
another that is still open, so the sessions your other windows hold keep
their runners and lose nothing; it shuts down only when the last window
closes, and parks every session on its way out so the next boot brings them
back. A window opened while that daemon is still on its way out waits the
beat it takes to leave, then starts its own, and a daemon that leaves in the
beat after answering a new session's window is checked for and started
again by that same ↵, so the session lands without a second one. Each ↵
names its launch with one key that both the first admission and the retry
carry, and a daemon that admitted the session but whose answer was lost in
transit answers the retry with the session it already holds, so `Enter` lands
in that one session and never creates a duplicate. One active daemon owns the config home's
control socket. During an update, a draining helper can keep the sessions
it already hosts while the installed build takes new sessions; it leaves
when its own last session finishes. A daemon whose directory is removed
while it runs writes nothing more there and exits. Moving the installed
build never cuts a live runner short; [TERMINAL-RUNTIME.md](TERMINAL-RUNTIME.md)
describes the update's handover and open-window notices.

A chat you just opened is never reaped before your first message. An empty
background session retires after `MERCURY_SESSION_IDLE_RETIRE_MINUTES`
(default 10; 0 disables; the row stays on the board as stopped, `"retired —
empty and idle for 10m"`, until you release it), but a session started through
New Session that has not received your first message is excluded from that
timer: without limit by default, or for the
`MERCURY_SESSION_NEWBORN_GRACE_MINUTES` you set, and the first message ends
the grace period either way. A session started this way and never messaged that the daemon finds
stopped at its next reconcile is released instead of being marked NEEDS YOU,
because there is nothing to resume.

## A session names itself

A session's name updates in three stages: when created, `"new session ·
<project> · ready"`; at your first message, the first line of
the prompt; and once its second reply lands, a short generated title (the
small model writes one once per session, and only when no custom title is set,
so a title you typed is never overwritten and title generation never runs twice; if
generation cannot run offline or is refused, the existing title stays). A name
never regresses to an earlier stage. `/title <words>` names the focused
session yourself (a typed name outranks and outlives the generated title), and a
bare `/title` asks the model to generate one again; `r` on a board row
renames it there. The worker id appears only in the detail column and never as a
session's title. `/rename <words>` names the session from the
chat. The name lives in the terminal's title, on the concourse and in
`/sessions`; the chat itself paints no title row.

## The focused chat

One chat is on screen at a time: the focused one. The daemon records which
session a terminal is looking at, and a hop moves that mark from the chat
you leave to the one you land on, so exactly one session per terminal is
focused at any moment.

Focus carries your active approval channel. The focused chat launches workflows and crewmates on
your authority, under its own permission mode. A background session
keeps working single-handed and waits until you visit it, until it
holds the workflows-allowed grant (asked of the coordinator, chosen as
keep-and-background on leave, or the manual-start option), or until you turn
on "Crewmates while backgrounded" (in `/config` or in the Boot
Menu's Agents section; off by default). With it on, every session you have
left in the background launches crewmates and workflows as a focused one
does, under its own permission mode and its own Crewmates and Workflows
switches, and a session started while it is on carries the Crewmate and Workflow
tools from its first request; the workflows-allowed grant stays unchanged.
With it off, a background session's launch refusal names the three ways to allow it.
A hop updates focus immediately. `/runs`,
`/workflows` and the board's work chip show the focused session's own work
and never another's. A shell's row on the board, or in the side rail's RUNS
lane, opens its card: the whole command, the directory it runs in, the time it
has run, its exit code once it has ended, and the last lines of its output,
read from the output file the session's runner writes, under a
count of the lines shown against the lines it has written. On a short window
the command yields rows to the output, so at least one line of it always
shows. In `/help`, pressing `PageDown` or `PageUp` from the tab header enters
the command list and pages immediately. Tool calls appear as they run, either as
compact cards or with full output (choose the display in `/config` under Tool
output). Review changes with `/diff`, by source, file and hunk; `! <command>`
runs a shell command in chat with a live output tail; `/mouse off` returns the
pointer to the terminal for native text selection and copying (saved in
`/config` as Mouse capture). `/copy` puts the last reply on the system
clipboard as the model wrote it, with its line breaks, emoji and right-to-left
text and none of the screen's wrapping or row marks; `/copy 2` takes the reply
before it, `/copy code` the last fenced code block, and `ctrl+x y` runs `/copy`
from the composer (with a message focused through `shift+up`, the same chord
copies that message). The text goes through `pbcopy` on macOS, `clip` on
Windows and `wl-copy`, `xclip` or `xsel` on Linux; over SSH, or where none of
those answers, the terminal itself is asked to take it (OSC 52) and the row
says so. A required argument starts with `<…>` in a skill's
usage (for example, `/update-config` and `/debug`): send one alone and you get
its description and usage without starting a turn, or select it in typeahead and
`Enter` leaves `/name ` ready for the argument (`/loop` has no required argument
and runs immediately).

When a model returns its reasoning text, a folded `✻ thinking…` block appears
above the reply and expands on click or in the transcript view (`ctrl+o`). When
a provider returns a signed thinking block without text (private thinking), the
chat draws no thinking row by default; clicking the turn's answer or work row
(or opening `ctrl+o`) reveals `✻ thinking…` with `the provider returned no
thinking text for this model` once for that turn. While a permission or
question card is waiting over the composer, words you type remain visible
beneath the card, and a draft restored to the composer after a card or
interrupt is labelled and armed so a second `Enter` sends it with focus on the
rows.

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
for the session's life, and the composer shows its size
and what it was shrunk to when the provider's limits required resizing. An image
sent while a turn is still running rides as a reference to that file, and
every later request reads its bytes back from the store, including in a resumed
session. Copy an
image and come back to Mercury and it shows the paste shortcut. An image is never
refused for its size: it is shrunk to the provider's published limits
(`/health` names the active image processor); the only refusal
is an image whose smallest encoding still exceeds the limit, and the error
names which limit and what size. Each provider's rule is its own: the Claude
API caps an image at 10 MB of base64 and 8000 px a side, and at 2000 px a
side once a request carries more than 20 images, while the OpenAI
API caps a request at 512 MB and an image at 30,000 patches of 32 px, so a
GPT session shrinks a large image to that patch count and never to a byte
figure. The many-images cap is applied when each request is composed: the
images the request carries are counted, the earlier turns' included, and
every image over the cap that count implies rides as a sized copy while
the conversation file keeps the original, so a long image-heavy session
carries on past its twentieth image. An image the image library cannot
size (a JPEG or an interlaced PNG where only the JavaScript road serves)
rides as a one-line note in its place instead of going out over the cap;
the conversation file keeps the original, the session is told once, and
the Image processor row of `/health` names the road. A session the API
refused for that limit carries on at its next send, on the same model or
after a `/model` switch, with no `/clear`: the refusal's words say the
images are sized at the next send, an image that cannot be sized is left
out of the request, and nothing is dropped from the transcript. Should a
provider still refuse an
attached file's image, that image leaves every later request of the
session, a resumed one included, on the OpenAI route as on the Anthropic
one.

The session box at the top of the view holds the critter and, while
a turn runs, the working row in its own capsule beside it: a slim box of
five rows, the sprite at its left and the capsule to its right, the capsule
taking the rest of the box's width. The sprite sits level with the
capsule's middle however tall the capsule grows (the lower of the two
middle rows when the capsule has an even number of rows): a status that
stacks or wraps onto more lines lengthens the capsule downwards and the
sprite follows its middle. The same small sprite is the critter everywhere
it appears (the session box, the compact layout's band, and the header above the chat),
and clicking it or running `/critter` chooses the
creature (on a new config home, the default is the crab in its red; the first-run
theme fitting chooses only the colour theme). The view runs from the top of the screen down to the status row
above the composer; the rails beside it run the same height.

The status row above the composer keeps the session's model and the
effort word its chip paints in every state: it rests on
`ready · <model> · <effort>` while the session is idle and no crewmate is
running, and otherwise reads `<model> · <effort>` followed by what the
session is doing (a wait on crewmates, a request wait, a confirmation notice, a
warning, or the crew's timer while a crewmate or workflow
the session's runner hosts is still running) by kind: `"crewmate thought for
28m"`, `"workflow thought for 12m"`, or both when both run (the larger first).
The timer counts the crewmates running now; when the last of them finishes
or is stopped the row reads `ready` again on the next beat, and the finished
rows keep their own elapsed time in the CREW box, `/crewmates` and `/runs`. At its
right end, before the way back, the row names the folder and the branch the
session works on (`mercury ⌥ main`; the folder alone where there is no
branch). When the row is too narrow for everything, the state words
shorten first, then the folder leaves, then the branch, while the model and its
effort stay. The row wears no glyph and paints no session name. In the compact
layout (terminals narrower than 100 columns or shorter than 26 rows), the line
under the input box also shows the count of HTML preview pages (`/samples`)
created in the session. The main
agent is narrated once, by the transcript's thinking row and the card under
the critter, and never repeated here; a session with no running crewmates paints no
timer while its main agent works. An `/effort` pick's confirmation notice
stands on that row for eight seconds in place of its resting text,
then the resting words return with the new effort; where the row is not
painted (the compact layout) the notice appears under the composer.
Pressing `Esc` in the main chat stops the current turn immediately while your
crewmates keep running, and any reply already written before you pressed `Esc`
stays on screen and in the transcript. When you view a crewmate, the bottom
model chip shows that crewmate's model, and returns to the session's model when
you switch back to the main chat. The interrupt ends the tool call in flight as well as the
request: a tool that answers the interrupt within its grace period (three quarters
of a second) settles with its own output, and one that cannot (such as a browser
whose process is gone or a call waiting on an unresponsive child)
is left behind, its result replaced by the interrupt notice, and any late
answer is dropped. Pressing `Esc` a second time while the first is still
in flight delivers the interrupt again: the runner process is
never killed by `Esc`, its crewmates keep running, and a runner that cannot answer stays
busy until you stop it (`ctrl+x ctrl+x` on its board row stops the session, and `/crewmates`
stops an individual crewmate). A stop you request is recorded on the session as
a user stop instead of a crash, and resuming brings the runner back
with that status. A turn that fails inside the runner's own machinery before it has
answered ends in a failed `outcome`: `error.message` names the failure and
`error.detail` carries any further diagnostics. The session lives on to read
the next line; only a failure after the turn has already answered still ends
the runner. While a shell command runs for the main agent, ⇧b moves it to
the runner's background tasks and the turn goes on without waiting: the hint
row under the composer reads `esc interrupt · ⇧b background the command` and
the row's tail `esc interrupts · ⇧b backgrounds · ⇧← back` for as long as
the command runs, and the agent is told the command was moved to the
background as a task whose output arrives as a notification; with a draft in
the composer the key types its letter. `view.backgroundKey: false` in
settings.json turns the key and both hints off, and esc keeps its meaning
either way. The row's warnings stay its own: a request wait names what the
runner waits on and the budget that fires (`"waiting for the first byte from
Opus 5.5 — within 6m"`); a held turn names what it waits on (`"waiting on 1
workflow · 2 crewmates"`); an interrupt says the request is torn down. The row
says the session may be stuck only when the runner's stream has carried no
event of any kind (the provider's heartbeats included) for longer than its
own watchdog's warning point: never sooner than five minutes of silence, and
never later than the watchdog's own cut. On the routes whose keep-alives
feed the watchdog the budget is six minutes (twelve in patient mode), so the
row can name the silence from five (`"no stream events for 5m — the session
may be stuck (the watchdog aborts at 6m)"`); on the quiet routes, whose budget
is fifteen minutes, the row names what it saw from seven and a half (`"no
stream events for 8m — the session may be stuck (the watchdog aborts at
15m)"`). Every wait, warning and reissue line spells a minute or more in
minutes (`"within 2m"`, `"within 2m of dispatch"`) and anything shorter in
seconds. A running tool is never called stuck. The chat pane carries no
clock: every row of the chat carries its own timestamp, and a clock that
ticks is a repaint a second on an idle screen.

## Oculus

Every session is hosted by the daemon as a runner, and every session is one
of two kinds. An oculus session is one a screen belongs to: the Mercury
screen in your terminal is the window onto it, you are there, and you may
switch to another session and come back. Every session you start from the
screen is oculus: New Session, `--chat`, a resume, a session the board's
composer launches. The kind is decided once, when the daemon admits the
session, from who asked for it, and it is stamped on the session's record
and on its runner; it is never guessed from a terminal later, so switching
away from an oculus session does not change what it is.

Three things follow from the kind, and nothing else does. The model is told,
in one line, that the operator is on the screen and may be away for a while,
so it asks as it normally would and a slow answer is not "nobody is here". A
permission ask or a question from an oculus session waits for the screen
without expiry, in every permission mode, until you answer it or end the
session; `MERCURY_PERMISSION_ASK_EXPIRY_MINUTES` never applies to it. And a
turn that ends on a question is not blocked: the question waits on the
screen, and you answer next. The model's tools, the permission decisions,
the rows the runner emits and the wire bodies are the same as a headless
session's, byte for byte.

## Headless

A headless session is unattended: nobody is at a screen for it. `mercury run`
from a script, `mercury runner` under a script or the SDK, a session a
schedule starts ([SATURN.md](SATURN.md)), and a session the coordinator
launches for a lane are headless. The model is told so: with a host that
holds the asks, a tool call that needs approval is put to the host and a
question travels the same door; with no host, an ask is denied and no
question can reach anyone. An ask nobody answers expires on its clock (ten
minutes in Flow, three in Sovereign; a crewmate's ask ten minutes in every
other mode), and a turn that ends on a question nobody could answer ends
`blocked` with the question quoted on its outcome row, which is how a script
tells stuck from done.

The Session Concourse row of a headless session leads its NOW cell with the
word `headless`; a session's own `mercury://seat` reference names its kind in
its posture line. A session record that carries no kind runs as headless
until the session is resumed from the screen.

## The concourse shows the project you are in

`/concourse`, the home screen's Session Concourse row, or `Shift+→` from the
home screen opens the Session Concourse: the control board for the project
you are in, and its resume screen. On the first visit to the Session Concourse,
a one-time `"FIRST BOOT — capacity check"` dialog asks whether to probe the
machine's cores, available memory, and running agent CLIs to size how many
parallel sessions fit (`"y run it once"` or `"n no probe — the machine's own
reading decides"`, `"esc keeps the default · asked once, never again"`). The
board is scoped to that project: its
sessions that are running, waiting for a slot, or finished and waiting for a
merge, and beneath them, PARKED, the project's chats with no running worker.
When you pick another project (through the rail's REPO picker
or the Sessions · Projects screen on the home screen), the board shows that project's
sessions instead, while every other project's sessions keep running. Activity
in other repositories stays visible: each other project with activity
paints one summary line under OTHER PROJECTS, between the live rows and
PARKED (`"N running in foo"`, with its finished and needs-you counts and
`"switch to see them"` in its NOW cell), and pressing `Enter` on it switches the view
through the REPO picker's path; at most three lines paint, and a `"+N
more projects with activity"` line opens the picker itself (also `Ctrl+G`). The
home screen's Projects rows show the same counts (`"foo (3 running)"`)
through the same running predicate. The chat you are in stays visible across a project
switch: the board always includes the focused
session, wherever it lives, marked with `✦ "from <its project>"` beside its
title (among the live rows when running, or at the top of PARKED when stopped),
and pressing `Enter` opens it; focusing a session of the current
project returns the carried row to its own project board. Two things on the board
are machine-wide: the rail's counts (`"N live"`, the seats
fraction) count every running session on the machine, and the NEEDS YOU
rail lists every open question across all projects so no question goes unseen;
pressing `Enter` on a NEEDS YOU row switches the view to its project and opens the
chat.

Pressing `Enter` on a live row switches to that session's chat (with its own
model, permission prompts, and counters) while every
other session's runner keeps working. The parked rows list the project's
stopped chats touched within the last week, newest first,
up to ten, each showing its stored title (or its first prompt line)
and `"parked · <age>"`. Pressing `Enter` on a parked row resumes it in place: its transcript paints at
once, the daemon starts a runner for that session behind the paint, it
becomes the focused chat, and `Shift+←` and `Shift+→` work from there as usual. The
board's close key is a chord, never a single letter: `ctrl+x` pressed twice (the
first press shows the hint on the row, the second completes), and the
chord steps through three stages. On a live row it stops the session (the
row stays, marked stopped with the next step); on a stopped row it
parks the session; on a parked row a first chord says the next one
deletes it, and that next chord (or a chord right after parking)
deletes the board record while keeping the transcript on disk so the home screen and
`/sessions` still list the chat. A chat that was never messaged has nothing
to park: on its stopped row the hint reads `"ctrl+x again removes it (the chat
held no message)"`, the next chord removes it from the board, and when it
was the only chat the navigation strip returns to its two screens. A door row
(another project or the repo picker) has nothing to close. All other chats in the project
(chats older than a week, beyond the first ten, removed from the board, or
never messaged) are counted on one line, `"N older chats · ↵ to
browse"`: `↵` unfolds that very list in place on the board (this project's
older chats, newest first, each with its name and age), `↑↓` or a click
selects inside it, `↵` on one brings it back through the same door a parked
row rides, `esc` (or moving off the line) folds it back to the line, and a
list longer than the window ends in honest arithmetic
("+N more — /sessions lists everything"); the board keeps the frame throughout,
and the close chord on that line clears nothing. The project's full history
is also available through `/sessions` in the chat (project-scoped; `a` widens
it to every project's history), where chats can be resumed or cleared
one at a time. Nothing in the board deletes a transcript: no row or key unlinks
a chat, and the retention sweep (`records.retentionDays`, default 30
days) ages only recordings and tool results, never
a session transcript. The one way to delete a saved session is on purpose, from
the command line: `mercury sessions delete <id>` asks first (`--yes` skips the
question).
Setting `records.retentionDays` to `0` turns transcript writing off for
new chats; the transcripts already on disk stay.

Every live row is a tile: the NOW cell streams what the session is doing
right now (the reply's last line, or the tool it is running), and `→`
opens a preview of the selected row in place. When a runner crashes, its row
shows NEEDS YOU with the exit code and the last error or stderr line;
the row stays across reconciles until you act on the session or release the row.
The daemon's log records the same line for every crash. `ctrl+x ctrl+x` stops the selected
session (the row stays, marked stopped with the next step), the chord
again parks it, and a third chord removes the board row; typing is never a control,
so a plain `x` lands in the composer like any other letter. The board's REPO picker
changes the folder new sessions launch in, and the board updates to render
the same list of projects as the home screen's Sessions · Projects view.
`/daemon halt` interrupts immediately while a
turn runs, without routing through a session runner. The status strip's `⚑`
badge counts what needs your attention. A session that finishes a turn while you are viewing another screen
is not a question: its row shows its state glyph and status word in amber until
you open the chat again, while a turn you watched to completion in the chat
leaves no unread mark. A question from another project opens that project's chat when you press `Enter`; an untrusted folder is never
switched into silently (the chat still opens, and a notice states that the project scope stayed unchanged).

See [CREW.md](CREW.md) for the coordinator that launches, monitors, messages
and queues sessions from the board.

## The folder is the project

Open a terminal in any folder and run `mercury`: that folder is the project,
by its name, from the first frame (the home screen's card and its Dir chip
name it, and a folder that is itself a `.mercury` directory is named after its
parent folder). Nothing is written into the
folder until a chat is started there: opening the home screen and
exiting leaves the folder untouched. Starting the first chat in the
folder initializes an empty
`.mercury/` directory in the folder and a project record in Mercury's
config home beside that folder's transcripts. From then on the folder appears in
your project list across the home screen's Sessions · Projects view and the board's REPO
picker. Mercury writes no ignore rules, never modifies `.gitignore`, and never
deletes `.mercury/`. The project folder holds shared configuration (settings,
command safety rules, Apollo specs, custom agents, and saved
workflow scripts) the way a crew commits its shared config; everything a
machine or a session writes for itself (run manifests, ledgers, evidence,
test-run records, local memory, and the health check's certificate)
lives in the config home beside that folder's transcripts. A local store
found in the project folder from before is read once and moved on its
first touch; the folder keeps its copy, and the health check's Project estate row
names it with the one `git rm --cached` line that untracks it.

The left rail carries a FILES box named for the focused session's
folder; switching into a session of another project moves the box and its tree
with it. Pressing `Enter` or clicking it opens the folder's tree as a menu over
the chat: `→` unfolds a folder and `←` folds it, `/` filters the rows by
name, `Enter` on a file inserts `@` and its path at the composer's cursor and closes
the menu, and `Esc` or clicking outside the menu closes it. Inside
a git repository the menu's second line names the branch and the count of
changed files, and a changed file carries its mark at the row's right edge.

With a `.md` file selected, `r` opens a reader in the same menu. Markdown
wraps to the popup width; `↑`/`↓` scroll a row and `PageUp`/`PageDown` scroll a
page, with the visible row range in the footer. `←` or one `Esc` returns to
the same file, and `Enter` attaches it just as it does from the list. Image
references show their alt text and path. Large files display their first
256 KiB with a truncation notice, and git-ignored Markdown files open normally.
Reading a file here does not send it to the model or record it in the
transcript. On folders and non-Markdown files, pressing `r` leaves the file list
in place.

When you open an external editor, suspend Mercury with `Ctrl+Z`, or exit,
Mercury waits up to 250 ms (`MERCURY_TERMINAL_QUERY_SETTLE_MS`) for pending
terminal capability replies to finish so escape codes never leak into your
shell or editor. Clicking outside closes any popup over the chat that `Esc` closes,
stepping back one level without selecting text, opening a
link or pressing anything in the chat beneath it.
The `view.files` setting set to false takes the FILES box off the rail.

A session can work in a worktree of its repository instead of the checkout
itself: `--worktree [name]` at launch cuts one (with `--multiplex`, inside a tmux
session of its own), and the EnterWorktree tool cuts one mid-session on the
word "worktree". The worktree lives under the repository's
`.mercury/worktrees/` on a branch of its own, cut from the commit the checkout
is on (the branch you work in, never a remote's copy of it, and nothing is
fetched to cut it; a `--worktree` name of the form `#<n>` or a pull-request
link cuts it from that pull request's head instead) and comes ready to build:
`node_modules` and each `vendor/<pack>` the checkout ignores are links to the
checkout's copies, hidden from git through the clone's exclude file, so the
checks run there without an install. Because `node_modules` is a link to the
checkout's, an install run inside the worktree installs into the checkout's
dependencies instead of a separate copy.

## Closing chats

Releasing the last row on the board closes the last chat: the slot rests on
no session, the chat stop leaves the strip, and the board keeps the frame,
returning to the two screens without creating a new session or jumping to the
home screen.
`/clear` in a chat starts fresh: the focused session is parked (its slot
released, its row on the board reading `"parked · <age>"`, `Enter` there brings it
back, and its transcript is kept) and a fresh session opens in the same folder on
the same model, blank and listed on the board immediately; the cleared chat is never
lost. With no chat open there is nothing to clear, and a session mid-turn is
never dropped under you: the refusal names the one action that unblocks it
(`Esc` to interrupt, then `/clear`). When leaving Mercury (`/exit` or
`ctrl+c`/`ctrl+d`) after a session in which a tool call failed or a turn ended
on an error, once per session the exit confirmation card (if live work is
running) or the farewell line prints `Something broke?
https://mercury-cli.ai/report`; a clean session ends on the farewell alone.
Inside a session, `/bug --short <what you tried>` files the same short tester
report (OS, what you tried, what broke, no health dump).

## Bringing a chat back

Continue Last Session, the home screen's Sessions · Projects view (your sessions
above, your repositories beneath, one highlight where `Tab` switches sections,
highlighting a repository filters the sessions to it, `Enter` on a session resumes
it and `Enter` on a repository opens its most recent chat; a repo with no
history opens a new session there instead), `/sessions`, `-c`/`--continue`,
`-r`/`--resume <id|title>`, and `Enter` on a parked row of the board all resume
through one path. A
session live on the board is entered directly. Otherwise its transcript paints
at once from its file and the daemon starts a runner for that session behind
the paint; a session whose runner the daemon still holds (one mid-respawn
after a crash, or one the records read as gone) is entered the same way with
a receipt row (`<title>: a live runner still holds this session —
re-attached to it`), while a session with no runner is revived, and
a refusal names the daemon's reason; the chat opens ready on the first
`Enter`, the first words you
type wait for admission, and the away recap paints as a display-only
row, never in the model's conversation. The session comes back on its own
model and effort, unless
the launch passed `--model` or `--effort`: then the command-line flag wins and
the recap card says so. Whichever
way you resume, the daemon, the board and
every other running session keep running undisturbed.

A runner that stopped mid-work (from a crash, or a user stop followed by a
resume) comes back with its queued work. The session's record keeps
what the runner had queued and what its background crewmates had reported:
each line you typed that the stopped runner never read is queued again under
its own id and runs as the next turn; a crewmate that had finished is
delivered from the notice it left, byte for byte; a crewmate still working is
relaunched from its own transcript, told that its files hold the edits it
made and to read them again before editing; and only a launch the record
has no entry for is reported stopped. One row summarizes what the restart
carried (`runner restarted after a crash: 2 background crewmates relaunched, 1
delivered from their receipts, 0 stopped`, or `runner restarted after a
stop: …` when you had stopped it). The runner resumes on your next action (resuming
or sending a message).

## The preserved-thinking record

Each session keeps one small record beside its samples and its computer-use
grant, `<config-home>/sessions/<session id>/prefix-ledger.json`: a digest of
every part of the last request Mercury sent for it (each block of the system
prompt with its text so a changed section can be named, each tool, and each
message block) plus the response ids the history carried; never a word of
the conversation, a tool's output or an image. A fresh process bringing the
session back compares its first request against it, so a dropped thinking
block is named by the part that moved, and a record a request behind (when the
previous process ended before its last write) says so instead of naming a
part. The record is written in the background once a request is on the wire
(outside the request path, one write for a burst of requests) and flushed
when the process exits. It is removed with its session when the row is
removed from the board or when you prune the transcript.
An interactive boot sweeps the rest: a record whose transcript no longer
exists is removed, and so is one older than `MERCURY_PREFIX_RECORD_RETENTION_DAYS`
(thirty days when unset); a live session's record is never touched.

A thinking drop after a long idle is named by the part of the request that
moved. Idle time alone does not ask the server to clear earlier reasoning.

A crewmate keeps the same kind of record on its own transcript: one resumed
after its run ended (via `ResumeCrewmate` or the Crew view) sends
the tool list it first sent, regardless of later changes to the parent session's tools.

On a hosted model, a conversation starts with `Crewmate`, `Bash`, `Glob`, `Grep`, `Read`,
`Edit`, `Write`, `Skill`, `Eval`, `ScheduleWakeup` and `ToolSearch` loaded with their full
descriptions when their settings and dependencies admit them, alongside `ChangeSet`,
`AstSearch`, `LspRead` (whenever a language server is reachable) and `Test` (whenever a
test runner profile or Python test signal is detected in the project). Routes that support
deferral announce the remaining tools (among them `JevEval`, `Debug`, `Git`, `AstEdit`, `LspRename`,
`LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`, `LspRequest`, `Monitor`,
`Checkpoint`, `Rewind`, and `Test` when no test runner is detected) with a one-line
summary and load their schemas on demand through `ToolSearch`. A local model
loads the core daily tools in full and announces the remaining tools the
same way. A deferrable tool discovered after the first request (such as a debug adapter)
is announced and loadable at once; a tool that loads in full and is
discovered after the first request joins at the next compaction or `/clear`,
without changing the current conversation's prefix. Nothing is trimmed,
dropped or deferred to fit a size limit.

The tool list a conversation starts with is kept for its life, so nothing
already sent moves under the model. A restart or resume onto a new build
replays the recorded tool roster (unless a bound tool is no longer in the
build and the record carries no definition for it), keeping the request prefix
and signed thinking intact. When an MCP server's tools change through
`notifications/tools/list_changed` or `/mcp` reconnect, the bound prefix does
not move: an unreferenced deferred tool takes the live schema, while a bound
or referenced tool gets a `tool_schema_delta` attachment with its updated
input schema. A tool that joins later (a connector
that connects after the first request, a tool a setting turns on) rides
deferred where the list can carry it that way; otherwise it is held out
until the next compaction or `/clear`, and the model is told on its next
turn which tools are held and that they cannot be called yet. When a
conversation compacts, the tools the session loaded in full (`ToolSearch`)
carry across the compaction as loaded in full on every provider. The parts of
the system prompt that name tools are kept the same way: a session brought
back in a new process re-sends them as they were first sent, even when its
tool list has gained or lost a tool since; the next compaction or `/clear`
writes them again from the tools it has then.

## Winding a chat back

`/rewind` (alias `/checkpoint`) lists the turns of the focused chat and
restores to one of them (the files, the conversation, or both). The session's
own runner does the work: every turn it captures a checkpoint of each file its
tools edit (Settings › File checkpointing is the switch; the row beneath it,
"Checkpoints in this session", shows what this session's runner actually does),
and a restore is answered as a receipt. Restoring the code
puts every tracked file back to its saved bytes at that turn, all or nothing:
a file you edited by hand since the session last touched it is refused by
name and nothing is written until you reconcile it; a saved copy that is gone
from the checkpoint store, or whose size no longer matches what was recorded
for it, refuses the restore the same way. Restoring the
conversation winds the chat back to before that turn: the later messages
leave the model's view and the chat, the turn's words return to the composer,
and the session keeps its identity (the transcript keeps every row under `ctrl+o`,
the same session resumes, and nothing is deleted). A point that has no
saved files allows conversation restore only; a point before the last
`/compact` is refused by name; a turn still running is interrupted first.
"Create a branch session from here" and "Rerun from here on a new branch"
leave this chat untouched.

Choose a file's **Restore** row to restore only that file; other files and the
conversation stay unchanged. The same hand-edit and missing-backup checks apply
to the selected file. Before restoring files, Mercury saves their current bytes.
**Undo the rewind** restores those bytes without changing the conversation;
it is available until the next prompt and still refuses conflicting hand edits.

Housekeeping limits `<config-home>/file-history` to 500 MB, removing the oldest
session backups first, alongside the configured age retention. `/health` shows
the current size and the limit in **State cleanup**. Pruned backups cannot be restored.

## `mercury --chat`

Passing `--chat` opens only the home screen and the chat, without the Session
Concourse board on the navigation strip or the Session Concourse row on the
home screen (New Session is the entry point). A `--chat` launch
opens on the home screen like a bare launch, and pressing `Enter` on New Session starts the chat.
From the chat, `Shift+←` returns to the home screen directly and `Shift+→` moves nothing;
the home screen's key-map row reads `"⇧→ chat"` while a session is focused and `"⇧→
no chat open"` otherwise, alongside the same `m to select model-default` shortcut.
`/concourse` still opens the live view of your sessions from the chat.

## `mercury --concourse-off`

`--concourse-off` turns the Session Concourse off for this and every later
launch through the saved `concourseEnabled` setting in the global config (absent
reads as on), written only by this flag and the `/config` row "Session
concourse", and never overwritten by visiting `/concourse`.
`--concourse-on` or that `/config` row turns it back on; with both flags on one
command line, the later one wins.

With it off, the navigation strip has only the home screen and
the chat, with no concourse stop (`Shift+→` walks only screens that exist). The
live view of your sessions remains available through the
home screen's concourse row (`"live view only — concourse off"`) or `/concourse`,
showing the rows and their tiles with `Enter` to open one and no coordinator
pane, composer or new-session tab. The home screen keeps its
repositories picker either way: selecting a repository on the Sessions · Projects
screen still opens that repo's newest chat.

Both flags also accept single-dash spellings (`-chat`,
`-concourse-off` and `-concourse-on`).

## Commands that never reach the model

A user-private command runs locally in the terminal UI, never
enters the session's conversation, never starts a turn and never travels on
a later turn. See [TRUST.md](TRUST.md).

## Before the context fills

Mercury sends every tool result whole: nothing is pruned before a summary.
When the estimated context reaches the automatic-fold threshold, the fold
runs first with the complete history in front of the summariser, keeps the
last ten complete rounds when they fit under the window, keeps your own
messages word for word, moves the run's state to project memory with a
pointer it has read back (when memory is on and the run has state to
move), and writes an exact receipt on the boundary row:
the rounds kept, the operator messages kept whole, what moved to memory,
what was pruned (nothing, for a fold) and the context before and after.
A cancelled or failed fold keeps the original context whole and says so.

Only when a fold cannot bring the context under its threshold, or the
provider refuses the request despite the estimate, does the emergency prune
run. It clears older file results that a later successful Read, Edit or
Write of the same path superseded; the latest result for a path, unique
results, failed or unfinished operations, skill and brief material, the
ten most recent eligible results and the newest 40,000 tokens of tool
output stay, and a result under 50 tokens is never replaced. A cleared
result whose full output was saved to a file keeps the line that names the
file. The chat reports the number of result bodies pruned and Mercury's
estimate of the tokens saved, net of the placeholders, and says that no
summary was written and nothing moved to memory by that prune. The
replacements persist across later requests and resume. An idle gap on its
own no longer clears results. `MERCURY_COMPACT=0` disables folding and the
prune alike.

## When the context overflows

A request can outgrow the model's window (from a large paste, a long run of
tool results, or a switch to a model with a smaller window). The conversation
folds automatically 20,000 tokens before the usable edge by default, with
proportional room preserved on small local windows. The gauge, warning line
and ContextLeft tool count down to that same point. When a request outgrows
that headroom anyway, the turn recovers instead of ending:

- The conversation is folded first (producing the same summary `/compact` makes
  on the same session, with every tool result still in front of the
  summariser), your message is carried across the fold word for word, and the
  request is retried once. The chat reports `"context overflowed … — folding
  the conversation and retrying"`, and the fold's row reads `"Context
  overflowed — folded and retried"`. Both carry the token counts in brackets:
  the provider's numbers when reported, or Mercury's own count of the
  conversation and the window it measured against.
- Only when the fold cannot bring the context under its threshold, or the
  provider refuses the request despite the estimate, are superseded tool
  results older than the recent ten pruned, when that covers the gap, and the
  request retried. The chat reports `"context overflowed … — pruned N
  superseded tool-result bodies (about N tokens by Mercury's estimate, net of
  placeholders; no summary written, nothing moved to memory) and retrying"`.
- The fold's summary is written by a model whose window holds the
  conversation. After a switch to a model with a smaller window, that is the
  model the conversation was built on (never the model that just refused
  the request); without such a model, the summary is written on the current
  model and narrowed until it fits.
- If it still does not fit, one plain line states what was tried and what to
  do: shorten or split an oversized message, use `/compact` to fold by hand,
  `/clear` to start fresh, or `/model` to pick a larger window. A headless run
  reports the same reason with headless remedies.

Each step runs at most once per stretch of work; a completed tool round
starts a fresh one. The coordinator's chat recovers the same way. The
provider's refusal never becomes the reply. Turning Auto-compact off in
`/config`, or setting `MERCURY_AUTO_COMPACT=0`, stops early folds while keeping
emergency recovery active so an overflow still folds and retries. `MERCURY_COMPACT=0` disables compaction
altogether. The failure and rapid-refill breakers still stop repeated failing
folds. `/health` names the setting or environment switch that turned folding
off, and whether emergency folding remains available.

## A line sent while the model works

A plain line sent while a turn runs goes to the session at once and waits in
the runner's queue; its row paints under the composer with the badge
`queued` and no timer. The runner reads that queue at every tool boundary of
the running turn: once a tool round's results are in, and before the next
request goes out, the line reaches the model with those results, introduced
with `"The operator sent a new message while you were
working:"` and followed by how to handle it: a
correction applies before the affected work continues, a question gets a brief
answer and the task resumes, a stop or replacement is followed, a separate
task is kept for afterwards, the original objective stands unless you
change it, and the turn may not end without accounting for the
message. Several lines sent before one boundary arrive together, each as its
own message, in the order sent. The row then lands in the transcript where
the delivery happened, between the tool rows, and carries the timestamp when the line
was sent. A headless run (`mercury run --input rows
--format rows`) reads that timestamp from the prompt row's `sent_at` and stamps
the arrival time when it is absent or invalid. A host sends the same prompt row
through the runner's `queue/add` method. A line sent
after the turn's last tool round waits for the turn's end, as does a slash
command sent at any point of the turn, and so does a line sent after a
`/model`, `/effort`, `/crewmates on|off` or `/workflows on|off` change made while the turn runs
(the setting change applies first, and the line runs on it); lines that arrive between
turns run as one turn, each as its own row under its own id, in the
order sent; pressing `Esc` interrupts the turn and anything still queued runs as the
next turn.
The line always reaches the session's main model. A crewmate the model is
running (a `Crewmate` tool call) has tool boundaries of its own; those read only
the notes addressed to that crewmate, so a line you send in the main chat
while a crewmate works waits for the main session's next boundary (including the `Crewmate`
tool's return) and lands in the main session's transcript.

## A line sent while the session compacts

A line sent while the session's runner is folding (by hand with `/compact`,
or automatically) waits in the runner's queue and is drawn as a queued row
with the badge `held`; the hint row says `"held until the compaction lands — it
delivers once, on its own (↑ takes it back)"`. When the fold finishes, the runner
takes the held lines as its next turn, in the order they were sent, ahead of
anything newer, each once; a line sent after the fold runs behind
them. Pressing `↑` on an empty composer while a line is held takes it back into the
composer, just like any queued line.

A queued or held row stays only while the runner holds that line. A runner
that stopped with the line still queued restores it when resumed: the
line is queued again from the session's record, under its own id,
and runs as the next turn. When the runner reports that it no longer holds a
line that is also absent from the record, the row is removed and the
hint row shows `"the runner restarted ("…" not taken); type
it again"`; pressing `↑` on such a row shows `"the session did not take "…"; type
it again"` and removes it. A row for a line no runner holds is
never left on screen.

The hint row under the composer displays every such receipt or notice
for several seconds. While one is shown, the default
hints (`? for shortcuts · ctrl+x p for commands + files`) step aside and
return when it clears, so a receipt (such as the model id resolved by
`/defaultprovider`) stays readable at 80 columns. On a
narrow window the session counts step aside the same way, the notice is truncated
to fit with an ellipsis, and the back hint (`⇧← concourse`) stays at the
row's right end; `context.wayBack: false` in `settings.json` gives the notice
the full row instead. The composer never shifts position for a notice.

## A notice an agent has not read

Every notice delivered to an agent of a session (a crewmate's completion,
a workflow's or a shell's completion, a monitor's tick, a message queued for a
crewmate, or a schedule's wake) is recorded in the session's unread-notice
ledger from the moment it is delivered until a turn of that agent reads it.
The runner's `session/facts` answer carries the ledger (`notices`: each
entry names its agent, its kind, the one-line summary, the arrival timestamp
and its status), and every crewmate's work row carries the count
of its unread notices;
the Crew view (`/crewmates`) shows that count on the crewmate's row (`"2
unread"`), and nothing when the count is zero.

A monitor's ticks that land while the session's provider usage window is reached
are held by the watch and delivered together as one notice
on the first turn after the window reopens; ticks that arrive within 200 ms
of each other fold into one notice. A monitor started
without `persistent` ends at its deadline with one notice explaining how to
start it again. A headless run whose input closes ends every monitor and every
background shell when the session exits, whether `persistent` is set or not; a
process that must stay up after such a run (a server something checks once the
run has ended) is a Service started with lifecycle `project`, which outlives
the session that started it.

Every other notice bound for the session's main thread waits the same way
while the usage window is reached (including a crewmate's or a shell's completion), and
the first turn after the window reopens receives them together; a self-paced
wake due meanwhile fires after the window reopens. This applies across
Anthropic, OpenAI, Gemini, OpenRouter and Hugging Face
usage windows, waiting until the reset time reported by the provider.
Your own messages are never held. A session you parked is never woken by background notices:
its pending notices wait until you resume the session.

A monitor does not outlive the session's runner: on the first turn after a
resume, one notice per watch that was still active names it and shows how to
start it again.

A runner the daemon resumed does not wait for you to type before reading
what its restart queued. A held stop, crash or completion notice (an agent's
completion or failure, a stop, a watch that ended with the runner, or the row
summarizing what the restart carried) and any line of yours re-queued
from the record wake the idle main agent immediately: the runner takes them as
its first turn, in the order they were queued, with the settle window
folding a burst into one turn. A session hosted by an external program that
sends its own start request waits for that host as usual.

An agent idle with unread notices past the deadline is nudged. The session's
main thread is woken through its queue with a message
naming how many notices waited, for how long, and each notice; the notices
themselves arrive immediately before it. A named agent parked between
turns is woken with the notices' text. Each notice is nudged once. A
busy agent is never nudged because its next tool round reads them. A nudge that
finds the agent gone (because its run ended, it was stopped, or no such agent exists in the
session) marks the notice `retired` with the reason and removes it from the queue.
The deadline is
`MERCURY_NOTICE_DEADLINE_MS`, a whole number of milliseconds at or above
1000 (three minutes when unset).

A task notification shown in the chat (whether read mid-turn or between
turns) is drawn once in its transcript position and never
redrawn under later messages. A notification or user message that arrives while a
reply is streaming appears below that reply and stays there when the reply finishes,
while one that arrived before the reply started stays above it. A reply's settled row replaces its streaming text in place.
Every task notification and monitor line renders
as one collapsible notice row: a dim badge naming the kind and task (or the monitor watch's name)
and the line count, folded by default; expanding the row shows its lines and collapsing hides
them again, while the full transcript view (`ctrl+o`) shows them in full.
Until the runner delivers a notification
to the model, it waits with the lines queued for the next turn; once delivered,
it takes its place in the transcript above any message you type afterwards.
Text written by the model before calling a tool appears as its own row as soon as
the tool call begins, and the settled row replaces it in place; a
question asked mid-turn stays on screen. A crewmate completion notice uses the
crewmate's finish timestamp (`completedAt`) as its row clock and appends
`· delivered HH:MM:SS` when delivered to the parent turn a minute or more after
completion; other notice kinds show their delivery clock first and
`· arrived HH:MM:SS` when delayed.

Completions that arrive while the session is idle between turns fold into one
turn. The runner holds the first completion for the one-second poll window and delivers all
completions that arrived within that second in a single message (one block each), so a
burst of background commands finishing together runs one turn instead of one turn per
command. A completion that arrives during a running turn reaches the model at that
turn's next tool boundary alongside the tool result; one not yet read when the turn
ends is delivered as soon as the turn finishes, together with any other queued completions.
When both a message you typed and a completion are waiting at the end of a
turn, your message starts the next turn (and consecutive messages you typed share
that turn even if a completion arrived between them); the completion is delivered
at that turn's first tool boundary or at its end, so a completion never waits
more than one turn. The chat renders a batched completion message as one counted
row.

Messages between agents use the same delivery path. A background
crewmate addresses the agent that launched it as `main`; the main agent addresses
a crewmate by the id in its launch receipt or by its name. The message
reaches the recipient at its next tool boundary during a running turn, or at
the end of its turn; a recipient idle between turns starts a turn for it, and a
crewmate whose run has finished is resumed with it. It arrives as a task
notification with status `message`, naming the sender. In its output rows the
runner emits a `task` row with `state: "progress"` and no `status`, because
a message does not end a task.

## Where the pieces live

- The coordinator, crewmates and live communication: [CREW.md](CREW.md).
- What a session loads (its kit, the menu, presets, and in-session toggles):
  [KIT.md](KIT.md).
- Schedules that wake a session or start a new scheduled session:
  [SATURN.md](SATURN.md).
- Workspace trust and user-private commands: [TRUST.md](TRUST.md).
- The idle-retirement, newborn-grace, unread-notice deadline and prefix-record
  retention switches live in `src/substrate/flagRegistry.ts`.
- Machine load and memory headroom travel in the session facts under `box`:
  the load per core and available memory (from the process's most recent sample
  and timestamp), plus the box lock's slots, holders, and waiting queue (from
  `MERCURY_BOX_LOCK_DIR` or the session's last `with-box-lock.sh` call). An
  agent can read the live state at `mercury://health/box` through the `Inspect`
  tool, and any Bash call that waited on the lock includes the wait duration,
  slot holders, and load in its result. This is visibility only: nothing here
  schedules or throttles.
- The `session/facts` response also carries the provider usage-window
  status reported on recent replies (`usage.anthropic_window`: state,
  observation timestamp, account slot, reset time, and window name) and the
  cached OpenAI model list (`openai_catalogue`). The screen folds available
  facts into its own record and catalogue, so the offer card and the rail's
  context figure follow the session's requests.
- A session's scratchpad (`<temp root>/mercury-<uid>/<project>/<session id>/scratchpad`,
  where `MERCURY_TMPDIR` sets `<temp root>`) is the directory where the model writes
  temporary helper scripts, intermediate results, and captures. Because it sits
  outside the project tree, `git status` is unaffected, the turn receipt counts
  writes there as scratchpad edits (separate from project file edits), and the
  directory is cleaned up when the session ends.
