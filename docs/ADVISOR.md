# The advisor: a second model that advises the working model

The advisor is a second model that reads the working model's conversation on
a cadence and writes it one short note — what it may be missing, a course
correction, what to verify before going on. It advises the model, not you:
its notes land in the agent's context as muted rows marked `[advisor]`,
greyed like the `[Saturn]` rows, and are never addressed to the operator.
The agent can also ask it a question between notes. It is Anthropic's advisor
tool generalised to any model, any provider, local included, on the main
chat, on crewmates and on workflow workers, with a memory of its own.

It is off by default.

## Turning it on

Three settings, two doors.

- **`/config` → Advisor** — on or off. Off, nothing is written and nothing is
  sent.
- **`/config` → Advisor interval** — how many of the agent's turns pass
  between notes: 5 · 10 · 20 · 50 (10 by default; the floor is 1).
- **`/submodels` → ADVISOR** — the advisor's model, picked from the same live
  catalogue the main `/model` picker offers: every signed-in family's models
  and the local catalogue, carriers included. `tab` moves between the CONSOLE
  and ADVISOR containers; `↵` pins a row; `e` sets the container's own effort.
  `MERCURY_ADVISOR_MODEL` pins it from the environment and locks the picker.

Any pairing works either way round: a local Qwen advised by Fable, Astra
advised by Fable, Fable advised by Astra, Qwen advised by Astra. The advisor
model may be the same family as the agent or any other. With the advisor on
but no model pinned, the advisor stays silent. A signed-out or refused model
never lands an error in the agent's context: on the main chat the round shows
as a muted `[advisor]` row that says the advisor had nothing to say this
round and why, addressed to you, never to the model.

## What the agent sees

Every `interval` turns of the agent — an operator turn on the main chat, a
tool round for a crewmate or a workflow worker — the advisor is shown the new
rows of the agent's conversation since its last look (the operator's lines,
the agent's replies, its tool calls with their results clipped; never the
system prompt) beside its own earlier notes, and asked for one note of at
most eight lines, addressed to the agent. The note lands in the agent's
context as a user row with the advisor's provenance:

```
10:00:04 [advisor] · claude-opus-4-8 · every 5 turns
  You have not run the pin on the base yet.
  Run it on 89017923b before you edit, and keep what it prints.
```

On the main chat the note waits for the next turn — it is never dropped into
a running turn. On a crewmate or a worker it arrives at the next tool-round
boundary, framed for the model as advice from a second model, never as a
message from the operator. An advisor that has nothing to say answers
`carry on`, and nothing lands.

The advisor thinks as deeply as its effort dial asks before it writes, and
the call has room for that thinking and the note — a question that needs
thought is answered with words, not cut short. An answer that comes back
with no text is asked for once more; if the advisor still has nothing, the
main chat shows a muted `[advisor]` row saying so — never silence, and never
a turn for the model:

```
10:00:04 [advisor] · claude-opus-5-5 · every 5 turns
  had nothing to say this round — answered with no text, twice
```

## Asking the advisor

While the advisor is on, the agent has one more tool, `AskAdvisor`, with one
input: a question. The advisor answers with the same view — its memory of
the conversation, the rows since its last look, and the question — in at
most eight lines. Crewmates and workers have the tool too. The reply is
advice from a model, never an instruction from the operator, and never an
approval of anything.

## Its own memory, its own clock

The advisor keeps its own context per advised agent: the digests it was
shown and the notes it wrote, on disk beside the agent's transcript under
`<session>/advisor/<agent id>.jsonl`, so a resumed session finds it. That
context compacts on its own clock — the gauge is the advisor model's context
window, never the agent's — so a 256k agent with a 1M advisor never compacts
both at once, and the smaller model gains the longer memory: when the
agent's context folds, the advisor still remembers what came before.

## What it costs

Every call the advisor makes is counted under its own workload. `/usage`
shows it as a second line in each family's session slot, beneath the
session's own figure and the scheduled work's:

```
This session: 1,890 input · 94 output tokens · $0.01
Scheduled: 1,500 input · 60 output tokens · $0.01
Advisor: 90 input · 14 output tokens · $0.00
```

The agent's own turn that reads a note is the agent's work and bills as the
session's own; only the advisor's calls are the advisor's spend.
