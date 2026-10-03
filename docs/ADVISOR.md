# The advisor: a second model that advises the working model

The advisor is a second model that reads the working model's conversation on
a cadence and writes it one short note — what it may be missing, a course
correction, what to verify before going on. It advises the model, not you:
its notes land in the agent's context as muted rows marked `[advisor]`,
greyed like the `[Saturn]` rows, and are never addressed to the operator.
The agent can also ask it a question between notes. The advisor can use any
model and provider, local included, with a memory of its own. It serves the
main chat; crewmates and workflow workers never get an advisor.

It is off by default, and each chat turns its own on.

## Turning it on

Each chat has its own advisor switch, and the settings hold the master
switch above every chat. The advisor runs for a chat only when both are on.

- **`/advise on`** turns the advisor on for the chat you type it in, mid-session
  or at the start, and `/advise off` turns it off again. A new chat always
  starts with its advisor off, even when the settings are on, so nothing is
  spent until you say so in that chat. A model switch (`/model`) leaves the
  switch as it is. A resumed session remembers whether its advisor was on.
- **`/advise`** alone says the state in one line: on or off for this chat, the
  model, `every N minutes`, and — when the settings are off — that `/config`
  → Advisor must be on for any chat to get notes.
- **`/config` → Advisor** — the settings: the master switch, on or off. Off
  stops the advisor in every chat at once; nothing is written and nothing is
  sent. Turning it back on turns no chat on — each chat's own switch stands as
  it was. With the settings on the row reads
  `on · every 10 minutes · /advise turns it on per chat`.
- **`/config` → Advisor interval** — how many minutes pass between notes:
  10 · 20 · 30 · 45 · 60 (10 by default; the floor is 1).
- **`/submodels` → ADVISOR** — the advisor's model, picked from the same live
  catalogue the main `/model` picker offers: every signed-in family's models
  and the local catalogue, carriers included. `tab` moves between the CONSOLE
  and ADVISOR containers; `↵` pins a row; `e` sets the container's own effort.
  `MERCURY_ADVISOR_MODEL` pins it from the environment and locks the picker.
- **`mercury run --advise`** — a headless run has no chat to type `/advise on`
  in, so the flag turns its advisor on at birth. The settings in the run's
  own config home still hold the master switch.

While a chat's advisor is on, its status row carries a small chip:
`advisor · every 10 minutes`. If the settings are off while the chat's switch
is on, the chip reads `advisor · off in settings` instead; when the chat's
switch is off there is no chip.

Any pairing works either way round: a local Qwen advised by Fable, Astra
advised by Fable, Fable advised by Astra, Qwen advised by Astra. The advisor
model may be the same family as the agent or any other. With the advisor on
but no model pinned, the advisor stays silent. A signed-out or refused model
never lands an error in the agent's context: the round shows as a muted
`[advisor]` row that says the advisor had nothing to say this round and why,
addressed to you, never to the model.

## What the agent sees

Once `interval` minutes have passed since the advisor's last note — for the
first note, since the advisor began reading this chat — a note is due, and
the next boundary of the agent's work takes it: the end of a turn or a
tool-round boundary. There the advisor is shown the new rows of the agent's
conversation since its last look (the operator's lines, the agent's replies,
its tool calls with their results clipped; never the system prompt and never
a slash command's own echo) beside its own earlier notes, and asked for one
note of at most eight lines, addressed to the agent. No timer runs: an idle
agent produces no rows, and a note that is due waits until there is
something new to read. The note lands in the agent's context as a row with
the advisor's provenance:

```
10:00:04 [advisor] · claude-opus-5-5 · every 10 minutes
  The parser change has not been checked against an empty input.
  Add that case and run the tests before changing another file.
```

The note lands inside the agent's next turn, at its next boundary — beside
the operator's next prompt, or after the next tool result of a turn already
running — framed for the model as advice from a second model, never as a
message from the operator, and never as a turn of its own. An advisor that
has nothing to say answers `carry on`, and nothing lands.

The advisor thinks as deeply as its effort dial asks before it writes, and
the call has room for that thinking and the note — a question that needs
thought is answered with words, not cut short. An answer that comes back
with no text is asked for once more; if the advisor still has nothing, the
main chat shows a muted `[advisor]` row saying so — never silence, and never
a turn for the model:

```
10:00:04 [advisor] · claude-opus-5-5 · every 10 minutes
  had nothing to say this round — answered with no text, twice
```

A round that ends this way counts as the advisor's look: the interval runs
from it, and the next boundary asks nothing more until the minutes have
passed again.

## Asking the advisor

While the chat's advisor is on, the agent has one more tool, `AskAdvisor`,
with one input: a question. The advisor answers with the same view — its
memory of the conversation, the rows since its last look, and the question —
in at most eight lines. Crewmates and workflow workers never have the tool.
The reply is advice from a model, never an instruction from the operator, and
never an approval of anything.

## Its own memory, its own clock

The advisor keeps its own context per advised chat: the digests it was
shown and the notes it wrote, on disk beside the chat's transcript under
`<session>/advisor/<session id>.jsonl`, so a resumed session finds it. The
interval's clock reads that record too: it runs from the advisor's last
note there, so a session resumed after longer than the interval hears from
its advisor at its first boundary. That context compacts on its own clock —
the gauge is the advisor model's context window, never the agent's — so a
256k agent with a 1M advisor never compacts both at once, and the smaller
model gains the longer memory: when the agent's context folds, the advisor
still remembers what came before.

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
