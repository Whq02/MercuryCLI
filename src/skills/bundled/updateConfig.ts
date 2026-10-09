import { z } from 'zod/v4'
import { registerBundledSkill } from '../bundledSkills.js'
import { SettingsSchema } from '../../utils/settings/types.js'
import { HOOK_EVENTS, HOOK_KINDS, hookEventTable, hookKindsOf, hookMatchValues } from '../../utils/hooks/contract.js'

const HOOKS_ONLY_MARKER = '[hooks-only]'

function hooksDocumentation(): string {
  const rows = HOOK_EVENTS.map(event => {
    const row = hookEventTable[event]
    const values = hookMatchValues(event)
    const match = row.match === undefined ? 'none' : values === undefined ? row.match : `${row.match} (${values.join(', ')})`
    const answers = row.answers.length === 0 ? 'nothing (a record)' : row.answers.join(', ')
    const kinds = hookKindsOf(event).length === HOOK_KINDS.length ? '' : ` — ${hookKindsOf(event).join('/')} only`
    return `| ${event} | ${row.moment} | ${match} | ${answers}${kinds} |`
  })
  return `## Hooks

Shape: settings.json > "events" > "hooks" > { "<event>": [ <entry>, ... ] }. One entry is one hook with its own match. An entry names exactly one of "run" (a shell command; the payload arrives on stdin as one JSON line), "question" (a question a model answers; $EVENT is replaced by the payload JSON, else the payload is appended) or "crewmate" (a brief a crewmate with tools checks; $EVENT as above), plus "name" (the words every line about the hook uses), "match" (names such as Bash or Write|Edit, or a regular expression, matched against the event's match field; absent matches everything; refused on an event with no match field), "shell" (bash or powershell, run only), "model" (question and crewmate only), "timeout" (seconds: 600 run, 30 question, 60 crewmate), "background" and "wake" (run only: the hook does not hold the moment; wake also wakes the model when the hook blocks), "once" (once per session), "watch" (file.changed only: the files to watch, relative to the project). There is no condition on the tool's input: a hook on a tool fires on every call of that tool; a run hook that cares about one kind of call reads its stdin and exits 0 at once when the call is not its business. A faulty entry is named and dropped whole; the rest of the file applies.

The events (the match field is what "match" is matched against; the answer fields are what the hook may return):

| Event | Fires | Match field | An answer may set |
|---|---|---|---|
${rows.join('\n')}

Every payload carries event, session_id, transcript_path, cwd, permission_mode (when a turn is running) and crewmate_id/crewmate_type (inside a crewmate), then the event's own fields; tool.before and tool.after carry tool, input, call_id (and output, ok, error, cut after the call); turn.end carries status, stop, error, cut, steps, wall_ms, cost_usd, usage, answer.

A run hook answers with its exit code and its stdout: exit 0 and stdout is the answer — empty, one JSON object with the answer fields above (block: the moment is blocked with these words and the model reads them; stop: the whole turn ends; context: words the model reads; notice: one line the operator reads, saved in the session; permission: allow or ask on tool.before and permission.ask — a deny is block; input: the input the tool runs with instead; output: what the model sees as the result instead; rules: permission updates applied with an allow; instructions: guidance for the summariser; prompt: the session's first prompt; watch: the files to watch), or plain text (shown to the operator in transcript mode; on session.start, turn.start, crewmate.start and compaction.after plain text is context the model reads). Exit 2 blocks the moment with stderr as the words. Any other exit, a timeout or a kill: the hook failed, the moment proceeds, the operator reads one line. A field the event does not read, or JSON that is not the answer shape, is a named failure, never prose and never a silent merge. A question or crewmate hook answers the same shape as structured output.

Related settings keys: events.disabled (true turns off every hook that is not managed; in the managed layer, every hook), events.managedOnly (managed layer only). workspace.worktree.prepare is a plain setting, not a hook: a shell command run inside every new worktree after git makes it.`
}

const HOOK_CONSTRUCTION_FLOW = `## Building a hook, with proof

1. Read the target settings file first. An existing hook on the same event and match is a question for the user — replace or add beside — never a silent overwrite.
2. Write the command for THIS project: inspect the repo for its package manager and invocation style instead of assuming one. Pull stdin fields through a quoted variable (f=$(jq -r .input.file_path) and then "$f"), never through word splitting. A hook that cares about one kind of call reads its stdin first and exits 0 at once when the call is not its business. End with ; true unless a failure should really surface on every fire — any exit that is not 0 or 2 is reported as a hook error each time.
3. Pipe-test before wiring: feed a synthesized stdin payload for the event and check the exit status AND the side effect. Remember 2 is the blocking status — a formatter that exits 2 on unformatted input would block the tool call it was meant to follow.
4. Write the JSON by merging into the file's existing content — carry the arrays forward and add to them; a write that replaces the hooks object drops the user's other hooks. When you create .mercury/settings.local.json by hand, add the matching ignore rule too: Mercury gitignores that file only when its own writer creates it.
5. Validate: jq . <file> proves the JSON parses; then re-check the shape against the generated schema. A file that fails to parse simply drops out of the settings merge — the other settings files keep working, and the file's errors surface in the session.
6. Prove the hook fires. Prefix the command with a sentinel append (echo x >> <scratch>/hook-proof) or introduce a change the hook must visibly transform, trigger the event once, and read the evidence. Clean the sentinel up afterwards, pass or fail.
7. The pipe-test passed but the live proof did not: the usual cause is that the settings file's parent directory did not exist when the session started — the hot-reload watcher arms only directories that existed at initialisation. A session restart picks the file up; creating the directory before the next session avoids the repeat.
8. Hand off: say which file carries the hook and on which event; /hooks lists every hook the session carries. A clean hook run is silent by design — failures and blocks surface, success does not.

Frequent mistakes: replacing arrays instead of extending them; unquoted jq extraction; a hook that exits 2 by accident and blocks its event; an unknown event name or a wrongly shaped entry (both are named faults; the entry does not load).`

