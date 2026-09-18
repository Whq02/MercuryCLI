# Tabula — the project notepad

The **project notepad** is a file, and it is manual by design: `/note <text>` captures
into the per-project journal and its `notepad.md` mirror under the Mercury config home —
never inside the repo tree — so notes are private by construction and survive `/clear`.
No model reads, tidies or rewrites the notepad: what you wrote is what the file says.
The lanes rail keeps a display-only TABULA card over it: the open-note count in the
header, the top open notes, or the `no notes — /note` hint on a clean slate.

## Gates

Both gates are read live on every call — a gate that latches env at import lies
after a live authority toggle:

- `MERCURY_TABULA` — default on; `=0` is the only off switch. Off means the store,
  the command, and the rail card are absent, byte-identically.
- `MERCURY_TABULA_DIR` — store-root override, the hermetic seam an
  embedder pins so a live operator store is never touched.

## The store

The store root is `<config-home>/tabula/`, with one directory per project, named by
the same folder slug the transcript directory uses. Inside each project directory:

- `journal.jsonl` is the single source of truth. Every mutation is an appended event;
  nothing ever rewrites history. Two concurrent sessions append safely (one append
  per batch), and a torn tail from a crash mid-append is skipped line by line, never
  fatal.
- `notepad.md` is a derived, human-readable view: always rebuildable from the
  journal, atomically written (tmp+rename), stamped from the latest event time rather
  than the wall clock, so materialization is byte-deterministic.

Notes carry a priority from the closed set `now | next | later`. Folding the journal
into the notepad gives add/edit/pri/done/del their meaning, dedupes re-adds, and appends
unknown ids in order events rather than dropping them. Every read path degrades to
empty-with-reason. A journal written by an earlier build may carry events this build
does not know (a curator's `refine`, a `done` with a curator provenance): the unknown
event is skipped and the done stays done — nothing in the file is ever fatal.

## The command

`/note <text>` is interactive-only and gated on the master gate: one-keypress capture,
zero model turns, an appended journal event, and a re-materialized notepad.

`/note` is user-private: the line acts on the screen and never enters the session's
conversation, on any seat ([TRUST.md](TRUST.md) states the law).

## The Console's model

The Helm Console (the side-question fork) takes its own model: `/submodels` is the
picker, offering the **full catalogue the main `/model` picker offers — every family,
carriers included** — as one row set, with no tier, serve check or family policy applied.
Resolution runs the per-axis precedence law **env pin (`MERCURY_CONSOLE_MODEL`) > saved
pick > unset**; no default derives, and an unset Console spends no model call — the
reply is exactly the line `use /submodels to pin one of the available model catalogues`,
painted where the answer would be. Row states are typed, never a silent filter:
selectable; signed-out (activating the row routes to the family's attach home and the
pick lands on return); refused (the owning catalogue's reason verbatim). The Console's
identity and role ride the question's framing (the user turn), never the system prompt,
so a pick identical to the main model keeps the cache-hit prefix. `e` on a model row
opens the effort strip listing only the levels that model offers under the Console's own
call context; `↵` saves the level for the Console (`subModels.effort`), `esc` keeps what
was there, and the row reads `runs @high (chosen)` against `runs @medium (the model
default)` — the wire never carries a level the model does not offer.
