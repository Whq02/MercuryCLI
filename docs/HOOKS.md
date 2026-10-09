# Hooks

A hook is something you ask Mercury to run at a moment it has: a shell
command, a question a model answers, or a crewmate that checks something.
Hooks live in settings files (user, project, local, the `--settings` file and
managed policy) under `events.hooks`; a skill, an agent or an extension may
bring its own. A hook sees the moment's facts on its input and answers with
one small JSON object; the answer may block the moment, change what the model
sees, add words for the model, or say nothing. `/hooks` lists every hook the
session carries.

## Declaring hooks

```json
{
  "events": {
    "hooks": {
      "tool.before": [
        { "match": "Bash", "run": "./scripts/check-command.sh", "timeout": 30 },
        { "match": "Edit|Write", "question": "Does this edit keep the file's own style? $EVENT" }
      ],
      "turn.answer": [
        { "name": "tests ran", "crewmate": "Check that the tests the answer claims to have run were really run." }
      ],
      "session.state": [
        { "match": "needs-you|stalled", "run": "~/bin/ping-me.sh", "background": true }
      ]
    }
  }
}
```

Each event names a list of entries, and one entry is one hook. An entry
names exactly one of:

- `run` — a shell command. The moment's facts arrive on stdin as one JSON
  line; the answer is the exit code and stdout.
- `question` — a question a model answers. `$EVENT` in the text is replaced
  by the facts as JSON; without it, the facts are appended. The model answers
  the shape below as structured output.
- `crewmate` — a brief a crewmate with the session's read tools checks, no
  asks, at most 50 turns inside its timeout; `$EVENT` as above. It answers
  the shape below through its verdict tool.

and may carry:

- `name` — the words every line about the hook uses, and the status row
  while it runs; without it, the first line of the command or question.
- `match` — names (`Bash`, `Read|Edit`) or a regular expression, matched
  against the event's match field in the table below. Absent, or `*`, matches
  everything. An entry whose match is not a valid regular expression is a
  named fault and does not load; so is a match on an event that has no match
  field. `match` is the one filter: a hook on a tool fires on every call of
  that tool, and a `run` hook that cares about one kind of call reads its
  stdin and exits 0 at once when the call is not its business:

  ```sh
  #!/bin/sh
  input=$(cat)
  case "$(printf '%s' "$input" | jq -r .input.command)" in
    "git commit"*) ;;
    *) exit 0 ;;
  esac
  ```

- `shell` — `bash` (the default) or `powershell`; `run` only.
- `model` — the model a `question` or `crewmate` hook runs on; without it,
  the session provider's small model answers a question and its light model
  runs a crewmate.
- `timeout` — seconds; 600 for a `run`, 30 for a `question`, 60 for a
  `crewmate`; at most 2147483.
- `background` — `run` only: the hook does not hold the moment; its answer
  arrives at the start of the next turn.
- `wake` — `run` only, implies `background`: a block from the hook wakes the
  model with the words.
- `once` — the hook runs once in a session, then stands down for the rest of
  it. Mercury never edits a settings file.
- `watch` — `file.changed` only: the files to watch, relative to the project.

An entry with a fault — an unknown field, a wrong type, a field that belongs
to another kind, a match on an event without one — is named in the session's
settings notes and dropped whole; the rest of the file applies. An unknown
event name is a fault like any other.

### Layers

user → project → local → `--settings` → managed. Entries from every layer
run; an entry identical in kind, text and match across layers runs once.
`events.disabled` in any layer turns off every hook that is not managed; in
the managed layer it turns off every hook. `events.managedOnly` in the
managed layer runs only the managed layer's hooks. `extensions.exclusive`
naming `hooks` runs only managed and extension hooks. An untrusted workspace
runs no checkout hook: a headless run loads the user, `--settings` and
managed layers only, and the cockpit runs nothing until the workspace is
trusted ([TRUST.md](TRUST.md)).

### Skills, agents and extensions

A skill's `hooks:` frontmatter is the same map, registered while the skill is
in the session and removed when it leaves; its hooks are named
`skill:<name>`. An agent's `hooks:` frontmatter is the same map, registered
for that crewmate's own turns only (its `turn.*`, `tool.*` and `permission.*`
hooks fire for its calls and nothing else), named `agent:<type>`. An
extension's `contributes.hooks` is the same map with `run` entries only,
named `extension:<name>` ([EXTENSIONS.md](EXTENSIONS.md)). A faulty entry in
any of them is named and dropped; the rest loads.

