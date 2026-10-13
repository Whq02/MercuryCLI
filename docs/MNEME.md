# Mneme — Mercury's memory

Mneme is Mercury's memory, on by default, with one library per project.
It keeps what a session learns in **topic pages**: plain markdown files,
one page per topic, each fact on its own line with its time and source.
The pages are readable in the project's memory folder under the Mercury
config home. Mercury changes them through its memory tools; use `/memory`
to correct, pin or unpin a record.

## What the model gets

Four things are in front of the model without anyone asking:

- **The front page**, loaded at the start of every chat. It is the index of
  the library — each topic on one line with its fact count — built by Mercury,
  never by the model. The index says where things are; it never carries the
  facts themselves.
- **The pinned shelf**, loaded in full: standing rules and preferences, word
  for word. A rule you ask Mercury to remember ("remember: always …") is
  pinned as you said it and marked as asked for by you; Mercury never
  rewords, merges or drops such a rule on its own. You pin and unpin from the
  memory centre.
- **The facts that matter now**, chosen once at the start of the session:
  within their own allowance beside the pinned shelf, the facts and earlier
  notes most relevant to the branch you are on, the files touched lately and
  the last note left, each word for word. One line above them says how much
  rode and that Recall finds the rest.
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
unpin it. Consolidation leaves it as said; you change it in `/memory`: under
pinned rules, `↵` opens the rule and `c` corrects it — you retype it, the old
wording goes to history linked to the new one, and the pin and its "asked for
by you" mark follow the new wording; `u` unpins it. Once you have unpinned a
rule it is a plain fact again: restate the rule in the chat and the model
replaces it, so one rule stays current. For another pinned rule, a
replacement names that rule's id and keeps the earlier text as history. Rules
that merely share words are not a conflict — both stay.

## What rides at the start of a session

The pinned shelf rides first and whole, whatever its size. Then, within an
allowance of its own that the shelf never eats into, Mercury chooses what
else a session should see at its start — no model is asked.
The project's state is the question: the name of the branch and its words,
the files changed in the working tree and the files the last sessions
touched, the words of the last note left. Every unpinned fact (archived ones
included) and every earlier note is scored against that state the way Recall
scores a search — the words in common, a fresh fact ahead of an old one on
the same words — and divided by its length, so a short fact that matches
well rides before a long one that matches as well. Facts are taken in that
order until the budget is full; a fact with nothing in common with the state
never rides; the same inputs always compose the same page. The block has its
own heading between the pinned shelf and the lineage page, and opens with
one line: how many rules are pinned and how much they weigh, how many of the
facts and earlier notes rode and what they were matched against, and that
Recall finds the rest. Leaving a fact off the page is not forgetting it.

The allowance is `memory.startLimit` in settings (characters; the default is
4000), and the **Memory at start, beyond the pins** row in `/config` moves it
by a thousand. The page is composed once at the start of a session and never
moves while the session runs; a fact saved or a file touched mid-session
reaches the next session's page.

## The journal

Beside the facts, Mercury keeps a journal: the model's own account of each
session, in the first person — what happened, what you wanted, what it
noticed about how you like to work, what it got wrong. The model writes the
entry with the **Journal** tool, in plain words and kept short; a fault is
its own and said so. When a session ends Mercury appends the entry, dated
from its own clock, to the project's journal. One entry per session; a later
call replaces the earlier; a session that leaves no entry adds no line.
Project facts and conventions do not go here — they go to the instruction
file or to Retain — and what the model noticed about you goes here and never
into the instruction file.

The journal lives in the Mercury home beside the project's memory, never
under the project tree, and Mercury never pushes, syncs or shares it. Read it
in `/memory`: the overview row counts the entries and dates the newest, `↵`
lists them newest first, and `↵` on one opens it whole. `memory.journal`
turns the writing off (the tool leaves the roster and nothing is written).
`memory.journalOnEntryPage`, off by default, hands the last entry to the
model at the start of the next session on its entry page — and whatever the
model reads at entry travels to the engine's provider with the request;
"never uploaded" means Mercury itself never pushes, syncs or shares the
journal, not that the session's own engine does not see it.

## The memory centre

`/memory` is the front door. It opens as a popup over the chat, in the frame
the files menu and `/config` use: the title "Mercury · memory" with the
project and its memory folder under it, a search line at the top, the body,
and the keys in the footer. The overview is a table with one row per
section — facts and decisions, pinned rules, topics, the lineage, the
journal, notes to take in (while there are any), maintenance and the
instruction files — and three columns beside the name: the count, the newest
date, and a one-word state. The selected row's detail reads under the table
and its action in the footer: `↵` lists the facts, the pinned rules or the
topics, opens the sessions or the journal, runs maintenance now, takes the
old notes in, opens the instruction files picker. The lineage row counts the
sessions before this one; the chat you are in is never among them.

A section opens in the body with the overview folded to a breadcrumb. The
facts (newest first), the pinned rules and the topics are lists. The lineage
is a table of the sessions of this work, newest first — session, engine,
started, ended, and whether it left a note — and `↵` on a noted session
opens its note. The journal is a dated list, newest first, and `↵` opens an
entry whole. A topic page, a session's note and a journal entry open as
pages wrapped to the frame; `↑↓` scroll one that runs past it.

One rule holds everywhere: a list filters by typing, so no letter is ever an
action in a list; a row acts once you open it with `↵`. Type to search: on
the overview the search reads the topic pages, the pinned rules, the recent
facts and the instruction files; in a list it filters the list; `/` focuses
the search. A convention you stated in the chat lives in MERCURY.md and the
search finds it by its words as `MERCURY.md:12 · the line`; `↵` opens the
file as a page at that line and `e` opens it in your editor.

Open a fact — from the facts, the pinned rules or the search, it is the same
view — to see its seq, whether it is pinned and asked for by you, when it was
saved and from where, and the page it lives on with the fact marked. The
footer names only the keys that work there: `c` corrects it (you retype it
with the current wording in view; the old wording goes to history and the
pin follows the new one), `x` retires it — `x` asks first and `x` again
retires it, any other key keeps it — `p` pins it word for word as asked for
by you, `u` unpins it; pin and unpin act at once and the receipt names the
key that undoes them. A change made here reaches new sessions; the chat you
are in keeps the rules it loaded when it started, and every receipt says so.

`esc` backs out one level and returns to the row you came from; from the
overview it closes the popup, and a click outside closes it too. `/memory
files` opens the instruction files picker straight away, in the same popup.
`/memory stats` prints the numbers; `/memory enqueue` runs maintenance now.
`/health` carries a memory row with the front page's size and the shelf's
fill.

## On disk

The journal is `<config home>/projects/<project>/journal/journal.md`. The
library lives at `<config home>/projects/<project>/memory/library/`:

- `topic-<slug>.md` — one topic page; `archive-<slug>.md` — its archive;
- `current.jsonl` — the staging buffer of facts not yet consolidated;
- `front-page.md` and `pinned-status.json` — the published index and pinned
  shelf, with the shelf's fill;
- `pins.json` — the pinned rules; `usage.json` — when each fact was last used;
- `library.json` — the sequence counter; `maintenance.jsonl` — the receipts.

Memory is off when `memory.enabled` is `false` in settings; then nothing
is loaded, saved or looked up, and the four tools leave the roster, the
Journal tool with them.
