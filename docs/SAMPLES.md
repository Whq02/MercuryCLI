# Samples

A sample is a versioned page the model keeps from an Eval cell when you ask
to see a design, report or comparison, served locally to your browser for
pinned comments. The model supplies the content as typed blocks; Mercury
draws the page.

The model makes one only when you ask to see something ("show me",
"mock this up", "draw the page", "give me a report I can look at"),
never on its own, never as a hedge, never to decorate an answer. Each sample is
kept per session, versioned, and opens again whenever you like. Samples are off
by default: the Boot Menu's `Samples` row or `MERCURY_SAMPLES=1` turns them on
for new sessions ([the switch](#the-switch)).

## Where a sample comes from

The model writes the page's parts in an Eval cell and keeps them with
`sample({ name, title?, doc, ask? })` ([EVAL.md](EVAL.md)). `doc` is the
document: `{ subtitle?, meta?, verdict?, parts: [...] }`, where every part is
one of the nine blocks below. Mercury renders the document into one
self-contained HTML page and keeps that page as the version. The data stays
in the cell, so a redraw is a small edit, and every redraw is the next version
of the same sample: the same name appends a version and never makes a second
sample. The cell's result names each sample it kept (its title, its version,
its address) and the words of yours it answered.

Raw `html` from a model is refused with a teaching error that names `doc`; a
model never writes markup or styles. `/memory page` keeps one sample of its
own through the product's own `html` road: the memory library drawn as a page
([MNEME.md](MNEME.md)). Each `/memory page` keeps its next version.

## The nine blocks

| Block | Fields | What it draws |
| :-- | :-- | :-- |
| `verdict` | `status?` (`approved`, `changes-needed`, `warning`, `info`, `halted`; default `info`), `label?`, `summary`, `detail?` | The bottom line under the title: a well with a rule in the status colour and a stamp; it folds into a strip at the top of the window once it scrolls away. A top-level `doc.verdict: "…"` makes one with status `info` |
| `section` | `heading?`, `numeral?`, `prose?` (text or a list; a string splits on blank lines), `items?`, `note?` | Paragraphs in the reading serif, bullets, one aside. Backticks become `code`, `**bold**` becomes bold; nothing else is markup |
| `cards` | `heading?`, `columns?` (2, 3 or 4), `items: [{ label?, value?, title?, body?, tone? }]` | A grid of facts on shared hairlines: a small-cap label, a figure, a line of explanation. `tone` (`ok`, `warn`, `danger`, `accent`) colours the label only |
| `table` | `heading?`, `columns?`, `rows` (arrays of cells, or objects whose keys name the columns), `caption?` | A table on the page itself. A cell is text or `{ text, tone }`; a plain cell beginning `PASS`, `OK`, `DONE`, `VERIFIED` is toned green, `FAIL`, `BLOCKER`, `DEFECT`, `MAJOR`, `ERROR` red, `WARN`, `MINOR`, `PENDING`, `POLISH` amber; a `path.ext` or `path.ext:line` is set in monospace. Over eight rows the header sticks |
| `diff` | `heading?`, `before`, `after` (each a string of code, or `{ label?, meta?, start?, code }`), `caption?` | Two terminal windows side by side; the changed lines are found by comparing the two (a model never tones them by hand). `Unified view` stacks them (the default when a line passes 72 characters); `Copy after` copies the new code without line numbers |
| `terminal` | `heading?`, `title?`, `command?`, `lines` (a string or a list of text or `{ text, tone }`), `caption?` | One terminal window: the command after a `$`, numbered lines, `Copy`. Lines beginning `[PASS]`, `✓`, `+ ` read green, `[FAIL]`, `×`, `- `, `ERROR` red, `#`, `RUN `, `>>>`, `──` dim; over thirty lines fold behind `Show all` |
| `figure` | `heading?`, `steps?` (labels, or `{ label, detail?, meta? }`), `svg?`, `src?` (a `data:image/…` URI), `alt?`, `caption?` | `steps` draws a flow with the arrows laid out for the model; `svg` is inlined after its scripts, event handlers and remote references are stripped; a remote `src` is dropped |
| `checklist` | `heading?`, `items` (`"[x] …"`, `"[ ] …"`, `"[!] …"`, `"[-] …"`, or `{ text, state?, detail? }`) | Hairline rows with one sigil each: `✓` done, `○` pending, `×` failed, `—` skipped |
| `question` | `heading`, `prompt?`, `options` (labels, or `{ label, description?, recommended? }`) | Your decision: square option buttons with no option chosen in advance (a model may mark one `Recommended`). A click stages `Decision (<heading>): <option>` in the note under the page and `s` sends it; opened on its own, `Copy decision` puts the same line on the clipboard |

Blocks with a heading are numbered I, II, III … in order (`numeral: ""`
suppresses one); three or more headed blocks get an outline under the title.
The renderer takes `kind` or `type`, hyphen or underscore, and a few
synonyms (`before-after` is `diff`, `code` and `log` are `terminal`,
`checks` is `checklist`, `decision` is `question`); a block it cannot place,
or a field it cannot read, is refused with the field named, and nothing is
kept.

## The two surfaces

Every page opens on the dark surface, in the website's own register: the
blue-black ground, bone headings, the steel-blue accent, square corners, a
field of dim glyphs in the flanks and the pixel helmet at the top. The
`Parchment` button at the top right turns the page to aged paper with
dark-brown ink and sepia hairlines; the choice is remembered for the session,
and parchment is also what prints. Code, diff and terminal blocks are
terminal windows, green phosphor on near-black, on both surfaces. The page
loads no remote font, script or image.

Inside the page `j` and `k` scroll, `1`–`9` jump to a numbered block, and
the viewer's own keys (`m`, `s`, `c`, `?`, `←`, `→`) work from inside it.

## Where it lives

Under the session in the config home, never in your project:

    <config-home>/sessions/<session>/samples/<id>/
      sample.json        the record: name, title, state, versions
      v1.html, v2.html   each version, the page Mercury rendered
      marks-v2.json      the marks you left on that version

Nothing is hosted and nothing leaves the machine. The page is served to
your browser by a listener on 127.0.0.1 that exists only while the
session's process runs, on a port chosen fresh each time; every address
carries a token made once per session process and never written to disk,
and a request without it answers 404. The page loads no remote script or
font.

## Opening a sample

In the full layout the status row under the view counts the session's
samples (`· 1 sample`) after the model and its effort, and `/samples` is the
road to them. In the compact layout the line under the
composer counts the session's samples (`· 1 sample`), and the detail view
that line opens lists them; Enter on one opens it. `/samples` lists the
session's samples, newest first (the name, `v<N>`, the state and when it
last changed), and Enter opens the one you pick while `esc` returns. A new sample
or a new version shows up on its own: the session's runner relays its
samples with the rest of its facts. The page shows the sample's versions
with a switcher; while the tab is open it refreshes as the model redraws.