### The worktree command

`workspace.worktree.prepare` is a plain setting, not a hook: a shell command
Mercury runs inside every new worktree after git makes it and before any
seat uses it — a crewmate's isolation worktree, `--worktree`, EnterWorktree.
It has no input and no answer; a failure is named on the row that made the
worktree, and the worktree is used anyway.

## Events

Every input carries `event`, `session_id`, `transcript_path`, `cwd`,
`permission_mode` (when a turn is running), and `crewmate_id` and
`crewmate_type` when the moment happened inside a crewmate. `turn_id` is one
id wherever it appears: the turn row's id on the main thread, the crewmate's
own run key inside a crewmate. The event adds its own fields:

| Event | Fires | Fields | Match field | An answer may |
| --- | --- | --- | --- | --- |
| `turn.start` | the operator's prompt is in and the model is about to be asked | `turn_id`, `prompt` | none | `block`, `stop`, `context` |
| `turn.answer` | the model has answered and would end its turn (inside a crewmate too) | `turn_id`, `answer`, `again` (true when this fire follows the hook's own send-back) | none | `block` (the model is sent back with the words and keeps working), `stop`, `context` |
| `turn.end` | a turn is over, however it ended; a cut turn carries its cut and that fire runs under a 1.5 s budget | `turn_id`, `status` (`completed`, `blocked`, `refused`, `interrupted`, `turn_limit`, `budget_limit`, `schema_unmet`, `loop_stopped`, `failed`), `stop`, `error` (`{message, class}`), `cut` (`{reason, detail, tools}`: `operator`, `idle-timeout`, `parent-stop` or `cut`, its words, the calls it ended), `steps`, `wall_ms`, `cost_usd`, `usage`, `answer` | `status` | nothing |
| `tool.before` | a tool call is about to run, after its input was validated and before the permission decision | `tool`, `input`, `call_id` | `tool` | `block`, `permission` (`allow` or `ask`), `input`, `context`, `stop` |
| `tool.after` | a tool call ended: it returned, returned an error, or threw; a call a cut ended fires under a 1.5 s budget | `tool`, `input`, `output`, `call_id`, `ok` (false when it returned an error or threw), `error`, `cut` (true when a cut caused the failure) | `tool` | `block` (the model reads the words beside the result), `output`, `context`, `stop` |
| `permission.ask` | a permission ask is about to reach the operator, or a crewmate that cannot ask would be denied | `tool`, `input`, `call_id`, `suggestions` | `tool` | `permission: "allow"` (with `input` and `rules`), `block` (a deny), `stop`; silence lets the ask go on |
| `permission.decided` | a tool call's permission was decided without the hook's own answer | `tool`, `input`, `call_id`, `decision` (`allowed`, `denied`), `by` (`rule`, `mode`, `hook`, `operator`, `safety`, `other`), `reason` | `tool` | nothing |
| `crewmate.start` | a crewmate is launched; the crewmate fields name it | `name`, `prompt`, `model`, `directory` | `crewmate_type` | `context` (words the crewmate reads before its first turn) |
| `crewmate.end` | a crewmate ended | `name`, `status` (`finished`, `failed`, `stopped`), `reason`, `crewmate_transcript_path`, `usage` | `status` | nothing |
| `compaction.before` | the conversation is about to be summarised; it cannot be blocked | `trigger` (`manual`, `auto`, `overflow`), `instructions`, `tokens` | `trigger` | `instructions` (guidance appended to the summariser's) |
| `compaction.after` | a compaction rung landed: the summary, the memory notes, or the digest that cleared old tool results | `method` (`summary`, `notes`, `digest`), `trigger`, `tokens_before`, `tokens_after`, `summary` | `method` | `context` (words re-added after the cut) |
| `session.start` | a session's runner came up | `reason` (`new`, `resumed`), `model` | `reason` | `context`, `prompt` (the session's first prompt, new sessions only), `watch`; and the environment file |
| `session.end` | the runner is leaving; a crash fires nothing; `run` hooks only, 1.5 s for the batch | `reason` (`quit`, `logout`, `closed`) | `reason` | nothing |
| `session.state` | a hosted session moved to a board state worth acting on; fired by the daemon with the hooks of the session's workspace (its project and local layers when the workspace is trusted); `run` hooks only | `state` (`needs-you`, `stalled`, `ready-to-review`, `paused`, `completed`, `failed`, `cancelled`), `from`, `detail`, `title`, `workspace`, `model` | `state` | nothing |
| `file.changed` | a watched file changed; the entry's `watch` names the files | `path` (relative to the project), `change` (`changed`, `added`, `removed`) | `path` | `watch` (replaces the list); and the environment file |

A `by` of `mode` includes a posture that answered an ask on its own; `safety`
is one of Mercury's own guards — the wards, the commit gate, the path-safety
check.

## What a hook answers

One shape, every kind, read against the event. A field the event does not
read is a named failure ("`input` is not an answer `tool.after` reads"), never
a silent merge:

- `block` — the moment is blocked with these words: a refused tool call, a
  refused prompt, the model sent back on `turn.answer`, a deny on
  `permission.ask`. The model reads the words.
- `stop` — the whole turn ends now; the operator reads the words; the model
  reads nothing more.
- `context` — words the model reads at this moment.
- `notice` — one line the operator reads, saved in the session.
- `permission` — `allow` (no ask, though a deny rule still denies) or `ask`
  (the operator is asked); a deny is `block`.
- `input` — the input the tool runs with instead; `output` — what the model
  sees as the result instead; `rules` — permission updates applied with an
  allow; `instructions` — guidance for the summariser; `prompt` — the
  session's first prompt; `watch` — the files to watch.

A `run` hook answers with its exit code and its stdout:

- exit 0: stdout is the answer — empty, one JSON object as above, or plain
  text, which the operator sees in transcript mode; on `session.start`,
  `turn.start`, `crewmate.start` and `compaction.after` plain text is
  `context` the model reads;
- exit 2: the moment is blocked and stderr is the words; stdout is not read;
- any other exit, a timeout, a kill, a closed pipe or a command that could
  not run: the hook failed, the moment proceeds, and the operator reads one
  line naming the hook, the event and what happened. JSON that is not the
  answer shape is a failure, not prose.

Every kind is ended at its `timeout` — the command killed, the model call
abandoned, the crewmate stopped — and the line reads `hook <name> (<event>)
timed out after <n>s and was killed; the <event> it guarded proceeded`.
`session.end`, a cut `turn.end` and a cut `tool.after` run under a 1.5 s
budget, or the hook's own timeout when shorter.

A `background` hook keeps its clock. Of its answer only `context` and
`notice` are read, at the start of the next turn; `block` is read only on a
`wake` hook, where it wakes the model with the words. Anything else in a
background answer is a named failure. At session end the running background
hooks are ended.

Several hooks on one moment run at once. Any block blocks, and the words of
every block are joined in order; every `context` is added in order; for
`permission`, deny beats ask beats allow; for a field only one hook may set
(`input`, `output`, `prompt`, `instructions`) the last entry in layer order
wins and the operator reads a notice naming both.

What each outcome shows: a hook that ran with nothing to say shows nothing
(transcript mode counts them); `context` reaches the model and the
transcript; a `block` is a red line, `hook <name> blocked <event>: <words>`,
and the model reads the words; a `stop` ends the turn with its words; a
`notice` is one line; a failure is one line. Every line is saved with the
session, survives a resume, and is painted by a daemon-hosted cockpit from
the session file.

A `run` hook's environment is the scrubbed process environment plus
`MERCURY_PROJECT_DIR`, `MERCURY_SESSION_ID` and `MERCURY_HOOK_EVENT`; on
`session.start` and `file.changed` also `MERCURY_ENV_FILE`, a file where
lines of `NAME=value` reach every later shell command of the session; an
extension's hooks also get `MERCURY_EXTENSION_ROOT`, `MERCURY_EXTENSION_DATA`
and `MERCURY_EXTENSION_OPTION_<KEY>`. stdout and stderr are each bounded at
10 MB.

## Policy

Managed policy settings can tighten the hook surface: `events.disabled`
turns off every hook, managed ones included, and `events.managedOnly`
restricts execution to the hooks the managed settings define. The trust gate
that keeps a project's hooks from running before the workspace is trusted is
in [TRUST.md](TRUST.md).
