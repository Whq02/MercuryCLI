# Samples

A sample is a page the model draws for you and keeps: a design at true
size, a report to read, a comparison, a small interactive page. The model
makes one only when you ask to see something — "show me", "mock this up",
"draw the page", "give me a report I can look at" — never on its own, never
as a hedge, never to decorate an answer. Each sample is kept per session,
versioned, and opens again whenever you like.

## Where a sample comes from

The model draws the page in a Workshop cell and keeps it with
`mercury.sample({ name, title?, html })` ([WORKSHOP.md](WORKSHOP.md)). The
page's data stays in the cell, so a redraw is a small edit, and every
redraw is the next version of the same sample: the same name appends a
version and never makes a second sample. The cell's result names each
sample it kept — its title, its version, its address — and the words of
yours it answered.

## Where it lives

Under the session in the config home, never in your project:

    <config-home>/sessions/<session>/samples/<id>/
      sample.json        the record: name, title, state, versions
      v1.html, v2.html   each version, the model's HTML as written
      marks-v2.json      the marks you left on that version

Nothing is hosted and nothing leaves the machine. The page is served to
your browser by a listener on 127.0.0.1 that exists only while the
session's process runs, on a port chosen fresh each time; every address
carries a token made once per session process and never written to disk,
and a request without it answers 404. The page loads no remote script or
font.

## Opening a sample

In the full layout a sample takes a berth in the SESSIONS bar beside this
session — its mark, the name the model gave it and its version — and a
click opens it in your browser. In the compact layout the line under the
composer counts the session's samples (`· 1 sample`), and the detail view
that line opens lists them; Enter on one opens it. `/samples` lists the
session's samples, newest first — the name, `v<N>`, the state and when it
last changed — and Enter opens the one you pick, esc returns. A new sample
or a new version shows up on its own: the session's runner relays its
samples with the rest of its facts. The page shows the sample's versions
with a switcher; while the tab is open it refreshes as the model redraws.

## Marks

On the page you click a spot and write a comment, add a note for the whole
page, and approve or ask for changes. "Send marks to Mercury" delivers
them into the session as one message, as if you had typed it:

    Marks on Landing page v2: 2 pins · 1 note · changes needed
    - at button#buy "Buy now": make it larger
    - at h1: shorten the headline

    Tighten the whole top half.

The model answers it in its next turn; if a turn is running, the message
waits the way any typed message does. The verdict moves the sample's
state — approved, changes needed — and a new version opens it again.

## When no port can be bound

A session that cannot open a loopback port writes the page beside the
version as a self-contained file (`v<N>.page.html`, every version inlined)
and opens that instead. Its send button reads "Copy for Mercury" and puts
the same message text on the clipboard for you to paste into the composer.

## The switch

`MERCURY_SAMPLES` is on by default. `=0` removes `mercury.sample` from the
Workshop bridge, the listener and `/samples`; the Workshop tool's prompt
loses its line about samples, and nothing else changes.
