# Sessions

A session owns its conversation, model, permission mode, workspace and
running work, hosted by the background daemon across the Boot face, chat and
Session Concourse.

## A fresh boot has no chat

A bare interactive `mercury` opens the Boot face (`New Session` · `Continue
Last Session` · `Boot Menu` · `MCPs & Skills` · `Agents` · `Health Check` ·
`Saturn Scheduler` · `Logins` · `Session Concourse` · `Sessions · Projects`)
with no chat created yet. Menu entries open over the Boot face and `esc`
returns to the selected row; `Session Concourse` opens the project's session
board one screen to the right. A chat exists only once you start or enter one
(`New Session`, `Continue Last Session`, a `Sessions · Projects` pick, or a
concourse row), unless the launch passed `--continue`, `--resume`, a prompt
argument, or `MERCURY_CONCOURSE=always|auto`. On Windows, each frame reads the
console dimensions directly so the layout tracks window resizes even when no
resize event arrives.

## Moving between screens

`shift+←` and `shift+→` move only between screens that currently exist. A fresh
boot has the Boot face and the Session Concourse. Focusing a session adds the
chat screen to the right of the concourse; closing the last chat removes it.
The key-hint row updates immediately (`⇧→ concourse` on a fresh boot, `⇧→ chat`
when a session is focused, `⇧→ no chat open` when nothing lies to the right).
On the board, `esc` returns to the focused chat when one exists or to the Boot
face otherwise.

## Starting a session and choosing models

Pressing `↵` on **New Session** (or `n` / `+ new session · n` on the board)
creates a blank session for the current folder using the model shown on the
chip, attaches it to the pre-booted warm runner behind the menu, and focuses
its chat. Any `/mission` typed while the runner attaches moves into the
session with its card and Stop hook. The session loads the repository's MCPs &
Skills selection or the preset chosen on the Boot face ([KIT.md](KIT.md)). If
all daemon seats are full, admission waits up to 20 seconds for a seat to free
before returning with the active seat count and `/seats N` remedy.

On the board's top door row (or on the Boot face under `--chat`), pressing `m`
(`m to select model-default`, disabled when `engine.sessionDefaults: false`)
opens `/model` to set your default model and effort. On an active session row,
`m` opens that session's own model and effort picker. Launch flags `--title
<name>` (for the first session opened), `--effort` and `--mode` apply to
sessions started from the screen.

Model and effort selection follow one precedence order:

1. Explicit `--model` or `--effort` launch flags win for both new and resumed
   sessions (the resume card notes when a launch flag overrode the session's
   stored choice).
2. Otherwise, a new session uses your saved default from `/model` or `/effort`
   (`/model default` clears the saved model), or the most recently connected
   provider's newest usable model when nothing is saved. A saved family word
follows its family's newest row (`sonnet` runs Sonnet 5.5 as `opus` runs Opus
5.5) while a saved full id such as `claude-sonnet-5` stays on that generation.
3. If the saved family has no sign-in or its catalogue refused the model, the
   chat starts on the computed default and prints one notice naming `/logins
   <family>` and `/model` while keeping your saved setting intact for later.

`/model <words>` echoes the words you typed on the first line (with the
resolved model id) and the switch receipt on the second line (`Model now:
<display> · saved as your default for new sessions …`). When
`memory.tellEngineSwitch` is `true` in settings, the meta line sent to the
model includes the switch timestamp with its UTC offset and instructs the model
to include the time zone when repeating the switch time. Selecting an effort
level in `/effort` or via `ctrl+e` inside `/model` saves it to `<config
home>/settings.json` (`Effort set to <level> · saved as your default for future
sessions`); if writing `settings.json` fails, both `/model` and the effort
picker name the file and the OS reason (`not saved as your default:
~/.mercury/settings.json …`).

When `/model`, `/effort`, `/crewmates on|off` or `/workflows on|off` runs
during an active turn, the change applies as soon as that turn ends, before any
prompt queued after the command.

The background daemon hosts session runners, warm runners and crewmates as
`mercury runner` child processes. Closing one terminal window transfers daemon
ownership to any remaining open window; when the last window closes, the daemon
parks all sessions so the next launch can restore them. A window opened while a
departing daemon is shutting down waits the
beat it takes to leave, then starts its own. Each `↵` on New Session carries an
idempotency key (`birthKey`), so if a reply is lost and retried, the daemon
answers the retry with the session it already holds instead of spawning a
duplicate. Empty background sessions retire after
`MERCURY_SESSION_IDLE_RETIRE_MINUTES` (default `10`; `0` disables), while a
newly opened session that has not yet received a first message is exempt (or
governed by `MERCURY_SESSION_NEWBORN_GRACE_MINUTES`).

## Session titles

A session's title progresses through three stages: `new session · <project> ·
ready` at creation, the first line of your first prompt, and a short title
generated once after the second reply (if you have not set a custom title). Use
`/title <words>` or `/rename <words>` in chat (or `r` on a board row) to set a
custom title, or bare `/title` to regenerate one. The title appears in the
terminal title bar, `/concourse` and `/sessions`.

## The focused chat, thinking rows, pastes and images

One session per terminal is focused at a time. The focused session can launch
crewmates and workflows under its permission mode; background sessions wait for
focus, a workflows-allowed grant, or the **Crewmates while backgrounded**
setting ([CREW.md](CREW.md)). `/runs` and `/workflows` show the focused
session's work; opening a shell row shows its command, working directory,
elapsed time, exit code and output tail. In `/help`, pressing `PageDown` or
`PageUp` from the tab header enters the command list and pages immediately.

While a turn runs, the status row and the card beside the critter (`/critter`)
show `✻ thinking…`. When a model returns its reasoning text, a folded `✻
thinking…` block appears above the reply and expands on click or in the
transcript view (`ctrl+o`). When a provider returns a signed thinking block
without text (private thinking), the chat draws no thinking row by default;
clicking the turn's answer or work row (or opening `ctrl+o`) reveals `✻
thinking…` with `the provider returned no thinking text for this model` once
for that turn.

While a permission or question card is waiting over the composer, words you
type remain visible beneath the card, and a draft restored to the composer
after a card or interrupt is labelled and armed so a second `Enter` sends it
with focus on the rows.

Multi-line pastes become `[Pasted text #N +L lines]` chips backed by content-addressed
files in the config home, surviving crashes and restarts. Images attach via
`ctrl+v` (macOS/Linux), `alt+v` (Windows), drag-and-drop, or pasting a file
path, appearing as `[Image #N]` chips stored in the session's image store and
automatically resized to each provider's limits (10 MB base64 and 8000 px on
Anthropic, or 2000 px when a request exceeds 20 images; 30,000 32-px patches on
OpenAI). If an image still cannot be sized or is refused by a provider, it is
replaced by a one-line note on the next send without dropping the conversation.

