# Samples

A sample is a versioned HTML page the model draws in an Eval cell when you ask
to see a design, report or comparison, served locally to your browser for
pinned comments.

Samples are off by default: turn on the Boot Menu's `Samples`
row or set `MERCURY_SAMPLES=1` for new sessions ([the switch](#the-switch)).

## Where a sample comes from

The model creates a sample only when you ask to see something ("show me",
"mock this up", "draw the page", "give me a report I can look at") by calling
`sample({ name, title?, html, ask? })` inside an Eval cell ([EVAL.md](EVAL.md)).
Reusing `name` appends a new version (`v2`, `v3`) to the same sample so cell
data stays in memory across edits. The cell result reports the sample's title,
version, local URL and the request it answered.

`/memory page` saves its own sample showing the project's memory library as an
interactive graph ([MNEME.md](MNEME.md)), adding a new version on each run.

## Where it lives

Samples live under the session in the config home, outside your repository:

    <config-home>/sessions/<session>/samples/<id>/
      sample.json        record: name, title, state, versions
      v1.html, v2.html   each version's HTML as written
      marks-v2.json      pins and notes saved on that version

While the session process runs, a loopback server on `127.0.0.1` serves the
page on an ephemeral port using a per-process token kept in memory (requests
without the token return 404). The page loads no remote scripts or fonts. When
a loopback port cannot be bound, Mercury writes a self-contained
`v<N>.page.html` file with all versions inlined and opens that file instead;
its send action copies the formatted feedback to your clipboard ("Copy for
Mercury").

## Opening a sample and leaving marks

When samples exist, the status row (or the compact line under the composer)
shows `· N sample(s)`. `/samples` lists the session's samples newest first with
name, `v<N>`, state and last-modified time; `↵` opens the selected sample and
`esc` returns. The browser bar provides a version switcher (`←` and `→`),
read-only `Code`, `Copy`, `Download` (`<name>-v<N>.html`), and `?` for
shortcuts; open tabs auto-refresh when the model writes a new version.

Press `m` (**Edit with Mercury**) to place numbered comment pins anywhere on
the page (`↵` saves a pin's comment, `Esc` removes it; pins can be dragged or
reopened and record the target element's tag, id, class and opening words). Add
an optional page note and verdict (**Approve** or **Changes needed**) at the
foot, then press `s` (**Send marks to Mercury**) to queue one message into the
session:

    Marks on Landing page v2: 2 pins · 1 note · changes needed
    - at button#buy "Buy now": make it larger
    - at h1: shorten the headline

    Tighten the whole top half.

## The switch

With Samples off, `sample()` in an Eval cell refuses, no loopback listener
starts, and `/samples` reports that `/samples` is off and `MERCURY_SAMPLES=1`
turns it on (or the Boot Menu's `Samples` row saves it for new sessions).
`mercury health` and `/health` report the switch state on the `Samples` row.
