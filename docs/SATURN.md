# Saturn — session schedules

Saturn is Mercury's scheduler. A schedule is a **session fact**: it rides the
durable session record, is fired by the background daemon — the thing that is
always alive — and every fire decision lands as a receipt row on the session
it belongs to. There is no project task file and no schedule store apart from
the sessions themselves. A second kind, the box schedule, belongs to the
machine rather than to any session: it births a fresh session on the clock,
and its record is one file in the daemon's home.

Two kinds of schedule exist, and the board shows both:

- **fire** — deliver a prompt to an existing session at a time, once (`at`)
  or on a recurrence (`every`). A fire due while the session is parked wakes
  it by default; `onParked: "queue"` banks the fire for the session's own
  next wake instead.
- **birth** — create a fresh session at a time, every fact of it chosen up
  front. The born session's first receipt reads
  "born by schedule '<id>'".

## The board

`/saturn` opens the board inside the chat, in the chat's own frame; the Boot
face's **Saturn Scheduler** row opens the same board as a face layer, esc
returning to the face. Rows group under the session that owns them,
with box schedules under their own `box (machine)` section. The legend is the verb set: `↑↓ move
· a schedule birth… · x delete · n run-now · p pause/resume · r refresh · esc
back`. A row's trail shows the when-spelling verbatim, the account it will
fire on (an identity, never a token), held fires with their reasons, and the
fired-late / missed receipt tail; the empty board leads with the door —
"press a to schedule a session birth — a fresh session born on the clock."

While a future fire stands, the session's row on the Session Concourse wears
it in the NOW cell — "next fire in 2h · " — beside whatever the session is
doing.

## Scheduling a birth

`a` opens the birth form: a fresh session born on the clock, all of it
customizable. Its rows:

- **When** — the spelling, compiled as below.
- **Model** — the model the session is born on (the full catalogue picker).
- **Workspace** — the project it is born in, picked from your projects (the
  same list the Boot face's rows render), with a custom path road last.
- **Presence** — `headless — unattended`, or `screen-present — Mercury open`:
  a screen-present birth due while Mercury is closed waits for the next boot
  rather than firing blind, then obeys the catch-up window from its due
  instant.
- **Kit preset** — the extensions it is born wearing, from the saved preset
  roster ([KIT.md](KIT.md)).
- **Opening mission** — `audit` and `review` land complete, self-contained
  missions; `custom…` opens a text field; none means born-waiting, blank and
  ready.
- **Contract**, **Title**, **Note** — the session contract pre-answered at
  birth, the born session's name, and a word for the board.

The form's preview is the schedule-time preflight, live as you edit: the
compiler's errors verbatim, the account the birth would run on, and the one
verdict sentence — including the honest "born held" line when the account is
already stranded. `s` schedules it. Birth schedules authored here are box
schedules: they need no session to exist first, and their record is the
daemon-home file itself — there is no wire verb for the box store, by design.

## Saying when

One compiler turns operator phrases into schedule times: one-shots — `6am`, `18:30`,
`tomorrow 07:30`, `in 20m` — and recurrences — `every 5 minutes`, `every
hour at:07`, `every day 09:00`, `weekdays 9am`, `every mon,fri 17:00` — plus
raw 5-field cron passed through verbatim. The spelling you typed is stored
and echoed on every surface exactly as you wrote it; a phrase the compiler
cannot read refuses typed, naming a working form.

## In-session schedules

Inside a session, the model schedules through four tools: `CronCreate` (a
prompt on a recurrence or a one-shot, `onParked` included), `CronList`,
`CronDelete`, and `ScheduleWakeup` (a single self-paced wake, the tool the
session uses to put itself down and come back). The edits ride the session's
own facts road to the daemon's one schedule writer. The `/loop`
skill builds on exactly this: it schedules a short sentinel that expands at
fire time to the loop's instructions — `loop.md` or the autonomous default —
whole on the first delivery and a short reminder afterwards.

## Accounts, holds, and releases

A schedule captures its account at write time — provider family and
credential door (an OAuth sign-in, an API key, or `keyless` for the
account-less local family, whose presence is a discovered server), the
signed-in identity as a label, never a token or key. One verdict function
judges the account at schedule time and again at every fire: ready, expiring before the fire (the
schedule-time warning; an expiry with a refresh token is ready), expired,
signed-out (a keyless account's twin is `unreachable` — the backing server
is gone; it has no sign-in to lose), or rate-limited.

A fire whose account is not ready is **held**, typed and receipted, never
silently dropped and never run on another family: "held: sign-in expired —
/logins releases N held fires", "held: signed out — …", "held: no local
server answering — start it (or set MERCURY_LOCAL_BASE_URL) …", "held:
rate-limited — the window's end releases N held fires". Signing back in
(or the local server returning) releases the held
fires whole, in order, each receipted as fired late with its origin. A fire
also never jumps accounts silently: the same family under a different
identity holds as `account-mismatch` — "/logins or run-now releases on the
current one" — and releases when the identity matches again or a fresh
sign-in re-arms the schedule on the current one. When the session's model
itself moved family after scheduling and the current account is ready, the
fire follows the session and the receipt names the move.

Resuming a session whose schedules are stranded paints one warning row beside
the away recap — the worst verdict across its unpaused schedules, with
`/logins` named; display only, never in the model's conversation.

## Late fires

A fire that comes due while the daemon is down — the machine asleep, Mercury
closed — runs when it can, honestly: inside the catch-up window (6 hours by
default) it fires late and the receipt carries how late; beyond the window it
rows missed-expired — a one-shot is spent, a recurrence re-arms. Nothing is
silently dropped. `MERCURY_DAEMON_CATCHUP=0` turns late fires off entirely
(every late fire rows missed-expired) and `MERCURY_DAEMON_CATCHUP_MINUTES`
resizes the window.

## Gates

`MERCURY_SATURN_DISABLE` is the kill switch: truthy ends every tick before
any effect — nothing fires, holds, or replays; the schedule store is
untouched, editing still works, and the scheduling tools leave the catalog.
These rows live in the in-code registry (`src/substrate/flagRegistry.ts`;
rendered on demand to an untracked path).

