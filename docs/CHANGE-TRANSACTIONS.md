# Change transactions

One change vocabulary covers every mutation path in Mercury: a way for a
later mutation to fail fast on stale assumptions, and an exactly-once
record of what changed.

## Staleness anchors

Every file read mints a compact content-derived anchor, printed to the
model as `(anchor: …)`:

```
fa:<hex12>                whole-file digest
ra:<hex12>:L<start>+<n>   digest of the exact 1-based line range returned
```

Digests are sha256 over CRLF-normalized text, truncated to 12 hex characters
— a staleness check, not a security boundary. Normalization matches what the
model actually sees, so a CRLF file anchors identically from either side;
Unicode is not normalized (content differing in codepoints is different
content).

A mutation that carries `expected_anchor` verifies it against current bytes
before writing. A failed check returns a typed result naming the reason
(`stale` or `malformed`), the anchor the same scope mints against current
content, and the smallest reread that repairs the assumption — the caller
re-reads precisely, never guesses.

## Hashline line anchors

With `MERCURY_LINE_ANCHORS` (default-on), the opt-in `line_anchors` Read
parameter stamps every line prefix with its content anchor — `N#hhhh`, the
1-based line number plus the first hex of that line's own hash. The visible
prefix IS the copyable address. Identical lines share a hash and never
share an address: position is the authority, and the hash is a content
tripwire whose width widens on evidence. The anchored rows are
row-for-row the plain presentation with hashes spliced in; the `fa:`/`ra:`
anchor tail is unchanged.

The Edit hunk grammar accepts anchor-qualified line spellings —
`"12#ab3f"`, `"12#ab3f-18#9c2e"` — whose endpoint hashes are verified
against the current content before anything is written. A diverged or
out-of-bounds ref REFUSES TYPED, and the refusal answers the current
neighborhood anchors plus bounded moved-to candidates — the engine never
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

With `MERCURY_ANCHOR_PATCH` (opt-in), `ChangeSet` additionally accepts a
compact patch mode — `patch: "…"` beside `changes[]`: one model-authored
patch string spells line edits, TS block edits, cut/paste registers
(cross-file code moves), whole-file delete, and file move over Mercury's
own `fa:`/`ra:` anchors. The dialect has a closed vocabulary, and every
patch is preflighted and committed through the same planner and journaled
commit walk as the JSON form — never a second apply path. The patch path
keeps a per-line seen-lines evidence ledger and a bounded
unique-relocation recovery for stale anchors; success returns fresh anchors
per touched file, so patches chain without a reread.

## Change receipts

Every mutation-shaped tool call lands exactly one receipt: the intent (what
the mutation set out to do, e.g. `tool:Edit`) plus the observed effect,
recorded once at a single chokepoint — a cancelled or refused call can
never mint a partial receipt. Consumers read "what changed, in order, with
intent" without replaying transcripts; the record is bounded,
conversation-lifetime state. Repeated no-change outcomes feed the
repetition policy, which reports truthfully instead of looping.

## The ChangeSet tool

`ChangeSet` is one compact call that prepares,
reviews, and applies an anchored text change across several existing files:

| Call | Meaning |
|---|---|
| `preview` + `changes` | plan only — an immutable, content-addressed plan; writes nothing (the operator-review path) |
| `apply` + `changes` | the fast path: plan, one aggregate decision, apply |
| `apply` + `plan_id` | apply a previewed plan; a stale plan refuses with current anchors |
| `status` / `discard` + `plan_id` | inspect or retire a plan |

Each member names an existing text file, its required `expected_anchor`, and
its hunks (the live Edit hunk vocabulary). Creation, deletion, move, binary,
notebook, and executable targets are refused by name in the JSON form (the
patch dialect above carries delete and move). A nine-step preflight
covers bounds, duplicates, anchors, hunks, digest determinism, owner
isolation, and expiry — the valid subset of an invalid set is never written.
There is exactly one aggregate operator decision per set (any denied path
means zero writes), and exactly one effect, one receipt, one canonical
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
   the next boot (idempotent — a second restart changes nothing);
4. compensation restores originals only where current bytes still match the
   planned output — later bytes are never overwritten, and the exact
   unresolved paths are reported.

Durable state lives under `<config-home>/changesets`. Editor/LSP post-write
sync is awaited and bounded — a timeout classifies as indeterminate, never
as success.

## Flags

All rows live in the in-code registry (`src/substrate/flagRegistry.ts`;
rendered on demand to an untracked path):

- `MERCURY_CHANGE_RECEIPTS` (default-on) — anchors on reads, the
  `expected_anchor` Edit field, the receipt record. `=0` removes the layer
  whole: no anchor lines, no enforcement, no record.
- `MERCURY_EDIT_HUNKS` (default-on) — the `hunks` Edit mode. `=0` restores
  the plain `expected_anchor` Edit schema.
- `MERCURY_LINE_ANCHORS` (default-on) — the hashline layer. `=0` removes
  the `line_anchors` Read parameter, and hash spellings refuse as
  unparseable exactly like the plain grammar.
- `MERCURY_ANCHOR_PATCH` (opt-in) — the patch dialect. Unset or `=0`, the
  ChangeSet schema carries no patch field, byte-identically.
- `MERCURY_CHANGESET` (default-on; requires receipts and hunks) — the
  ChangeSet tool itself. `=0` removes the tool from the catalog
  byte-identically while the shared commit core keeps serving Structure and
  LSP.