The status row above the composer shows `ready · <model> · <effort>` when idle,
or `<model> · <effort>` plus active crew clocks (`crewmate thought for 28m`),
request waits (`waiting for the first byte …`), silence warnings (after 5
minutes on keep-alive streams or 7.5 minutes on quiet streams), and the folder
and branch (`mercury ⌥ main`). `Esc` interrupts the main agent's turn and
in-flight tool call while leaving background crewmates running. While a foreground
Bash command runs, `⇧b` moves it to the background (`view.backgroundKey: false`
disables the shortcut).

## The Session Concourse

Open the Session Concourse with `/concourse`, the Boot face row, or `shift+→`.
It lists the current project's live, held and finished sessions above `PARKED`
(up to 10 recent stopped chats from the last week), plus compact `OTHER
PROJECTS` rows (`⌃g` opens the repository picker). The focused session stays
visible even when you switch the board to another repository.

Pressing `↵` on a live or parked row enters that session. To stop, archive or
remove a row on the board, press `ctrl+x` twice (`ctrl+x ctrl+x stops the selected`
live session, a second `ctrl+x ctrl+x` archives a stopped session to `PARKED`,
and a third removes the board row while keeping its transcript on disk; an
unmessaged stopped chat is removed on the second chord; `typing is never a control`,
so a bare `x` types into the composer). Older or archived chats fold into `N older chats · ↵ to
browse`, where `↵` `unfolds that very list in place on the board`, `esc` `folds it back to the line`,
`↵` on an item reopens it through `the same door a parked row rides`, and long
lists end with `+N more — /sessions lists everything` (`/sessions` in chat
searches project history, and `a` widens it to all projects).
Nothing deletes a transcript automatically: `records.retentionDays` (default
`30`) ages only recordings and tool-result spill files, while `0` turns transcript writing off for
new chats; the transcripts already on disk stay.

## The project folder, worktrees, closing and resuming

Starting a first chat in a folder creates `.mercury/` there and a project
record in the config home. Shared project config (`.mercury/settings.json`,
`.mercury/wards.json`, `.mercury/agents/`, Apollo specs, workflows) lives in
`.mercury/`, while session transcripts, memory, lineage and health certificates
live under the config home (any legacy local store found in `.mercury/` is
read once and moved on its first touch). The left rail's `FILES` box
(`view.files: false` hides it) browses the project tree (`/` filters, `↵`
inserts `@path`).