The page is served locally only, in the website's own palette: a dark
bar with the sample's name, its state and a version switcher (← and →
move between versions), the rendered page below in a frame, and a dark
foot for your note; a parchment page sits in the same dark frame. Code
shows the version's HTML read-only, Copy puts it on the clipboard, Download
saves it as `<name>-v<N>.html`. While the tab is open the page refreshes
on its own as the model redraws: the new version joins the switcher and, if
you were on the newest, the frame moves to it. `?` shows the keys.

## Marks

Edit with Mercury (the `m` key) turns marks on. Click a spot on the page:
a numbered pin lands there and a small box takes your comment (Enter
keeps it, Esc removes the pin). Pins can be dragged, reopened and removed;
each remembers the element under it (its tag, id, class and first words).
Every part of a rendered page carries a stable id (`part-3-diff`,
`part-3-a-2` for a line of its after pane, `part-4-row-2` for a table row,
`part-8-item-3` for a checklist item), so a pin names the block, row,
line or option it landed on, and the same id means the same place in the
next version. The note at the foot is for the whole page; Approve and
Changes needed are optional. "Send marks to Mercury" (the `s` key) delivers
everything into the session as one message, as if you had typed it:

    Marks on Landing page v2: 2 pins · 1 note · changes needed
    - at td#part-4-cell-2-2.table-cell.cell-ok "PASS": name the test
    - at h2#part-2-heading.section-title "Cause": shorten the headline

    Tighten the whole top half.

A click on a `question` block's option stages `Decision (<heading>):
<option>` in the note, so `s` sends your choice the same way.

The model answers it in its next turn; if a turn is running, the message
waits the way any typed message does. The verdict moves the sample's
state (`approved`, `changes needed`), and a new version opens it again.

## When no port can be bound

A session that cannot open a loopback port writes the page beside the
version as a self-contained file (`v<N>.page.html`, every version inlined)
and opens that instead. Its send button reads "Copy for Mercury" and puts
the same message text on the clipboard for you to paste into the composer.

## The switch

Samples are off by default. Turn the Boot Menu's `Samples` row on (the
change reaches new sessions) or set `MERCURY_SAMPLES=1` in the environment
before the session starts. Off, `sample()` in an Eval cell refuses, no
listener starts and `/samples` is unavailable; the Eval tool's prompt has no
line about samples, and nothing else changes. Typed while off, `/samples`
answers one line (`/samples is off — MERCURY_SAMPLES=1 turns it on (the
Boot Menu's Samples row saves it for new sessions)`) and starts nothing.
`mercury health` and `/health` carry a `Samples` row that says which way
the switch stands.
