# Mneme: Mercury's memory

Mneme is Mercury's project memory, on by default. It stores facts in plain
markdown topic pages under the config home, managed through four tools and
the `/memory` centre.

## What the model gets

Four things reach the model without anyone asking:

- **The front page**, loaded at the start of every chat. Mercury builds this
  index of topics and fact counts; it says where things live and carries no
  fact bodies.
- **The pinned shelf**, loaded in full: standing rules and preferences, word
  for word. A rule you ask Mercury to remember ("remember: always …") is
  pinned as you said it and marked as asked for by you; Mercury never
  rewords, merges or drops it on its own.
- **The facts that matter now** (`# Memory at start`), composed once at
  session start within a separate character allowance (`memory.startLimit`,
  default 4000) from the unpinned facts and earlier session notes that best
  match the current branch, recently touched files and last handoff note.
- **The automatic lookup** on every message: up to five matching facts attach
  before the model answers, each pointing at its topic page.

Mercury republishes the front page only when the library or its pinned rules
change, preserving the provider's prompt cache between changes.

## Ranking by meaning and Recall scoring

`Recall` searches topic pages, archives, staged observations and the session
lineage ledger, returning up to 20 pointers (`limit`, default 12; a pointer is
an id, a title and footnotes, opened with `read:"<id>"`). When `limit` leaves
matches out, the second line says `<shown> of <found> hits shown; narrow the
words or raise the limit` (plus `, <N> of them stale` when stale hits were
cut).

Plain-word queries fuse four rankings by reciprocal rank (`k = 60`):

1. Literal pattern matches across pages and pending rows.
2. Stemmed BM25 word scoring (`deploying` matches `deployed`) weighted by a
   90-day recency factor (`pinned` and `ruling` rows do not decay).
3. On-device semantic similarity (`bge-base-en-v1.5` `q8_0`, 118 MB, MIT,
   768 dimensions) when the embedding pack is present.
4. A per-project logistic re-ranker fitted in milliseconds from `signals.json`
   (which records offered, opened and cited pointer ids over the last 512
   turns, with no model call).

Exact-phrase and regular-expression queries keep literal matching. Facts made
under a ruling recorded in the current session rise up to two places, and a
corrected fact's replacement inherits the usage history of the record it
superseded. Pinned rules keep their order, and stale facts sort after current
ones before `limit` applies. No model ever rewrites what you said: ranking only
decides what is found first.

The 118 MB BGE model ships in the macOS Apple silicon release archive (in a
source checkout with Rust installed, `bun run scripts/vendor/build-embed.ts`
builds `native/embed` and `bun run scripts/vendor/fetch-embed-models.ts`
fetches the model). It loads in-process when memory embeds or queries and
unloads after five idle minutes. Vectors live in
`memory/library/.index/embeddings.json` (one row per fact, no fact text,
rebuilt from the markdown pages whenever missing, stale or produced by another
model). `Retain` embeds new facts off the UI thread so a staged fact is
findable by meaning before consolidation; during a whole-library rebuild,
`Recall` reports `ranked by word match only (index building…)`, and once ready
it reports `ranked by semantic + word match (bge-base-en-v1.5)`.

`/config`'s **Memory recall ranking** row (`memory.embeddingModel`) selects a
model carried by the install or the path to a `.gguf` file. When the addon or
model is absent (or a configured path is missing), memory runs `word match
only` and both the front page and `Recall` state that mode.

## The four verbs and write-time contradiction checks

The model works its memory through four tools:

- **Retain** stages one or more facts (up to 2,000 characters of content and
  context per item) into `current.jsonl`; consolidation files them onto topic
  pages, and a pinned rule triggers maintenance immediately.
- **Recall** searches for pointers (`query`) or reads a full record or topic
  page (`read`: `seq:<n>`, `doc:<slug>`, `pending:<ts>`, `ledger:<ordinal>`).
- **Reflect** synthesizes an answer over recalled records with `[seq N]` /
  `[pending N]` citations; uncited syntheses are refused.
