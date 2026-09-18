# Workshop — persistent code cells

`Workshop` runs code in cells whose state survives across calls: the model
writes a cell, reads the result, and the next cell continues from the same
live state — a real workbench instead of a chain of one-shot scripts.

## Languages and runtimes

Three languages: `js`, `ts`, and `py`. JS and TS cells run in a
state-holding VM context with top-level await; TS transpiles with the
workspace's own TypeScript, and a workspace that cannot transpile refuses
honestly.
Python cells ride a persistent `python3` kernel; a machine with no usable
interpreter answers that plainly instead of pretending.

## The state model

A runtime is owner-scoped: one per conversation owner, per language. Cells
share state across calls; `reset: true` starts fresh explicitly. A timeout
or cancellation kills the worker and REPORTS the state loss — the result
carries the runtime generation, which bumps on every kill or reset, so a
cell can never silently continue from a state that is gone. Python
cancellation is interrupt-first: state is retained when the interpreter
can be interrupted, and only an unresponsive kernel is killed (escalation
is bounded). Closing the owning conversation reaps its workers.

## Results

A cell's result carries its completion value (bounded preview), captured
output as a bounded tail (the full stream spills to an artifact when it
overflows), and any `mercury.display()` items the cell emitted — text,
json, markdown, tables, or refs.

A failed cell's result names the error first and then only the cell's own
lines: a thrown error reads as its name and message followed by the frames
inside the cell (and inside any local module it required), never the
runtime's own plumbing. A bridge call that fails names the call — its
ordinal within the cell and the tool — carries that tool's own words, says
the cell stopped at that call, and points at the cell line that made it; a
cell that catches the rejection continues. A cell that does not parse
reports the syntax error with its line and column, an excerpt of the source
around that position and a caret under it, never an echo of the whole cell.
Every error text is bounded, with the message kept ahead of the bound.

In the chat, a cell's row paints its state, id, duration and generation,
the first line of its error, the first line of its value and the last four
output lines (every line under ctrl+o). A failed or timed-out cell's row
opens a card, the way a shell's row in the background board opens its own:
click the row or type `/tasks <cell id>` (the row says so on its last
line). The card carries the cell's language and title, its code, the whole
error, the output tail with a count of the lines shown, the duration, the
generation and the runtime-killed fact; on a short window the code is
clipped first so the error stays visible, and the output section folds into
a count on the state line when it has no room. `esc` closes the card, `←`
returns to the board. The card reads the cell's own row in the transcript,
so it stands for the cells this session painted; a succeeded cell opens no
card.

## The mercury.* bridge

Cells can reach Mercury itself: `mercury.inspect`, `mercury.tool`, and
`mercury.agent` route through the real tool transaction and permission
path — a cell asking to edit a file meets exactly the consent an Edit
would. Parallel and pipelined calls work in-cell; a cell invoking Workshop
recursively is refused.

With samples switched on ([SAMPLES.md](SAMPLES.md); off by default),
`mercury.sample({ name, title?, html })` keeps a page the operator asked to
see as a sample: a versioned, re-openable page under the session that opens
in the browser and takes the operator's marks back into the session. The
model makes one only when asked to show something; the same name publishes
the next version, and the page's data stays in the cell so a redraw is a
small edit.

## Gate

`MERCURY_WORKSHOP` (default-on). `=0` removes the tool and no runtime ever
spawns — the catalog is byte-identical to a build without it.

`MERCURY_SAMPLES` (opt-in, off by default). The Boot Menu's `Samples` row or
`=1` turns on `mercury.sample`, the loopback listener and the `/samples`
command for new sessions; off, the tool's prompt has no line about samples.
