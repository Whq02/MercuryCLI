# Change transactions

<!-- answers: Read anchors (`fa:`, `ra:`), anchored Edit hunks, the atomic multi-file `ChangeSet` tool, change receipts and journaled recovery. -->

One change vocabulary covers every mutation path in Mercury: a way for a
later mutation to fail fast on stale assumptions, and an exactly-once
record of what changed.

## Staleness anchors

Every file read mints a compact content-derived anchor, printed to the
model as `(anchor: …)`, including an empty file. `Write` and `Read` with
`ranges` (when the whole file fits within the size cap) also return a
whole-file `(anchor: fa:…)` anchor. To add its first content
with an Edit hunk or a ChangeSet member, use `lines: "1"`, `insert: "before"`
and the full-file anchor from Read:

```
fa:<hex12>                whole-file digest
ra:<hex12>:L<start>+<n>   digest of the exact 1-based line range returned
```

Digests are sha256 over CRLF-normalized text, truncated to 12 hex characters
(a staleness check, distinct from a cryptographic boundary). Normalization matches what the
model actually sees, so a CRLF file anchors identically from either side;
Unicode is not normalized (content differing in codepoints is different
content).

A mutation that carries `expected_anchor` verifies it against current bytes
before writing. A failed check returns a typed result naming the reason
(`stale` or `malformed`) and the smallest `Read` that refreshes the anchor,
never a current anchor value, so the caller
re-reads precisely without guessing.

## Hashline line anchors

