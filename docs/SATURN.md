# Saturn: session schedules

<!-- answers: Saturn is Mercury's scheduler. Schedule a prompt to an existing session or start a new session on a clock from the `/saturn` board; inside a session the model schedules with `CronCreate` and the `/loop` skill. -->

Saturn is Mercury's scheduler. A schedule is a **session fact**: it rides the
durable session record, is fired by the background daemon, and every fire
decision lands as a receipt row on the session it belongs to. There is no
project task file and no schedule store apart from the sessions themselves. A
second kind, the box schedule, belongs to the machine: it starts a new
scheduled session on the clock, and its record is one file in the daemon's
home.

Saturn supports two schedule types, and the board shows both:

- **fire**: send a prompt to an existing session at a set time, once (`at`)
  or on a recurrence (`every`). A fire due while the session is parked wakes
  it by default; `onParked: "queue"` banks the fire for the session's own
  next wake instead.
- **new scheduled session** (`birth` in the schedule record): start a new
  session at a set time with a chosen model, project folder, and prompt. The
  new session's first receipt reads `"born by schedule '<id>'"`.

## The board

`/saturn` opens the board inside the chat, in the chat's own frame; the home
screen's **Saturn Scheduler** row opens the same board in place, with `Esc`
returning to the home screen. Rows group under the session that owns them,
with box schedules under their own `box (machine)` section. The legend lists
the keys: `↑↓ move · a schedule birth… · x delete · n run-now · p
pause/resume · r refresh · esc back`. A row's trail shows the time expression
verbatim, the account it will fire on (an identity, never a token), held fires
with their reasons, and the fired-late or missed receipt tail. Press `a` in
`/saturn` to schedule a new session.

While a future fire stands, the session's row on the Session Concourse shows
it in the NOW cell (`next fire in 2h · `) beside whatever the session is
doing. The side rail's SATURN row and the home screen's Saturn Scheduler row
show what stands across every session: `2 scheduled · in 4m` while a real fire
is ahead, or `1 scheduled · 1 held` when a fire is banked and nothing is ahead
(a held fire is never shown as due, and `due now` means a fire whose time has
arrived and which the next tick runs).

## Scheduling a new session

Pressing `a` opens the new-session schedule form. Its rows:

- **When**: the schedule time, compiled as below.
- **Model**: the model the new session starts on (the full catalogue picker).
- **Workspace**: the project folder it starts in, picked from your projects
  (the same list the home screen's rows render), with a custom path option last.
- **Presence**: `headless — unattended` or `screen-present — Mercury open`. A
  screen-present schedule due while Mercury is closed waits for the next launch
  instead of firing unattended, then obeys the catch-up window from its due
  instant.
- **Kit preset**: the MCPs & Skills preset the new session loads, from the
  saved preset roster ([KIT.md](KIT.md)).
- **Opening mission**: `audit` and `review` run complete, self-contained
  missions; `custom…` opens a text field; `none` starts the session idle and
  ready for input.
- **Contract**, **Title**, **Note**: the session contract pre-answered for the
  session, the session's title, and a note for the board.

The form's preview runs the schedule-time preflight live as you edit: the
compiler's errors verbatim, the account the session would run on, and the
verdict sentence (including the `"born held"` notice when the account is
already unavailable). Press `s` to save the schedule. New-session schedules
created here are box schedules: they need no existing session, and their record
is the daemon-home file itself.

## Saying when

One compiler turns time phrases into schedule times: one-shots (`6am`, `18:30`,
`tomorrow 07:30`, `in 20m`) and recurrences (`every 5 minutes`, `every
hour at:07`, `every day 09:00`, `weekdays 9am`, `every mon,fri 17:00`), plus
raw 5-field cron passed through verbatim. The spelling you typed is stored
and echoed on every surface as you wrote it; a phrase the compiler
cannot read is refused with a working example.

## In-session schedules

Inside a session, the model schedules through four tools: `CronCreate` (a
prompt on a recurrence or a one-shot; it answers with the schedule's id and
next fire time, or with the daemon's refusal; `onParked` included, and an optional
`title` of one line, scanned for secrets like the prompt, that the
chat row and the list show in place of the id), `CronList`,
`CronDelete`, and `ScheduleWakeup` (a single self-paced wake, the tool the
session uses to pause and resume later). A self-paced wake takes the
wake arm (`onParked: "wake"`): a parked session keeps its scheduled wakes, and a due self-paced wake wakes the session that set it.
A self-paced wake lives for the turn that asked for it: when
you interrupt or stop the session, its pending self-paced wakes (and
any fire already held for them) are dropped with a receipt saying why, and
the board's row is removed with them; parking preserves them, and your own schedules on that session stay.
`CronCreate` asks the daemon's schedule writer directly. An unconfirmed
answer calls for `CronList` before retrying; older daemons take the edit on
the session's facts channel without confirming it. Other edits use that facts
channel. The `/loop`
skill builds on this: it schedules a short sentinel that expands at
fire time to the loop's instructions (`loop.md` or the autonomous default),
in full on the first delivery and as a short reminder afterwards.

## How a fire arrives in the chat

When a schedule triggers inside a chat, it appears as a muted `[Saturn]` row,
never as a line typed by you: the clock, the dim `[Saturn]` badge, and the
schedule's own words on the first line. A self-paced wake names its cadence and
the reason it gave (`self-paced wake · fifteen-minute cadence · reason: …`); a
cron schedule names its title and the spelling it was scheduled with (`morning
brief · every weekday at 09:00`), or its id when it was given no title
(`schedule 3f9a2c1d · every weekday at 09:00`), with the prompt's own words dim
beneath. Mercury's
reply follows as it always does, and the words the model reads are exactly
the prompt the schedule was given. The row keeps its delivery stamp; when the
fire landed a minute or more before the row could be delivered, the first
line also names the fire time, and a fire that waited says since when and why
(a closed usage window, a parked session). The fire's receipt names the fire
time and the reason as well. A resumed session repaints the row the same. A
self-paced wake on a bare streaming run that fires into a closed usage window
waits with the window's own recheck delay, never opening a turn the window
would refuse, and its row says so once when it lands.

## Accounts, holds, and releases

A schedule captures its account at write time: provider family and
credential door (an OAuth sign-in, an API key, or `keyless` for the
account-less local family, whose presence is a discovered server), and the
signed-in identity as a label, never a token or key. One verdict function
judges the account at schedule time and again at every fire: ready, expiring before the fire (the
schedule-time warning; an expiry with a refresh token is ready), expired,
signed-out (a keyless account's equivalent is `unreachable` when the backing server
is gone), or rate-limited (a standing limit window the
ticker observed for that family; a session's own usage-window note stays out of
dispatch admission).

A fire whose account is not ready is **held**, typed and receipted, never
silently dropped and never run on another family: `"held: sign-in expired —
/logins releases N held fires"`, `"held: signed out — …"`, `"held: no local
server answering — start it (or set MERCURY_LOCAL_BASE_URL) …"`, or `"held:
rate-limited — the window's end releases N held fires"`. Signing back in
(or the local server returning) releases the held
fires in order, each receipted as fired late with its origin. A fire
also never jumps accounts silently: the same family under a different
identity holds as `account-mismatch` (`"/logins or run-now releases on the
current one"`) and releases when the identity matches again or a fresh
sign-in re-arms the schedule on the current one. When the session's model
itself moved family after scheduling and the current account is ready, the
fire follows the session and the receipt names the move.

Resuming a session whose schedules are stranded paints one warning row beside
the away recap with the worst verdict across its unpaused schedules and
`/logins` named; it is display-only and never enters the model's conversation.

## Late fires

A fire that comes due while the daemon is down (when the machine is asleep or Mercury
is closed) runs when it can: inside the catch-up window (6 hours by
default) it fires late and the receipt records how late; beyond the window it
is recorded as `missed-expired` (a one-shot is spent, and a recurrence re-arms). Nothing is
silently dropped. `MERCURY_DAEMON_CATCHUP=0` turns late fires off entirely
(every late fire is recorded as `missed-expired`) and `MERCURY_DAEMON_CATCHUP_MINUTES`
resizes the window.

## Gates

`MERCURY_SATURN_DISABLE` is the kill switch: a truthy value ends every tick before
any effect, so nothing fires, holds, or replays; the schedule store is
untouched, editing still works, and the scheduling tools leave the catalog.
These rows live in the in-code registry (`src/substrate/flagRegistry.ts`;
rendered on demand to an untracked path).

