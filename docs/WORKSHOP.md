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

## The mercury.* bridge

Cells can reach Mercury itself: `mercury.inspect`, `mercury.tool`, and
`mercury.agent` route through the real tool transaction and permission
path — a cell asking to edit a file meets exactly the consent an Edit
would. Parallel and pipelined calls work in-cell; a cell invoking Workshop
recursively is refused.

## Gate

`MERCURY_WORKSHOP` (default-on). `=0` removes the tool and no runtime ever
spawns — the catalog is byte-identical to a build without it.
