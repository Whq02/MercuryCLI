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

Shape: \`settings.json > "events" > "hooks" > { "<event>": [ <entry>, ... ] }\`. Each entry is one hook with exactly one of \`run\` (shell command; payload arrives on stdin as one JSON line), \`question\` (model prompt; \`$EVENT\` expands to payload JSON, else appended) or \`crewmate\` (crewmate brief with tools; \`$EVENT\` as above). Optional fields:
- \`name\`: label shown in hook messages.
- \`match\`: tool names (\`Bash\`, \`Write|Edit\`) or regex against the event's match field; omitted matches all; refused when the event has no match field. On \`tool.before\`, \`tool.after\`, \`permission.ask\` and \`permission.decided\`, permission-rule syntax also matches arguments (joined with \`|\`): \`Bash(git *)\` / \`PowerShell(…)\` (matches any subcommand, e.g. \`cd x && git push\` matches \`Bash(git push *)\`), \`Read(…)\` / \`Edit(…)\` / \`Write(…)\` / \`NotebookEdit(…)\` / \`NotebookRead(…)\` / \`Glob(…)\` / \`Grep(…)\` for paths (\`Edit(src/**)\`), \`WebFetch(domain:example.com)\`, \`Crewmate(mercury-scout)\`, and \`mcp__<server>\` or \`mcp__<server>__*\`. Conditions \`match\` cannot express belong in the hook: read stdin and exit 0 immediately when irrelevant.
- \`shell\`: \`bash\` or \`powershell\` (\`run\` only).
- \`model\`: model for \`question\` or \`crewmate\`.
- \`timeout\`: seconds (defaults: 600 \`run\`, 30 \`question\`, 60 \`crewmate\`).
- \`background\` / \`wake\` (\`run\` only): do not block the event; \`wake\` also wakes the model when the hook blocks.
- \`once\`: run once per session.
- \`failClosed\`: block the event with the failure line if the hook cannot run, times out, fails or returns an invalid shape (only on blockable events, never with \`background\` or \`wake\`).
- \`watch\` (\`file.changed\` only): project-relative paths to watch.
Faulty entries are reported and dropped whole; valid entries still load.

| Event | Fires | Match field | An answer may set |
|---|---|---|---|
${rows.join('\n')}

Payloads carry \`event\`, \`session_id\`, \`transcript_path\`, \`cwd\`, \`permission_mode\` (during a turn), \`crewmate_id\`/\`crewmate_type\` (inside a crewmate), plus event fields: \`tool.before\`/\`tool.after\` add \`tool\`, \`input\`, \`call_id\` (and \`output\`, \`ok\`, \`error\`, \`cut\`, \`wall_ms\` on \`tool.after\`); \`turn.end\` adds \`status\`, \`stop\`, \`error\`, \`cut\`, \`steps\`, \`wall_ms\`, \`cost_usd\`, \`usage\`, \`answer\`.

A \`run\` hook answers via exit code and stdout:
- Exit 0: empty stdout, one JSON object with allowed answer fields (\`block\`: block with reason shown to model; \`stop\`: end turn; \`context\`: text shown to model; \`notice\`: one line shown to operator and saved; \`permission\`: \`allow\` or \`ask\` on \`tool.before\`/\`permission.ask\`, use \`block\` to deny; \`input\`: replacement tool input; \`output\`: replacement tool result; \`rules\`: permission updates applied with \`allow\`; \`instructions\`: compaction guidance; \`prompt\`: initial session prompt; \`watch\`: watched files), or plain text (operator transcript line, except on \`session.start\`, \`turn.start\`, \`crewmate.start\` and \`compaction.after\` where plain text becomes model \`context\`).
- Exit 2: blocks the event using stderr as the reason.
- Other non-zero exit, timeout or kill: hook error line to the operator; the event proceeds (unless \`failClosed\`).
Disallowed fields or malformed JSON fail loudly without merging. \`question\` and \`crewmate\` hooks return the same JSON shape as structured output.

Related settings: \`events.disabled\` (\`true\` disables non-managed hooks, or all hooks when set in managed settings), \`events.managedOnly\` (managed layer only). \`workspace.worktree.prepare\` is a plain setting, not a hook: a shell command run in each new git worktree.`
}

