# Mneme: Mercury's memory

Mneme is Mercury's project memory, on by default. It stores facts in plain
markdown topic pages under the config home, managed through four tools and
the `/memory` centre.

With one library per project, it keeps what a session learns in **topic pages**:
plain markdown files, one page per topic, each fact on its own line with its
time and source. The pages are readable in the project's memory folder under the
Mercury config home. Mercury changes them through its memory tools; use
`/memory` to correct, pin or unpin a record.

## What the model gets

Four things are in front of the model without anyone asking:

- **The front page**, loaded at the start of every chat. It is the index of
  the library (each topic on one line with its fact count), built by Mercury
  and never by the model. The index says where things are; it never carries the
  facts themselves.
- **The pinned shelf**, loaded in full: standing rules and preferences, word
  for word. A rule you ask Mercury to remember ("remember: always …") is
  pinned as you said it and marked as asked for by you; Mercury never
  rewords, merges or drops such a rule on its own. You pin and unpin from the
  memory centre.
- **The facts that matter now** (`# Memory at start`), chosen once at the start
  of the session: within a dedicated startup budget beside the pinned shelf (see
  [What rides at the start of a session](#what-rides-at-the-start-of-a-session)),
  the facts and earlier notes most relevant to the branch you are on, the files
  touched lately and the last note left, each word for word. One line above them
  says how much rode and that Recall finds the rest.
- **The automatic lookup** on every message: up to two facts that match what
  you just said, or a rule that names a file the model has in hand, are
  attached before the model answers, each pointing at the page it lives on. A
  fact is attached once, the first time it becomes relevant in a session; after
  that it is a Recall away, and a compaction does not bring it back. The
  working-set capsule lists memory the same way: a record once, the first time
  it matches, on whichever of the two surfaces sees it first.

Mercury publishes the front page when the library or its pinned rules change.
Between those changes the same page loads into each chat, preserving the
provider's prompt cache.

## Ranking by meaning

Beside the word match, Recall ranks by meaning: a small embedding model runs
in-process on your machine, so "the laptop's clock" finds "the notebook's time
zone" with no word in common. The shipped model is a 118 MB BGE base encoder
(`bge-base-en-v1.5` `q8_0`, MIT licence, 768 dimensions) that arrives with
every release archive, built for its platform (in a source checkout with Rust
installed, `bun run setup` builds `native/embed` through `bun run
scripts/vendor/build-embed.ts` and fetches the model through `bun run
scripts/vendor/fetch-embed-models.ts --default`); nothing leaves the machine
and no account or paid model call is involved. On
Linux and Windows the maths runs a vectorised kernel, so a Recall by meaning
takes about a tenth of a second; on macOS Accelerate answers in a few
hundredths. The model loads when memory needs it (a build, a Retain
or a query; about half a gigabyte while loaded) and leaves memory after five
idle minutes.

The vectors live in a derived file beside the library
(`memory/library/.index/embeddings.json`): one row per fact, no fact text,
stamped with the model that made it, and rebuilt from the pages whenever it is
missing, stale or made by another model, so the pages stay the single source of truth. A
Retain embeds its fact at once, off the UI thread, so a fresh fact is
found by meaning before it is consolidated; a whole-library build runs the same
way and Recall says `word match only (index building…)` meanwhile, and once
ready it reports `ranked by semantic + word match (bge-base-en-v1.5)`.

`Recall` searches topic pages, archives, staged observations and the session
lineage ledger, returning up to 20 pointers (`limit`, default 12; a pointer is
an id, a title and footnotes, opened with `read:"<id>"`). The limit counts
records; a page's own lines (its summary, its headings) never take a slot.
When `limit` leaves records out, the second line says `<shown> of <found> hits
shown; narrow the words or raise the limit` (with `, <N> of the <M> left out
stale` when stale hits were cut); at the most of 20 it says instead `the limit
is at its most (20): narrow the words, or open a whole page with
read:"doc:<slug>"`. Plain-word queries fuse four orderings by reciprocal rank
fusion with `k = 60`:

1. Exact-text literal pattern hits across pages and pending rows.
2. Stemmed BM25 word scoring (`deploying` matches `deployed`) weighted by a
   90-day recency factor (`pinned` and `ruling` rows do not decay).
3. On-device semantic similarity (`bge-base-en-v1.5`) when the embedding pack
   is present.
4. A per-project logistic re-ranker fitted in milliseconds from `signals.json`
   (which records offered, opened and cited pointer ids over the last 512
   turns, with no model call).

Exact-phrase and regular-expression queries keep literal matching. Facts made
under a ruling recorded in the current session rise up to two places, and a
corrected fact's replacement inherits the usage history of the record it
superseded. Pinned rules keep their own order, facts that mean the same hand
their order to the usage signal, and stale facts sort after current ones before
`limit` applies. See [What rides at the start of a session](#what-rides-at-the-start-of-a-session)
for how the start-of-session pick ranks candidates. No model ever rewrites what
you said: ranking only decides what to find first.

`/config`'s **Memory recall ranking** row (`memory.embeddingModel`) names which
model serves and selects from the models this install carries (or the path to a
`.gguf` file). On an install without the addon or model, memory runs `word match
only` and both the front page and `Recall` say so in one line.

## The four verbs

The model writes or changes memory only when you ask it to: a preference
about how to work, a constraint you state, a fact you name, in your words.
The tools hold that rule themselves. Retain and Correct read your latest typed
message for the asking words and refuse otherwise, quoting the message they
read. The words that ask: any "remember" or "memorise"; "don't forget" and
"never forget"; "from now on", "standing rule", "make this a rule", "pin this";
"keep this", "keep this in mind", "bear in mind", "keep track of", "keep a
note of"; "note:", "note to self", "note this down", "make a note", "take a
note"; "write this down", "jot down", "log this"; "save", "add", "store",
"put" or "record" something "to memory", "store this fact", "use the Retain
tool"; "remind me", "next time", "for future sessions", "for future
reference"; and, in German, French, Spanish, Italian and Portuguese, "merke
dir", "n'oublie pas", "souviens-toi", "recuerda", "no olvides", "ricorda",
"non dimenticare" and "lembre-se". "Don't remember", "do you remember" and an
ask withdrawn in the same message ("no wait", "never mind", "scratch that",
"forget it") never pass. A crewmate's Retain or Correct is refused always; a
crewmate's finding goes in its report. A decision or an outcome belongs in the
project's records. The model works its memory through four tools:

- **Retain** saves a fact (up to 2,000 characters of content and context per
  item) for future sessions into `current.jsonl`. It is findable in the staging
  buffer at once; consolidation files it on its topic page. A pinned rule
  also triggers maintenance immediately. The result says whether it reached
  the shelf or is waiting for the next maintenance pass.
- **Recall** searches the pages (and the staging buffer) and reads a whole
  page or one record by its id (`seq:<n>`, `doc:<slug>`, `pending:<ts>`,
  `ledger:<ordinal>`).
- **Reflect** answers a question over what was recalled, citing the records
  it used (`[seq N]` / `[pending N]`); an answer that cites nothing is refused.
- **Correct** supersedes a wrong fact with the right one (`op: "supersede"`),
  amends its wording after a full read (`op: "amend"`), or retracts it
  (`op: "retract"`). A consolidated fact is kept as history under `## history`
  on the page, never deleted. A superseded or amended pending draft
  (`pending:<ts>`) is replaced by a new draft that keeps the old words as its
  history (a read of the new id shows them) until consolidation files the
  fact; retracting a pending draft strikes it from the buffer before it
  reaches a page.

Before writing, `Retain` and `Correct` check each candidate against live,
archived and pending records for contradictions: high stem overlap (`>= 0.75`)
paired with a polarity flip (`always`/`never`, `on`/`off`, `enabled`/`disabled`,
`allowed`/`forbidden`, `included`/`excluded`, `before`/`after`, `true`/`false`),
a clause negation or a differing number. When Jev is enabled with a key, it
scores candidate pairs (`>= 0.6` confirms a conflict). A conflicting write is
refused with the record named (`not stored: it conflicts with rule 43, "…"`),
and the contradiction is your call: the refusal tells the model to ask you
which is true and, on your word, to `Correct` the record with your reason or
retain both with the difference stated (`when`, `where`, `which`). Verbatim or
contained restatements are never refused.

## It stays small on its own

- A topic page that grows too long splits into smaller pages; the index shows
  them under the one topic line, so the index grows by a single line.
- Consolidation merges duplicates and replaces corrected facts. A checker
  confirms that every fact that went in came out (as a live fact or as
  history) before anything is written.
- When a pending observation restates an
  unpinned fact on record (at least `0.8` Jaccard similarity on stemmed 3-word
  shingles, with identical negation windows, polarity windows, numbers,
  identifiers and mid-sentence proper names), the newer wording becomes current
  and the older moves to `## history` under `supersedes`, both kept verbatim.
  Pinned rules, rules marked asked-for-by-you, and explicit `replaces` rows
  never merge away.
- Unpinned facts age with a 30-day half-life from their last confirmation
  (creation time, an open in `Recall` or `/memory`, a citation in an answer, or
  a re-retain). Below `0.25` confidence (about two months unconfirmed), a fact
  carries `stale` with its last confirmation date (`<YYYY-MM-DD>`) in `Recall`,
  `# Memory at start` and `/memory` (a fact citing a moved repo path is marked
  `needs review`). Opening, citing or re-retaining a stale fact restores its
  confidence; facts are never deleted, and pinned rules never age.
- A fact nobody has used for ninety days moves to an archive page off the
  index. Recall still finds it, and using it brings it back.
- The index has a fixed size. Mercury keeps it under by splitting and
  archiving and never asks you about it.

## The pinned shelf and its limit

The shelf has a character limit on the text it loads into every session, while
holding any number of rules on disk. The limit is yours: `memory.pinnedLimit` in settings
(characters; the default is 8000), and the **Pinned memory limit** row in
`/config` moves it. A new rule is never refused. When the shelf is over its
limit every rule still loads, and a chat you are in opens with one line that
says so: how much is pinned, the limit, that all of it is loaded, and where
to trim. The line never appears in a crewmate's chat or in `mercury run`
output. Crewmates receive the front page with the pinned rules.

A rule you asked for changes only on your word. Consolidation leaves it as
said. When the model is asked to correct, replace or drop it, it puts one
card to you first: the rule's words as stored, what will happen (unpinned and
struck, corrected to the new words, or replaced by them), and Yes or No; No
keeps the rule as it is. Under the sovereign permission mode the change runs
without the card, and `/memory` shows it was made from the chat under
sovereign. A run with no one to answer the card changes nothing and points
to `/memory`, where you change it yourself: under pinned rules,
`↵` opens the rule and `c` corrects it (you retype it, the old wording moves
to history under the new one, and the pin and its "asked for by you" mark
follow the new wording); `u` unpins it. Once you have unpinned a rule it is a
plain fact again: restate the rule in the chat and the model replaces it, so
one rule stays current. For another pinned rule, a replacement names that
rule's id and keeps the earlier text as history. Rules that merely share
words are not a conflict, so both stay.

## What rides at the start of a session

The pinned shelf rides first and whole, whatever its size. Mercury then chooses
startup context without calling a model. Source-linked required records ride in
full, outside the allowance for other matches. The remaining candidates are
ranked in tiers: matches to the current prompt, then matches to a source-linked
continuation. If neither channel finds a match, the fallback uses the branch,
changed files, files touched in earlier sessions and the last note left.

Word and semantic rankings supply reciprocal-rank scores (`1 / (60 + rank + 1)`).
Within each tier, historical matches and stale facts are deprioritized, then
packing uses `score / √chars`: relevance divided by the square root of the
record's character length. Shorter records still have an advantage at equal
relevance, but the penalty for length is gentler than division by length itself.
Stale tags count toward the record's size. The same inputs produce the same
selection; records with no relevant match do not ride unless explicitly required.

The allowance is the smaller of `memory.startLimit` and
`600 × ⌈log2(1 + candidates)⌉` characters, where candidates counts positively
scored, non-required records. `memory.startLimit` defaults to 4000 characters;
**Memory at start, beyond the pins** in `/config` moves that setting by a thousand.
The pinned shelf and required records do not consume this allowance.

Records are packed in that order while they fit. When a fact matched the prompt
or continuation but its full text does not fit, a shorter pointer can ride if
there is room. That pointer names the record and asks the model to open it with
Recall before the affected decision. An earlier note, or a project-state fallback
match, does not get this pointer replacement. Selected records are displayed by
tier and relevance.

The block (`# Memory at start`) sits between the pinned shelf and the lineage
page. Its summary names the pins, the facts, pending facts, pointers and earlier
notes selected, and what they matched; Recall finds the rest. Leaving a fact off
the page is not forgetting it. The page is composed once at the start of a session
and does not move during the session; a new fact or file change can affect the
next session's page.

## The journal

When a session ends, Mercury asks the model for one orienting handoff note for
the next session, stored verbatim up to 8,000 characters in the session lineage
ledger (see [On disk](#on-disk); never written into your repository as
`.mercury/handoff.md`, and a note over 8,000 characters is refused with its
character count). On the next session's `# Lineage` entry page, a previous
session that left no handoff note is shown as `"The last session (...) left no
note."`, while `Recall` (`read: "ledger:<ordinal>"`) prints `"no note left"`.
If more than half of the note's sentences (and at least two sentences) repeat
facts, rules or the previous note already on record, Mercury names the repeated
sources (`Four of your seven sentences are already on record (rule 12, fact 19
and the previous note).`) and asks once more for only what is new; the second
answer is stored as written.

Beside the facts, Mercury keeps a journal: the model's own account of each
session, in the first person (what happened, what you wanted, what it
noticed about how you like to work, what it got wrong). The model writes the
entry with the **Journal** tool, in plain words and kept short; a fault is
its own and said so. When a session ends Mercury appends the entry, dated
from its own clock, to the project's journal. One entry per session; a later
call replaces the earlier; a session that leaves no entry adds no line.
Project facts and conventions go to the instruction file or to `Retain` instead
of the journal, and what the model noticed about you goes to the journal and
never into the instruction file.

The journal lives in the Mercury config home beside the project's memory (see
[On disk](#on-disk)), never under the project tree, and Mercury never pushes,
syncs or shares it. Read it in `/memory`: the overview row counts the entries
and dates the newest, `↵` lists them newest first, and `↵` on one opens it
whole. `memory.journal` turns the writing off (the tool leaves the roster and
nothing is written). `memory.journalOnEntryPage`, off by default, hands the last
entry to the model at the start of the next session on its entry page (`#
Lineage`), where the session's model provider receives it as part of the prompt
("never uploaded" means Mercury itself never pushes, syncs or shares the
journal file).

## The memory centre

`/memory` is the front door. It opens as a popup over the chat, in the frame
the files menu and `/config` use: the title "Mercury · memory" with the
project and its memory folder under it, a search line at the top, the body,
and the keys in the footer. The overview is a table with one row per
section (facts and decisions, pinned rules, topics, the lineage, the
journal, notes to take in while there are any, maintenance and the
instruction files) and three columns beside the name: the count, the newest
date, and a one-word state (`MERCURY.md`, `AGENTS.md` and `MERCURY.local.md` sit
under instruction files, and the popup title is `Mercury · memory`).
The selected row's detail reads under the table
and its action in the footer: `↵` lists the facts, the pinned rules or the
topics, opens the sessions or the journal, runs maintenance now, takes the
old notes in, opens the instruction files picker. The lineage row counts the
sessions before this one; the chat you are in is never among them.

A section opens in the body with the overview folded to a breadcrumb. The
facts (newest first), the pinned rules and the topics are lists. The lineage
is a table of the sessions of this work, newest first (session, engine,
started, ended, and whether it left a note), and `↵` on a noted session
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

Open a fact (from the facts, the pinned rules or the search, which all open the same
view) to see its seq, whether it is pinned and asked for by you, when it was
saved and from where, and the page it lives on with the fact marked.
For both consolidated and pending facts (`seq` or `recent`), the detail view
also shows staleness or path-review status and usage counts (`offered <N> ·
opened <N> · cited <N> (last 512 turns)`); on a pending fact, `c` strikes the
old draft when corrected and `x` strikes it before consolidation.
The footer names only the keys that work there: `c` corrects it (you retype it
with the current wording in view; the old wording goes to history and the
pin follows the new one), `x` retires it (pressing `x` asks for confirmation
first and pressing `x` again retires it, while any other key keeps it), `p` pins it word for word as asked for
by you, and `u` unpins it; pin and unpin act at once and the receipt names the
key that undoes them. A change made here reaches new sessions; the chat you
are in keeps the rules it loaded when it started, and every receipt says so.

`esc` backs out one level and returns to the row you came from; from the
overview it closes the popup, and a click outside closes it too. `/memory
files` opens the instruction files picker straight away, in the same popup.
`/memory stats` prints the numbers; `/memory enqueue` runs maintenance now.
`/health` carries a memory row with the front page's size and the shelf's
fill.

`/memory page` draws the library as a page in your browser: every fact is a
node with its first words, pinned rules and stale facts are marked, each
node says how often it was offered, opened and cited (`offered`, `opened`,
`cited`), and the links are
edges showing what a fact supersedes, the ruling it was made under, and the session
that made it (`supersedes`, `ruling`, `session`). A node opens its record, word for word. The page reads the
library and writes nothing back. It is kept as a sample, a new version each
time you open it, so Samples must be on ([SAMPLES.md](SAMPLES.md)).

## On disk

Session lineage records and handoff notes live at
`<config home>/projects/<project>/lineage/ledger.jsonl`. The journal is
`<config home>/projects/<project>/journal/journal.md`. The
library lives at `<config home>/projects/<project>/memory/library/`:

- `topic-<slug>.md`: one topic page; `archive-<slug>.md`: its archive;
- `current.jsonl`: the staging buffer of facts not yet consolidated;
- `front-page.md` and `pinned-status.json`: the published index and pinned
  shelf, with the shelf's fill;
- `pins.json`: the pinned rules; `usage.json`: when each fact was last used;
- `library.json`: the sequence counter; `maintenance.jsonl`: the receipts.
`signals.json` holds the recall signal log, and `.index/embeddings.json` holds
the derived semantic vectors.

Memory is off when `memory.enabled` is `false` in settings; then nothing
is loaded, saved or looked up, and the four tools (`Retain`, `Recall`,
`Reflect`, `Correct`) leave the roster, the `Journal` tool with them.