Launch with `--worktree [name]` (or `--worktree #<pr>`) or ask for a `worktree`
in chat (`EnterWorktree`) to work in an isolated checkout under
`.mercury/worktrees/`. The worktree links the parent checkout's `node_modules`
and ignored `vendor/<pack>` directories via `.git/info/exclude`; because
`node_modules` is a symlink, an install run inside the worktree installs into the checkout.

`/clear` parks the current chat on the board and opens a fresh session in the
same folder and model (`esc` first if a turn is running). When leaving Mercury
(`/exit` or `ctrl+c`/`ctrl+d`), once per session the exit confirmation card (if
live work is running) or the farewell line prints `Something broke?
https://mercury-cli.ai/report`; inside a session, `/bug --short <what you
tried>` files the same short tester report (OS, what you tried, what broke, no
health dump).

Resuming a chat (`Continue Last Session`, `Sessions · Projects`, `/sessions`,
`-c`/`--continue`, `-r`/`--resume <id|title>`, or `↵` on a parked board row)
paints the transcript immediately and re-attaches or revives the daemon runner
behind it, replaying any queued user lines and delivering or relaunching
background crewmates (`runner restarted after a crash: …`).

## Preserved thinking, tool stability and `/rewind`

Each session writes `<config-home>/sessions/<session id>/prefix-ledger.json`
in the background once a request is on the wire, recording digests of system-prompt
sections, tool schemas and message blocks (`never a word of the conversation`,
tool output or images) so a dropped thinking block after a restart names the
exact prefix part that changed. Orphaned records older than
`MERCURY_PREFIX_RECORD_RETENTION_DAYS` (default `30`) are swept at interactive
boot. To keep prompt prefixes cache-stable, a session's initial tool list is
held fixed for its lifetime: tools discovered later ride deferred via
`ToolSearch` where supported or wait until the next `/compact` or `/clear`.

`/rewind` (alias `/checkpoint`) restores tracked files, the conversation, or
both to an earlier turn (when `File checkpointing` is on; files modified by
hand since the session's last edit are refused until reconciled, and rewound
messages remain inspectable in `ctrl+o`).

## `--chat` and `--concourse-off`

`--chat` (or `-chat`) launches with only the Boot face and the chat on the
screen strip, omitting the Session Concourse stop. `--concourse-off` (or
`-concourse-off`) saves that two-screen layout (`concourseEnabled: false`) for
future boots until `--concourse-on` (`-concourse-on`) or `/config`'s **Session
concourse** row turns it back on. Visiting `/concourse` mid-session opens a
read-only live view of sessions and never overwrites your saved
`concourseEnabled` default.

## Context pruning and overflow recovery

At `MERCURY_PRUNE_PCT` (default `40`% of the model's context window; `0`
disables), Mercury prunes older file tool results superseded by a later `Read`,
`Edit` or `Write` of the same path whenever pruning reduces estimated usage to
two-thirds of that threshold (~26.7%), keeping the five most recent results.

Auto-compaction folds the conversation 20,000 tokens before the usable window
edge (`MERCURY_AUTO_COMPACT=0` disables early auto-compaction;
`MERCURY_COMPACT=0` disables all compaction). If a request still overflows the
window, Mercury first prunes superseded tool results if that covers the gap, or
folds the conversation with `/compact` (using the prior model when a switch to
a smaller window caused the overflow) and retries once.

## Queued lines and unread agent notices

Lines sent while a turn runs wait in the runner's queue with the `queued` label
(or `held` while `/compact` runs; `↑` on an empty composer pulls a queued line
back for editing) and are delivered at the turn's next tool boundary with their
original send timestamp.

Every notice delivered to an agent (crewmate, workflow or background shell
completions, monitor ticks, `SendMessage` notes, scheduled wakes) is tracked in
the unread-notice ledger (`session/facts` `notices`, shown as `N unread` in
`/crewmates`). While a provider usage window is closed, notices wait and batch
into the first turn after the window reopens. An idle agent with unread notices
past `MERCURY_NOTICE_DEADLINE_MS` (default `180000` ms / 3 minutes, minimum
`1000`) is nudged automatically.

In the chat, task notifications and monitor lines render as folded notice rows.
A crewmate completion notice uses the crewmate's finish timestamp
(`completedAt`) as its row clock and appends `· delivered HH:MM:SS` when
delivered to the parent turn a minute or more after completion; other notice
kinds show their delivery position clock first and `· arrived HH:MM:SS` when
delayed.

Temporary files belong in the session scratchpad
(`<temp root>/mercury-<uid>/<project>/<session id>/scratchpad`, overridden by
`MERCURY_TMPDIR`), which lies outside the repository and is swept when the
session ends.
