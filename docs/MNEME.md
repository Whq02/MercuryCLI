# Mneme — Mercury's memory

Mneme is Mercury's memory, on by default, with one library per project.
It keeps what a session learns in **topic pages**: plain markdown files,
one page per topic, each fact on its own line with its time and source.
The pages are readable in the project's memory folder under the Mercury
config home. Mercury changes them through its memory tools; use `/memory`
to correct, pin or unpin a record.

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

Mercury publishes the front page when the library or its pinned rules change.
Between those changes the same page loads into each chat, preserving the
provider's prompt cache.

## The four verbs

The model works its memory through four tools:

- **Retain** saves a fact for future sessions. It is findable in the staging
  buffer at once; consolidation files it on its topic page. A pinned rule
  also triggers maintenance immediately. The result says whether it reached
  the shelf or is waiting for the next maintenance pass.
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
how many rules it holds. The limit is yours: `memory.pinnedLimit` in settings
(characters; the default is 8000), and the **Pinned memory limit** row in
`/config` moves it. A new rule is never refused. When the shelf is over its
limit every rule still loads, and a chat you are in opens with one line that
says so — how much is pinned, the limit, that all of it is loaded, and where
to trim. The line never appears in a crewmate's chat or in `mercury run`
output. Crewmates receive the front page with the pinned rules.

A rule you asked for is yours alone: the model cannot correct, replace or
unpin it. Consolidation leaves it as said; you change or unpin it in
`/memory`. For another pinned rule, a replacement names that rule's id and
keeps the earlier text as history. Rules that merely share words are not a
conflict — both stay.

## The memory centre

`/memory` is the front door. Type to search facts and rules; open one to see
why it matched and the page it lives on; press `c` to correct it (the old
fact moves to history), `x` to retire it, `p` to pin it word for word or `u`
to unpin it. The overview lists the topics and opens each page. It shows how
many facts the library holds, how full the pinned shelf is, the state of
maintenance and its recent receipts. `/memory stats` prints the same numbers;
`/memory enqueue` runs maintenance now. `/health` carries a memory row with
the front page's size and the shelf's fill.

## On disk

The library lives at `<config home>/projects/<project>/memory/library/`:

- `topic-<slug>.md` — one topic page; `archive-<slug>.md` — its archive;
- `current.jsonl` — the staging buffer of facts not yet consolidated;
- `front-page.md` and `pinned-status.json` — the published index and pinned
  shelf, with the shelf's fill;
- `pins.json` — the pinned rules; `usage.json` — when each fact was last used;
- `library.json` — the sequence counter; `maintenance.jsonl` — the receipts.

Memory is off when `memory.enabled` is `false` in settings; then nothing
is loaded, saved or looked up, and the four tools leave the roster.
