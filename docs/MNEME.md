# Mneme — Mercury's memory

Mneme is Mercury's memory. It is on in every session, one library per
project, and it keeps what a session learns in **topic pages**: plain
markdown files, one page per topic, each fact on its own line with the time
and the source it was captured from. Nothing is hidden in a database; every
page is readable and hand-editable in the project's memory folder under the
Mercury config home.

## What the model gets

Three things are in front of the model without anyone asking:

- **The front page**, loaded at the start of every chat. It is the index of
  the library — each topic on one line with its fact count — built by Mercury,
  never by the model. The index says where things are; it never carries the
  facts themselves.
- **The pinned shelf**, loaded in full: standing rules and preferences, word
  for word. A rule you ask Mercury to remember ("remember: always …") is
  pinned as you said it and marked as asked for by you; Mercury never
  rewords, merges or drops such a rule on its own. You pin and unpin from the
  memory centre.
- **The automatic lookup** on every message: up to five facts that match what
  you just said are attached before the model answers, each pointing at the
  page it lives on.

The front page and the pinned shelf change only when consolidation runs, so
the prompt the model sees stays the same from turn to turn and the provider's
prompt cache holds.

## The four verbs

The model works its memory through four tools:

- **Retain** saves a fact for future sessions. It lands first in a small
  staging buffer and is findable at once; consolidation files it on its topic
  page.
- **Recall** searches the pages (and the staging buffer) and reads a whole
  page or one record by its id.
- **Reflect** answers a question over what was recalled, citing the records
  it used; an answer that cites nothing is refused.
- **Correct** supersedes a wrong fact with the right one, amends its wording,
  or retracts it. The old fact is kept as history under the page, never
  deleted.

## It stays small on its own

- A topic page that grows too long splits into smaller pages; the index shows
  them under the one topic line, so the index grows by a line, not a hundred.
- Consolidation merges duplicates and replaces corrected facts. A checker
  confirms that every fact that went in came out — as a live fact or as
  history — before anything is written.
- A fact nobody has used for ninety days moves to an archive page off the
  index. Recall still finds it, and using it brings it back.
- The index has a fixed size. Mercury keeps it under by splitting and
  archiving and never asks you about it.

## The pinned shelf and its limit

The shelf has a limit on how much text it loads into every session, not on
how many rules it holds. The limit is yours: `memoryPinnedLimit` in settings
(characters; the default is 8000), and the **Pinned memory limit** row in
`/config` moves it. A new rule is never refused. When the shelf is over its
limit every rule still loads, and a chat you are in opens with one line that
says so — how much is pinned, the limit, that all of it is loaded, and where
to trim. The line never appears in a crewmate's chat or in `mercury run`
output. Crewmates and sub-agents receive the front page with the pinned rules.

Two pinned rules on the same matter resolve in favour of the newer one: it
takes the older rule's place and the older text is kept as history. A rule
you asked for is never replaced by one Mercury pinned on its own.

## Existing notes

The first time this version opens a project that has memory notes from
before, Mercury hands each note to Mneme once, on its own, through Retain:
rulings and preferences go to the pinned shelf, project facts and references
to topic pages, long notes as numbered parts so nothing is dropped for size.
A marker in the library records that the intake ran, so it never runs twice,
and a receipt — shown in the memory centre and kept as `handover.json` in the
library — says how many notes it took and where they landed. The old files
stay on disk untouched and are not read again.

## The memory centre

`/memory` is the front door. Type to search facts and rules; open one to see
why it matched and the page it lives on; press `c` to correct it (the old
fact moves to history), `x` to retire it, `p` to pin it word for word or `u`
to unpin it. The overview shows how many facts and topics the library holds,
how full the pinned shelf is, the intake receipt, the state of maintenance
and its recent receipts. `/memory stats` prints the same numbers;
`/memory enqueue` runs maintenance now. `/health` carries a memory row with
the front page's size and the shelf's fill.

## On disk

The library lives at `<config home>/projects/<project>/memory/library/`:

- `topic-<slug>.md` — one topic page; `archive-<slug>.md` — its archive;
- `current.jsonl` — the staging buffer of facts not yet consolidated;
- `front-page.md` and `pinned-status.json` — what the model is given, written
  at consolidation;
- `pins.json` — the pinned rules; `usage.json` — when each fact was last used;
- `library.json` — the sequence counter; `maintenance.jsonl` — the receipts;
- `handover.json` — the intake receipt, once it has run.

Memory is off when `autoMemoryEnabled` is `false` in settings; then nothing
is loaded, saved or looked up, and the four tools leave the roster.
