# MCPs & Skills

What a session loads — its MCP servers, its skills, its extensions — is a
per-repository choice with one editing surface: the Boot face's **MCPs &
Skills** row (⊛). The choice is recorded as deviations from "everything on",
resolved into a **kit** at each session's birth, and worn by that session for
its whole life: in-session toggles are the session's own dials and touch no
record. Flip a switch on the menu, start a session, and it obeys.

## The menu

↵ on the Boot face's MCPs & Skills row opens the menu — the same three-panel
frame as the boot menu, with a NEXT SESSION summary counting what the next
session actually gets. Two sections:

- **MCP** — every configured server, by its resolved name (`ext:<extension>:
  <server>` for extension-shipped ones), each `on ⇄ off`. Mercury's own
  built-in organs are never listed.
- **Skills** — every discoverable skill, tri-state: `on` is ambient (the
  agent can reach for it), `invocable` is listed but loads only when you
  `/name` it, `off` is absent from the next session. An extension's **master
  row** sits above its items in each section it contributes to; items under
  an off master read `off (extension)` and keep their own state underneath.
  Skills that arrive from a connected MCP server appear once a session
  connects them, so the face lists none.

Every state is a word, absence means on, and every toggle commits to the
record at once — the legend reads `↑↓ move · ↵ change (saved) · ⌫ default ·
p save as preset… · w presets… · esc back`. The rows enumerate through the
same doors the runner reads, so the
menu can never advertise a member the session would not see.

## The record and the kit

The record is the workspace's slice of the project config — `skillStates`,
`extensionStates`, and the disabled-servers record, deviations only. At a
session's birth the deltas resolve
against the live roster into the session's **kit** — a closed membership,
validated on the wire, stamped on the session's durable record, and carried
into the session process. Two roads feed a birth, one record
behind both: the menu screen carries the freshly-resolved kit for the very
next birth (so an edit one keystroke before New Session is never lost to a
stale cache), and every other birth — a coordinator launch, another
terminal — derives from the record at the admission. Launch receipts name
the road: `kit carried`, `kit derived`, or `kit preset`.

The kit follows the session everywhere: the warm runner standing behind
New Session already wears the next birth's kit, so a menu edit costs
exactly one cold spawn before the pool is warm again; a resumed or
reactivated session is re-stamped from the record with a `kit-restamp`
receipt naming what was displaced; a transcript resumed with no record says
so loudly on the same receipt road. An extension is live for a session only
when both agree: its installed switch AND its per-repository master row. A kit
narrows only the session it was stamped on — teammates, the daemon, and
every non-session process are untouchable by construction.

## Presets

`p` on the menu saves the current deviations as a named **preset** — up to
200, stored globally, so a "writing kit" travels across repositories. `w`
opens the saved roster: `↑↓ move · ↵ wear next session · ⌫ delete · esc
back`.

Wearing a preset arms a one-shot: the Boot face's kit row reads
`next: preset '<name>'`, the next birth consumes it, and the menu's own
default resumes afterwards — ↵ on the armed row disarms it. Resuming a dead
transcript while armed wears the preset (you armed it, then picked the
session); hopping into a live session never spends it. The coordinator can
launch a session wearing one by name — the receipt reads `wearing preset
'<name>'` — and an unknown name is a typed refusal naming the saved roster.

A preset's deltas resolve against whatever repository wears it: a named
skill or extension the preset turns off stays off **by name** — it bites a
member that arrives later — while an MCP server the preset excludes is
simply absent from the closed membership, and deltas naming members the
repository lacks are counted in the wear receipt rather than silently
dropped.

## In-session dials

Inside a session, `/mcp` and `/skills` are that session's own dials —
session-scoped and ephemeral, writing no config file anywhere. The panels
say so in their own words: "this screen's servers — sessions carry their
own; the boot menu sets the next session's", "this session's skills — the boot
menu sets the next session's". Skills cycle the same
tri-state; servers toggle on ⇄ off; Mercury's own organs answer a typed
exemption. A dial turned mid-turn queues whole — "Queued — the dials apply
when this turn ends" — and applies at the turn's end, so a record can never
say off over a process still holding the member. Each applied dial lands a `kit-dial` receipt
on the session. The per-repository record has exactly one writer: the menu.

