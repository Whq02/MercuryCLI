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

Each sample is a row under the composer with its own mark and the name the
model gave it; Enter opens it in your browser. `/samples` lists the
session's samples, newest first — `title · v<N> · state` — and Enter opens
the one you pick.

The page is served to this machine only, in the website's own language:
a bar with the sample's name, its state and a version switcher (← and →
move between versions), the page itself below in a frame that keeps it
exactly as the model wrote it, and a foot for your note. Code shows the
version's HTML read-only, Copy puts it on the clipboard, Download saves it
as `<name>-v<N>.html`. While the tab is open the page refreshes on its own
as the model redraws: the new version joins the switcher and, if you were
on the newest, the frame moves to it. `?` shows the keys.

## Marks

Edit with Mercury (the `m` key) turns marks on. Click a spot on the page:
a numbered pin lands there and a small box takes your comment — Enter
keeps it, Esc removes the pin. Pins can be dragged, reopened and removed;
each remembers the element under it (its tag, id, class and first words).
The note at the foot is for the whole page; Approve and Changes needed
are optional. "Send marks to Mercury" (the `s` key) delivers everything
into the session as one message, as if you had typed it:

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