- **Correct** supersedes a fact (`op: "supersede"`), amends its wording after
  a full read (`op: "amend"`), or retracts it (`op: "retract"`). Consolidated
  facts stay in `## history`; retracting a pending draft (`pending:<ts>`)
  strikes it from the buffer before it reaches a page.

Before writing, `Retain` and `Correct` check each candidate against live,
archived and pending records for contradictions: high stem overlap (`>= 0.75`)
paired with a polarity flip (`always`/`never`, `on`/`off`, `enabled`/`disabled`,
`allowed`/`forbidden`, `included`/`excluded`, `before`/`after`, `true`/`false`),
a clause negation or a differing number. When Jev is enabled with a key, it
scores candidate pairs (`>= 0.6` confirms a conflict). A conflicting write is
refused with the record named (`not stored: it conflicts with rule 43, "…"`),
instructing the model to `Correct` a wrong fact with
evidence or re-retain with the scope difference stated (`when`, `where`,
`which`). Verbatim or contained restatements are never refused.

## Consolidation, restatement merging and staleness

- A topic page that outgrows its budget splits into smaller pages listed under
  one topic line on the front page.
- Consolidation validates conservation before publishing: every input fact
  emerges as a live entry or under `## history`. When a pending observation
  restates an unpinned fact on record (at least `0.8` Jaccard similarity on
  stemmed 3-word shingles, with identical negation windows, polarity windows,
  numbers, identifiers and mid-sentence proper names), the newer wording
  becomes current and the older moves to `## history` under `supersedes`, both
  kept verbatim. Pinned rules, rules marked asked-for-by-you, and explicit
  `replaces` rows never merge away.
- Unpinned facts age with a 30-day half-life from their last confirmation
  (creation time, an open in `Recall` or `/memory`, a citation in an answer, or
  a re-retain). Below `0.25` confidence (about two months unconfirmed), a fact
  carries `stale` with its last confirmation date (`<YYYY-MM-DD>`) in `Recall`,
  `# Memory at start` and `/memory` (a fact citing a moved repo path is marked
  `needs review`). Opening, citing or re-retaining a stale fact restores
  its confidence; facts are never deleted, and pinned rules never age.
- Facts unused for ninety days move to `archive-<slug>.md` off the front page;
  `Recall` still searches archives and using a fact brings it back.

## The pinned shelf and its limit

`memory.pinnedLimit` in settings (default `8000` characters, minimum `1000`,
adjusted by **Pinned memory limit** in `/config`) sets the text budget for the
pinned shelf. A new rule is never refused: when pinned text exceeds the limit,
every rule still loads and an interactive chat opens with one notice naming the
pinned character count, the limit and where to trim (never shown in crewmate
chats or `mercury run`). Crewmates receive the front page with the pinned
rules.

A rule you asked for changes only on your word. Consolidation leaves it as
said. When the model is asked to correct, replace or drop it, it puts one
card to you first: the rule's words as stored, what will happen (unpinned and
struck, corrected to the new words, or replaced by them), and Yes or No; No
keeps the rule as it is. Under the sovereign permission mode the change runs
without the card, and `/memory` shows it was made from the chat under
sovereign. A run with no one to answer the card changes nothing and points
to `/memory`, where you change it yourself: under pinned rules,
`↵` opens the rule and `c` corrects it: you retype it, the old wording goes
to history linked to the new one, and the pin and its "asked for by you" mark
follow the new wording; `u` unpins it. Once you have unpinned a rule it is a
plain fact again: restate the rule in the chat and the model replaces it, so
one rule stays current. For another pinned rule, a replacement names that
rule's id and keeps the earlier text as history. Rules that merely share
words can both stay.

## What rides at the start of a session

After the pinned shelf, Mercury composes `# Memory at start` within its own
allowance (`memory.startLimit`, default `4000` characters, minimum `1000`,
moved in `/config` by **Memory at start, beyond the pins** in steps of 1,000).
No model call runs: Mercury reads the current branch name, the working tree's
changed files, files touched in recent sessions, and the last session's handoff
note, scores every unpinned fact (including archived pages) and earlier note
against that state, and divides each score by character length (`score /
chars`) so concise matches pack ahead of long ones of equal relevance. Stale
facts sort last and carry their `stale` confirmation-date tag counted
within the allowance; zero-score items never ride. The section opens with one
summary line (`Memory at start: <N> pinned rules (<chars> characters) and <k>
of <M> facts, <j> of <L> earlier notes most relevant to branch <name>, the
files touched lately and the last note; Recall finds the rest.`) and stays
fixed for the session so the prompt prefix stays cacheable.