const FULL_PROMPT = `You configure the Mercury harness through its settings files.

A REQUEST FOR AUTOMATIC BEHAVIOUR IS A HOOK. "After every edit…", "whenever a session starts…", "before each bash command…" — the harness executes hooks; nothing written into memory or instruction files can run a command by itself. Format-on-write → tool.after; command logging → tool.before; end-of-turn notice → turn.answer or turn.end; "tell me when a session needs me" → session.state.

THE FILES, LOWEST PRIORITY FIRST:
- user: <config-home>/settings.json — every project. The config home is ~/.mercury, or whatever MERCURY_CONFIG_DIR names.
- project: .mercury/settings.json — checked in, shared with the crew.
- local: .mercury/settings.local.json — personal, gitignored.
- flag: a file passed on the command line; managed: managed-settings.json plus its drop-ins — policy, not editable here.
MERGE LAW across sources: objects deep-merge with later sources winning, and ARRAYS CONCATENATE (de-duplicated) — a project allow-list adds to the user's, it cannot subtract from it. Changes hot-apply through a file watcher.

EDITING RULES:
- Read before writing, always.
- Merge into what is there: extend arrays, preserve unrelated keys. Losing a user's existing guardrails.allow entries is the classic failure.
- Ambiguity — which scope, which value, add or replace — goes to the user as an AskUserQuestion, not a guess.
- Simple interactive knobs (theme, appearance, model) live in the /config panel; suggest it rather than editing those by file.

PERMISSION RULES (the guardrails.allow / deny / ask arrays):
- A rule is a tool name, or a tool name with a parenthesised pattern: "Bash", "Bash(npm run test)" (that exact command), "Bash(npm run *)" (any command starting with npm run — a space and a star end a "starts with" rule; a star may also stand anywhere inside a pattern), "Read(src/**)" and glob forms for the file tools, "WebFetch(domain:example.com)", "WebSearch(exact terms)".
- guardrails.reasons gives a rule its own words, keyed by the rule spelling exactly as it appears in allow, deny or ask: { "Read(secrets/**)": "production keys live there; use the .example files" }. A refusal ends with the words ("Reading … is denied by the rule Read(secrets/**) in your user settings: production keys live there; use the .example files.") and a consent card shows them under the rule; a rule without a reason keeps the plain sentence. Where two rules match, the more specific spelling's words are used.
- guardrails.mode sets the session's starting permission mode. Implement mode allows writes inside the starting folder and asks outside it; Default asks for writes in either place; Sovereign does not ask. A shell directory change does not move the starting folder.

WORKFLOW: clarify → read → merge → write → show the result and where it landed.

${hooksDocumentation()}

${HOOK_CONSTRUCTION_FLOW}

WORKED SHAPES:
1. "Format after every write" → events.hooks["tool.after"], match Write|Edit, a run hook built and proven per the flow above.
2. "Allow npm test without asking" → read the chosen scope's file, append "Bash(npm test *)" to guardrails.allow, show the merged result.
3. "Set DEBUG=1 for every session" → environment: { "values": { "DEBUG": "1" } } in the scope the user picks.`

function generatedSchemaSection(): string {
  const jsonSchema = z.toJSONSchema(SettingsSchema(), { io: 'input' })
  return `## Generated settings JSON Schema (from the live schema)\n\n\`\`\`json\n${JSON.stringify(jsonSchema, null, 2)}\n\`\`\``
}

export function registerUpdateConfigSkill(): void {
  registerBundledSkill({
    name: 'update-config',
    description:
      'Use this skill for any change to Mercury settings files: permission rules ("allow X"), environment variables ("set X=Y"), MCP server enablement, extension settings, and every event-driven automation ("whenever X, do Y" — that is a hook, and only a hook configured in settings actually executes). Also the place for hook troubleshooting. Simple interactive knobs like theme or model belong to the /config panel instead.',
    argumentHint: '<the change: allow X · set X=Y · enable server Y · whenever X do Y>',
    allowedTools: ['Read'],
    getPromptForCommand: async args => {
      const trimmed = args.trim()
      if (trimmed.startsWith(HOOKS_ONLY_MARKER)) {
        const task = trimmed.slice(HOOKS_ONLY_MARKER.length).trim()
        const text = [
          hooksDocumentation(),
          HOOK_CONSTRUCTION_FLOW,
          ...(task ? [`## Task\n\n${task}`] : []),
        ].join('\n\n')
        return [{ type: 'text', text }]
      }
      const text = [
        FULL_PROMPT,
        generatedSchemaSection(),
        ...(trimmed ? [`## User request\n\n${trimmed}`] : []),
      ].join('\n\n')
      return [{ type: 'text', text }]
    },
  })
}
