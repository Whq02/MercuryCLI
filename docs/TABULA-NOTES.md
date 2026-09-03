# Tabula — Minerva's room, and the project notepad underneath

`/tabula` is **Minerva's room**: you talk to Minerva there, and its one job is refining
your **saved prompts** — the third tab of the prompts panel (`/workbench`). It refines a
saved prompt only when you ask ("tighten prompt 2"); a refinement lands beside your
wording, never over it — and every refinement ALSO lands in the panel's dedicated
**MINERVA** tab, a durable per-project feed of refined prompts. A landed refinement is
usable in one gesture: `s` — on the refined prompt in the room's list, or on a MINERVA
tab row — puts the refined text in the main composer, ready to send; nothing is ever
submitted for you, your own ↵ is the send. With no Minerva model pinned (`/submodels`)
the room says so in one line and the saved prompts sit. Composing is free; ↵ is the one
billed call.

The room opens with the arrow focus on the saved-prompts list: ↑↓ pick a prompt and ↵
asks Minerva to refine that one; the chat box sits one ↓ (or tab) past the list for a
direct message. Which prompts a sentence is about comes from the sentence itself — a
number, an ordinal, or a prompt id — and an ambiguous ask gets the room's own "which one"
question back, never a guess. `m` on a saved prompt, in the panel or in the room's list,
stages its text into the room's message box as an editable draft; your ↵ is the only
send. `s` on a prompt that carries a refinement sends the refined text to the composer
(the room closes onto it); the selected refined line advertises exactly that. esc
from the list closes the room (a running turn keeps thinking); while Minerva is working,
one esc at the composer only arms — esc·esc interrupts her; esc on an idle composer steps
back to the list with the draft kept.

The **project notepad** stays underneath, as a file: `/note <text>` captures into the
per-project journal and its `notepad.md` mirror under the Mercury config home — never
inside the repo tree — so notes are private by construction and survive `/clear`.
`/minerva <msg>` still turns a line into note operations on that journal, and the opt-in
boot pass still curates it. The room offers no note-leaving; earlier notes stay readable
in their plain file, and the room points at it.

## Gates

All three gates are read live on every call — a gate that latches env at import lies
after a live authority toggle:

- `MERCURY_TABULA` — default on; `=0` is the only off switch. Off means the store,
  all three commands, the board, and the rail card are absent, byte-identically.
- `MERCURY_TABULA_MINERVA` — default off, explicit opt-in. Arming it is the billing
  consent for the boot-time curator pass (the boot-menu row); it rides the master
  gate, so a tabula kill silences the curator too.
- `MERCURY_TABULA_DIR` — store-root override, the hermetic seam an
  embedder pins so a live operator store is never touched.

## The store

The store root is `<config-home>/tabula/`, with one directory per project, named by
the same folder slug the transcript directory uses. Inside each project directory:

- `journal.jsonl` is the single source of truth. Every mutation — operator or
  Minerva — is an appended event; nothing ever rewrites history. Two concurrent
  sessions append safely (one append per batch), and a torn tail from a crash
  mid-append is skipped line by line, never fatal.
- `notepad.md` is a derived, human-readable view: always rebuildable from the
  journal, atomically written (tmp+rename), stamped from the latest event time rather
  than the wall clock, so materialization is byte-deterministic.
- `history/` archives the prior `notepad.md` before every Minerva apply, bounded with
  the newest kept, so the operator can always see what the curator changed.
- `meta.json` records curator runs, including refused plans.

Notes carry a priority from the closed set `now | next | later`. Folding the journal
into the notepad gives add/edit/pri/done/del their meaning, dedupes re-adds, and appends unknown ids in
order events rather than dropping them. Every read path degrades to empty-with-reason.

## Commands

All three commands are interactive-only and gated on the master gate:

- `/note <text>` — one-keypress capture: zero model turns, an appended journal event,
  and a re-materialized notepad.
- `/tabula` — Minerva's room, above.
- `/minerva <message>` — the notepad chat without opening the room: one billed
  curator call per invocation (typing the command is the consent); Minerva turns the
  message into structured note operations — add, done, pri, refine — never delete.

`/note` and `/minerva` are user-private: the line acts on the screen and never enters
the session's conversation, on any seat ([TRUST.md](TRUST.md) states the law). The
lanes rail keeps a glance at the notepad's top open notes; ↵ there opens the room.

## Minerva — the curator

One engine sits behind every curator surface. Its rails:

- The boot pass runs at most once per boot, only when: opted in, notes exist, the
  journal advanced since the last run, and the session is interactive — never a `-p`
  run, never a daemon worker. It is fire-and-forget in
  the background; boot never blocks on it.
- Output is held to a strict JSON schema and then post-validated
  deterministically: a plan that references mostly invented ids,
  oversteps enum bounds, or blows length caps is refused — the naive materialization
  stands and the refusal is recorded in `meta.json`, never silent.
- Note text is user data, never instructions: the prompt wraps notes in data tags and
  the system prompt pins the injection rail. Minerva has no tools — the worst case is
  a rejected plan, never an action.
- Minerva never owns truth: every run re-reads the raw journal fold; its plan lands as
  ordinary events; a `refine` event carries the `baseHash` of the text it refined, and
  the fold skips a refinement whose base no longer matches, so a stale suggestion can
  never shadow an operator edit. Original text is never overwritten — refined text
  renders beside it.
- Input is capped (elision is done-first, then the oldest `later` items, with an
  honest count in the prompt); a refined line is a one-line polish with a hard
  character cap.

Two further surfaces ride the same engine:

- The cockpit ask line: a mini-REPL under the
  lanes rail's tabula section. Usage honesty is its invariant — the store cannot
  construct an API request; the injected runner fires exactly once per explicit enter
  and never otherwise, one exchange in flight, abort rewinds the buffer and stops the
  stream.
- The staged refined-draft handoff: Minerva
  refines, the operator dispatches. A refinement stages original and refined text side
  by side and never dispatches or completes anything by itself; each staged draft
  mints its own conversation id; dismissing a draft touches only the draft.

## The sub-model containers

Two sub-model containers exist — standing side
surfaces that take their own model:

- `minerva` — the notepad curator (both runners resolve through it at every call);
- `console` — the Helm side-question fork.

The choice is the operator's. Resolution runs the per-axis precedence law: **env pin >
saved pick > unset**. The env pins are registered flags (`MERCURY_MINERVA_MODEL`,
`MERCURY_CONSOLE_MODEL`). No default derives: a container nobody pinned is *unset*, and
messaging it spends no model call — the reply is exactly the line
`use /submodels to pin one of the available model catalogues`, painted where the answer
would be (the console overlay and rail, the Minerva ask line, the board's chip, the
`/minerva` line). A saved pick persists across sessions. Ids are canonicalized (aliases
resolved, the context-window tag folded — the window is a call-time flavor, never a
second identity), and nothing in the module re-spells a model id or family name: rows
come from the model options catalogue, families and display names from the routing law,
sign-in facts from the provider presence enumeration.

The harness stamps the **engine identity** into both containers' prompts: the resolved
model id and wire ride the prompt as a fact line, beside each
container's **role statement** — the console answers questions about the session and the
project from the shared context and never claims the main agent's work as its own;
Minerva curates the notepad and nothing else — so "what model are you" and "what is your
job" are answered from facts, never guessed. The console's identity and role ride the
question's framing (the user turn), never the system prompt: the fork keeps the main
agent's system prompt and context byte-identical, so a pick identical to the main model
keeps the cache-hit prefix.

`/submodels` is the picker: both containers offer the **full catalogue the main `/model`
picker offers — every family, carriers included** — as ONE row set; no container applies
a tier, a serve check, or a family policy. Row states are typed, never a silent filter:
selectable; signed-out (activating the row routes to the family's attach home and the
pick lands on return); refused (the owning catalogue's reason verbatim). A saved pick is
validated at write against the live catalogue; at dispatch the resolved id routes to its
own provider runtime, whose refusals stay the honest surface — a credential that later
disappears is reported by the runtime, never silently substituted away. A wire that
carries no schema-forced output format still serves Minerva: its plans are prompted as
JSON (both prompts spell the exact shape), decoded tolerantly and post-validated
deterministically; an undecodable answer degrades typed with the model named.

Each container also carries its own **effort**. `e` on a model row opens the effort
strip (the main picker's strip, one look) listing only the levels the one effort owner
says that model offers under the container's own call context: a model with no effort
control answers a one-line receipt and opens nothing, and Minerva calls with thinking
off, so a model whose effort dial is its reasoning dial answers the same way there. `↵`
saves the level for that container (`subModels.effort`), `esc` keeps what was there,
and the row reads `runs @high (chosen)` against `runs @medium (the model default)`.
The container's calls carry exactly that level; a model pick that lacks the level runs
the model default and says so in its receipt — the wire never carries a level the model
does not offer.