## Session handoff notes and the journal

When a session ends, Mercury asks the model for one orienting handoff note for
the next session, stored verbatim up to 8,000 characters in
`<config home>/projects/<project>/lineage/ledger.jsonl` (never written into
your repository as `.mercury/handoff.md`; a note over 8,000 characters is
refused with its character count). If more than half of the note's sentences
(and at least two sentences) repeat facts, rules or the previous note already
on record, Mercury names the repeated sources (`Four of your seven sentences
are already on record (rule 12, fact 19 and the previous note).`) and asks
once more for only what is new; the second answer is stored as written.

Separately, when `memory.journal` is `true` (off by default), the **Journal**
tool lets the model record a short first-person entry per session in
`<config home>/projects/<project>/journal/journal.md`. `memory.journalOnEntryPage`
(off by default) includes the latest journal entry on the next session's
`# Lineage` entry page; anything on the entry page travels to the session's
model provider with the prompt, while Mercury itself never syncs or uploads
the journal file.

## The memory centre and `/memory page`

`/memory` opens a searchable popup over the chat (`Mercury · memory`). The
overview table lists facts and decisions, pinned rules, topics, lineage
(previous sessions of this project), the journal, notes to take in,
maintenance, and instruction files (`MERCURY.md`, `AGENTS.md`,
`MERCURY.local.md`), with each section's count, newest date and state. Typing
filters any list or searches across topic pages, pinned rules, recent facts and
instruction files (`/` focuses search; `↵` on a `MERCURY.md:<line>` hit opens
that line and `e` opens it in your editor; `esc` or clicking outside steps
back). `/memory files` opens the instruction-files picker directly, `/memory
stats` prints library counts, `/memory enqueue` runs maintenance, and `/health`
reports the front page size and pinned shelf fill.

Opening a consolidated or pending fact shows its `seq` (or `recent` for a
staged row), pin and asked-for marks, staleness or path-review status,
timestamp and source, usage counts (`offered <N> · opened <N> · cited <N>
(last 512 turns)`), and its topic page. Keys in the detail footer act on the
record: `c` corrects it (for a consolidated fact, old wording moves to history
and the pin follows; for a pending fact, the old draft is struck), `x` pressed
twice retires it (striking a pending draft before consolidation), `p` pins it
as asked for by you, and `u` unpins it. Changes made in `/memory` apply to new
sessions while the running chat keeps the rules it loaded at startup.

`/memory page` draws the library in your browser as a versioned sample
([SAMPLES.md](SAMPLES.md), requires Samples enabled): facts render as nodes
with their opening words, pinned and stale marks, and `offered`/`opened`/`cited`
counts, linked by `supersedes`, `ruling` and `session` edges. Clicking a node
opens its full verbatim record.

## On disk

Under `<config home>/projects/<project>/`:

- `lineage/ledger.jsonl`: session lineage records and handoff notes;
- `journal/journal.md`: session journal entries;
- `memory/library/topic-<slug>.md` and `archive-<slug>.md`: topic and archive pages;
- `memory/library/current.jsonl`: staged observations awaiting consolidation;
- `memory/library/front-page.md` and `pinned-status.json`: published index and shelf fill;
- `memory/library/pins.json`, `usage.json` and `signals.json`: pins, confirmation timestamps and recall signal log;
- `memory/library/library.json` and `maintenance.jsonl`: sequence counter and consolidation receipts;
- `memory/library/.index/embeddings.json`: derived semantic vectors.

Setting `memory.enabled` to `false` disables loading, lookup and saving, and
removes `Retain`, `Recall`, `Reflect`, `Correct` and `Journal` from the tool
roster.