const HOOK_CONSTRUCTION_FLOW = `## Building and proving a hook

1. Read the target settings file first. If a hook already matches the same event and target, ask the user whether to replace it or add beside it.
2. Inspect the repository's package manager and tooling rather than guessing. Extract stdin fields into quoted variables (\`f=$(jq -r .input.file_path)\`, then \`"$f"\`), never unquoted word-splitting. End \`run\` commands with \`; true\` unless non-blocking failures should surface as hook errors on every fire (any exit other than 0 or 2 is reported).
3. Pipe-test before saving: pipe a sample event JSON payload to the command and verify both exit code and side effect (exit 2 blocks the event, so a formatter exiting 2 on unformatted code would block edits).
4. Merge into existing JSON, extending hook arrays without dropping other hooks or keys. If creating \`.mercury/settings.local.json\` directly, add it to gitignore (Mercury gitignores it automatically only when its own writer creates it).
5. Validate JSON syntax (\`jq . <file>\`) and check against the generated schema below. Unparseable files at startup drop out of the merge; mid-session parse errors keep the last valid settings and surface once.
6. Prove live firing: add a temporary sentinel (\`echo x >> <scratch>/hook-proof\`) or observable transform, trigger the event once, verify, and remove the sentinel regardless of outcome.
7. If pipe-test passed but live firing did not, check \`/hooks\`: project/local hooks stay off in untrusted workspaces, \`events.disabled\` or \`events.managedOnly\` may apply, or the file-watcher settle window has not elapsed.
8. Report the target file and event name, noting \`/hooks\` lists active hooks and clean runs stay silent.`

const FULL_PROMPT = `Configure Mercury through its settings files.

Event-driven automation ("after every edit…", "when a session starts…", "before bash…") requires a hook in settings; memory and instruction files never execute commands. Map format-on-write to \`tool.after\`, command logging to \`tool.before\`, end-of-turn notices to \`turn.answer\` or \`turn.end\`, and session attention alerts to \`session.state\`.

## Settings layers (lowest to highest priority)
- \`user\`: \`<config-home>/settings.json\` (\`~/.mercury\`, or \`MERCURY_CONFIG_DIR\`) — all projects.
- \`project\`: \`.mercury/settings.json\` — committed, shared.
- \`local\`: \`.mercury/settings.local.json\` — personal, gitignored.
- \`flag\` / \`managed\`: CLI settings file and \`managed-settings.json\` + drop-ins — policy, do not edit here.
Merge rule: objects deep-merge (later wins); arrays concatenate and de-duplicate (project \`allow\` adds to user \`allow\`, never subtracts). Edits hot-apply via file watcher.

## Editing rules
- Read the target file first; merge into existing objects and extend arrays without dropping unrelated keys or \`guardrails.allow\` entries.
- Ask via \`AskUserQuestion\` when scope, value, or add-vs-replace is ambiguous.
- Direct simple interactive preferences (theme, appearance, model) to \`/config\` rather than file edits.
- Show the merged result and file path when done.

## Permission rules (\`guardrails.allow\` / \`deny\` / \`ask\`)
- Forms: bare tool name (\`"Bash"\`), exact command (\`"Bash(npm run test)"\`), wildcard command (\`"Bash(npm run *)"\` — trailing space+star or \`*\` anywhere), file globs (\`"Read(src/**)"\`), \`"WebFetch(domain:example.com)"\`, \`"WebSearch(exact terms)"\`, \`"ProviderSearch(exact terms)"\`, and \`"mcp__<server>"\`, \`"mcp__<server>__*"\`, or \`"mcp__<server>__<tool>"\`.
- \`guardrails.reasons\`: maps an exact rule string from \`allow\`/\`deny\`/\`ask\` to explanation text (\`{ "Read(secrets/**)": "production keys live there; use .example files" }\`), shown in denials and consent cards; most specific matching rule wins.
- \`guardrails.mode\`: starting mode (\`default\`, \`dontAsk\`, \`implement\`, \`sovereign\`, \`flow\`, \`apollo\`). \`implement\` allows writes inside the starting folder and asks outside (shell \`cd\` does not move it); \`default\` asks in both; \`sovereign\` does not ask.

${hooksDocumentation()}

${HOOK_CONSTRUCTION_FLOW}

## Examples
1. Format on write → \`events.hooks["tool.after"]\`, \`match: "Write|Edit"\`, \`run\` hook pipe-tested and live-proven.
2. Allow \`npm test\` → append \`"Bash(npm test *)"\` to \`guardrails.allow\` in the chosen scope.
3. Set \`DEBUG=1\` → merge \`"environment": { "values": { "DEBUG": "1" } }\` in the chosen scope.`

function generatedSchemaSection(): string {
  const jsonSchema = z.toJSONSchema(SettingsSchema(), { io: 'input' })
  return `## Generated settings JSON Schema\n\n\`\`\`json\n${JSON.stringify(jsonSchema, null, 2)}\n\`\`\``
}

export function registerUpdateConfigSkill(): void {
  registerBundledSkill({
    name: 'update-config',
    description:
      'Use this skill for any change to Mercury settings files: permission rules, environment variables, MCP server enablement, extension settings, and event-driven hooks ("whenever X, do Y"). Not for /config knobs or keybindings.',
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
