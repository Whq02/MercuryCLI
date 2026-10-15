# MCPs & Skills

MCPs & Skills saves your per-repository selection of MCP servers, skills, and
extensions on the home screen's **MCPs & Skills** row (⊛). The choice is
recorded as deviations from "everything on" and resolved into a **kit** when each
new session starts. Inside a running session, `/mcp` and `/skills` toggle
servers and skills for that session only without changing your saved defaults.
Flip a switch on the menu, start a session, and it loads that selection.

## The menu

Pressing `Enter` on the home screen's MCPs & Skills row opens the menu: the same
three-panel frame as the Boot Menu, with a NEXT SESSION summary counting what
the next session loads. Two sections:

- **MCP**: configured servers, extension servers and eligible account
  connectors, by their resolved names (`ext:<extension>:<server>` for
  extension-shipped ones), each `on ⇄ off`. Session-only servers, including
  Mercury's built-in `mercury` server, are not listed here.
- **Skills**: user, project, managed and extension skills, tri-state: `on`
  is ambient (the agent can reach for it), `invocable` is listed but loads only when you `/name` it, `off` is
  absent from the next session. An extension's **master row** sits above its
  items in each section it contributes to; items under an off master read
  `off (extension)` and keep their own state underneath. Bundled skills load
  in sessions but are not listed here. Skills supplied by an MCP server are
  available once a session connects that server; the home screen menu does not list them.

The empty states say **no added MCPs** or **no added skills**. They
refer to this menu's inventory of added items. The NEXT
SESSION counts likewise cover the listed entries, leaving built-in capabilities out of the count.

Every state is a word, absence means on, and every toggle saves to the
record at once (`↑↓ move · ↵ change (saved) · ⌫ default ·
p save as preset… · w presets… · esc back`). The rows enumerate through the
same resolvers the runner reads, so the
menu lists the exact items the session sees.

## The record and the kit

The record is the workspace's slice of the project config (`skillStates`,
`extensionStates`, and the disabled-servers record, deviations only). When a
new session starts, the deltas resolve
against the live roster into the session's **kit**: a closed membership,
validated and stamped on the session's durable record, and passed
into the session process. Two paths feed a new session from the same record:
the menu screen passes the freshly resolved kit to the very
next session you start from the home screen (so an edit one keystroke before New Session is never lost to a
stale cache), and every other session launch (from the coordinator or another
terminal) derives the kit from the saved record at launch. Launch receipts name
the path: `kit carried`, `kit derived`, or `kit preset`.

The kit stays with the session: the pre-warmed runner behind
New Session already holds the next session's kit, so a menu edit costs
one cold spawn before the pool is warm again; a resumed or
reactivated session is re-stamped from the record with a `kit-restamp`
receipt naming what changed; a transcript resumed with no record reports
that on the same receipt channel. An extension is active for a session only
when both its installed switch and its per-repository master row are on. A kit
applies only to the session it was stamped on; crewmates, the daemon, and
non-session processes are unaffected.

## Presets

Pressing `p` on the menu saves the current deviations as a named **preset** (up to
200, stored globally, so a preset travels across repositories). Pressing `w`
opens the saved roster (`↑↓ move · ↵ wear next session · ⌫ delete · esc
back`).

Selecting a preset arms it for one session: the home screen's MCPs & Skills row reads
`next: preset '<name>'`, the next session you start uses it, and the menu's saved
default resumes afterwards (press `Enter` on the armed row to clear it). Resuming a stopped
transcript while a preset is armed applies the preset to that resumed session; switching into a running session leaves the armed preset untouched for the next new session. The coordinator can
launch a session with a preset by name (the receipt reads `wearing preset
'<name>'`), and an unknown name is refused with the list of saved presets.

A preset's deltas resolve against the repository where the session starts: a named
skill or extension the preset turns off stays off **by name** (including one
installed later), while an MCP server the preset excludes is
left out of the session's server list, and deltas naming items the
repository does not have are counted in the receipt instead of being dropped silently.

## In-session toggles

Inside a running session, `/mcp` and `/skills` toggle servers and skills for that
session only, without writing to any config file. The panels
state that scope directly: `"this screen's servers — sessions carry their
own; the boot menu sets the next session's"` and `"this session's skills — the boot
menu sets the next session's"`. Skills cycle the same
tri-state, and servers toggle `on ⇄ off`. Built-in Mercury servers cannot be turned off.
A change made during a running turn is queued (`"Queued — the dials apply
when this turn ends."`) and takes effect when the turn finishes. Each applied change writes a `kit-dial` receipt
on the session. The per-repository record is written only from the home screen menu.