With `MERCURY_LINE_ANCHORS` (default-on), the opt-in `line_anchors` Read
parameter stamps every line prefix with its content anchor (`N#hhhh`, the
1-based line number plus the first hex of that line's own hash). The visible
prefix is the copyable address. Identical lines share a hash and never
share an address: position is the authority, and the hash is a content
tripwire whose width widens on evidence. The anchored rows are
row-for-row the plain presentation with hashes spliced in; the `fa:`/`ra:`
anchor tail is unchanged.

The Edit hunk grammar accepts anchor-qualified line spellings
(`"12#ab3f"`, `"12#ab3f-18#9c2e"`) whose endpoint hashes are verified
against the current content before anything is written. A diverged or
out-of-bounds ref refuses typed, and the refusal answers the current
neighborhood anchors plus bounded moved-to candidates; the engine never
relocates on its own. A batch whose every hunk is anchor-qualified may drop
`expected_anchor`: the line anchors are the staleness contract, and
external drift still refuses wholesale at the read-state gate.

## Anchored multi-hunk Edit

With `MERCURY_EDIT_HUNKS` (default-on), Edit accepts an additive `hunks`
field: one or more disjoint, 1-based line-addressed replacements or
insertions, applied atomically against the snapshot `expected_anchor` was
minted from (the anchor is required in this mode; a range anchor bounds the
editable window). Stale, overlapping, out-of-bounds, or unparseable hunks
write nothing and name the failing hunk. One call is one write, one effect,
one receipt, regardless of hunk count; consent previews render each hunk as
its exact old/new diff.

## The anchor-patch dialect

With `MERCURY_ANCHOR_PATCH` (opt-in), `ChangeSet` also accepts a
compact patch mode (`patch: "…"` beside `changes[]`): one model-authored
patch string spells line edits, TS block edits, cut/paste registers
(cross-file code moves), whole-file delete, and file move over Mercury's
own `fa:`/`ra:` anchors. The dialect has a closed vocabulary, and every
patch is preflighted and committed through the same planner and journaled
commit walk as the JSON form. The patch path
keeps a per-line seen-lines evidence ledger and a bounded
unique-relocation recovery for stale anchors; success returns fresh anchors
per touched file, so patches chain without a reread.

## The lines an edit carries

An Edit that touches lines the model has not read, in a file it has read as
it stands, lands in one call when those lines fit a Read window: the result
carries the edited lines as they now stand, each stretch widened by a small
margin, numbered as a Read shows them, each block with its own range
anchor, and they count as read. A refusal followed by an identical retry
bought nothing, so there is none.

The edit is refused instead when the file was never read this session, when
it changed after the lines the model read, when `expected_anchor` no longer
matches or, for hunks, covers only part of the lines addressed, or when the
unread lines exceed a Read window. A refusal names the path and the reason
and nothing of the file: no line of it, no anchor over it, and it records
nothing, so the same call again is refused again until a Read. A file the
session has no current knowledge of (never read, or read only before it
last changed) gets one and the same refusal whatever the `old_string`,
whether the text occurs once, twice or not at all; the refusal of a file a
Read deny rule or the project boundary protects therefore tells the model
nothing about it. With current knowledge of part of the file, the refusal
names the lines read, the lines the edit touches and the `Read(offset,
limit)` that covers the gap; a non-unique `old_string` names the line of
every match and the Read that shows the first with its neighbours.

The Edit tool's own write advances the ledger with it: the lines the model
had read shift through the edit and the lines it wrote count as seen, at
the generation the write produced. A later edit of that file therefore
needs no re-read even when the read cache no longer holds it (such as a resumed
agent or a pruned context), while a change made by anyone else still refuses,
because its generation is neither the read's nor the edit's. A generation is
keyed on the file's modification time, its size and a digest of its bytes,
so a rewrite that keeps the size and lands in the same millisecond is still
another generation.

The lines a session's own crewmate writes, through Write or Edit in the same
process, are the session's knowledge: the main thread and every other lane
of that session edit them without a Read, while a crewmate's Read stays its
own. A session resumed in a new process, and a crewmate resumed with
`ResumeCrewmate`, keep the lines their own earlier process read or wrote
(a windowed Read included) while those lines still read the same; a changed
line stays unread, and another session's lines are never credited.

A Read of lines 1–5 followed by a file change and a search showing lines
6–10 does not establish current knowledge of lines 1–10. The refusal names
which anchor, generation or ownership/coverage check failed. It counts only
current read windows and the current owner's ledger, and distinguishes
older reads from current coverage. A Read window and a ledger range that
cover the edit only together are never combined into one complete read:
the ledger's missing lines are carried, and the edit lands with them in its
result. If a required knowledge lookup throws, its own error is reported
instead of claiming the file was never read.

A Read of a file over the token cap answers with its first window as an
ordinary result, bounded by the Read's own line budget and token cap, and
records it as a windowed read of exactly those lines; the result's first
line names the file's size in tokens, the lines returned, and the Read that
continues from the window's end. Only a read the model asked for itself
answers this way. An automatic attachment that overflows still refuses and
records no lines as read, but its error names the bounded `Read(offset,
limit)` window to try next. The error carries the same next-window fields
as the ordinary result. A single oversized line comes back numbered and
clipped at the display bound, with the number of characters cut and its
source anchor retained. A notebook over the cap has no line window
(`offset` and `limit` do not select cells): its refusal says so and names
the shell cell-slice commands instead of a Read.

## The replacement's bytes

The Edit tool writes a replacement as typed. Its search tolerates the
file's typographic quotes: an old string typed with straight quotes still
finds a line whose quotes are curly, and the bytes outside the change keep
the file's own typography. Inside the change, only prose takes the file's
quote style, and only on a line that already carries it: Markdown, plain
text and AsciiDoc, as the diff highlighter's registry names them. Code,
configuration, data, and every file the registry cannot name (no
extension, a dotfile, a suffix it does not know, a script whose first line
names no language it knows) land byte for byte, a comment block inside a
code file included.

A write preserves what it did not change. Edit, Write and ChangeSet read
the file's shape before writing it back: every untouched line keeps its
own terminator, so a mixed file stays mixed and a CRLF file stays CRLF
whatever spelling the model's text arrived in; a line the change adds takes
the file's majority ending; a file that does not end with a newline keeps
ending without one, an append included, and one that does keeps its final
newline; a byte-order mark stays, a change on the first line included. A
one-word change through any of the three is a one-line diff. Write on an
existing file therefore takes its line endings from the file, never from
the content: the same lines in another spelling settle as no change.
Changing a file's line endings is a shell command's job.

## Change receipts

Every mutation-shaped tool call lands exactly one receipt: the intent (what
the mutation set out to do, e.g. `tool:Edit`) plus the observed effect,
recorded once at a single chokepoint so a cancelled or refused call can
never mint a partial receipt. Consumers read "what changed, in order, with
intent" without replaying transcripts; the record is bounded,
conversation-lifetime state. Repeated no-change outcomes feed the
repetition policy, which reports truthfully instead of looping.

## The ChangeSet tool

`ChangeSet` is one compact call that prepares,
reviews, and applies an anchored text change across several existing files:

| Call | Meaning |
|---|---|
| `preview` + `changes` | plan only: an immutable, content-addressed plan that writes nothing (the review path) |
| `apply` + `changes` | the fast path: plan, one aggregate decision, apply |
| `apply` + `plan_id` | apply a previewed plan; a stale plan refuses and names the Read that refreshes each anchor |
| `status` / `discard` + `plan_id` | inspect or retire a plan |

Each member names an existing text file, its required `expected_anchor`, and
either its hunks (the live Edit hunk vocabulary) or its edits (`old_string`,
`new_string`, `replace_all`, matched by Edit's own exact-string lane against
the same snapshot, each `old_string` occurring once unless `replace_all`);
`op: "delete"` removes the file and `op: "move"` renames it to `new_path`.
Creation, binary and notebook targets are refused by name. A nine-step preflight
covers bounds, duplicates, anchors, hunks, digest determinism, owner
isolation, and expiry; the valid subset of an invalid set is never written.
There is one aggregate approval decision per set (any denied path
means zero writes), and one effect, one receipt, one canonical
transaction, and one aggregate inline change-view card per executed set.
Bounds: 16 files per set, 32 hunks per file, 128 hunks per set, 4 MB staged
bytes, 240 rendered diff lines (per-file cuts are named, never silent), 16
retained plans per owner, 30-minute plan lifetime.

## The commit guarantee

The write mechanics live once, shared by ChangeSet, the Structure tool's
AST planner, and LSP workspace edits. The guarantee:

1. any revalidation, scope, or cancellation failure before the first rename
   writes nothing;
2. a normal apply reaches the complete planned state, verified by reread;
3. a midway interruption is journaled and deterministically reconciled at
   the next boot (idempotent, so a second restart changes nothing);
4. compensation restores originals only where current bytes still match the
   planned output; later bytes are never overwritten, and the exact
   unresolved paths are reported.

Durable state lives under `<config-home>/changesets`. Editor/LSP post-write
sync is awaited and bounded; a timeout classifies as indeterminate, never
as success.

## Flags

All rows live in the in-code registry (`src/substrate/flagRegistry.ts`;
rendered on demand to an untracked path):

- `MERCURY_CHANGE_RECEIPTS` (default-on): anchors on reads, the
  `expected_anchor` Edit field, the receipt record. `=0` removes the layer
  whole: no anchor lines, no enforcement, no record.
- `MERCURY_EDIT_HUNKS` (default-on): the `hunks` Edit mode. `=0` restores
  the plain `expected_anchor` Edit schema.
- `MERCURY_LINE_ANCHORS` (default-on): the hashline layer. `=0` removes
  the `line_anchors` Read parameter, and hash spellings refuse as
  unparseable like the plain grammar.
- `MERCURY_ANCHOR_PATCH` (opt-in): the patch dialect. Unset or `=0`, the
  ChangeSet schema carries no patch field, byte-identically.
- `MERCURY_CHANGESET` (default-on; requires receipts and hunks): the
  ChangeSet tool itself. `=0` removes the tool from the catalog
  byte-identically while the shared commit core keeps serving Structure and
  LSP.
