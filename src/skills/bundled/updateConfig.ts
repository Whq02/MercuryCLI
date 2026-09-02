// ============================================================================
//  src/skills/bundled/updateConfig.ts — /update-config: configure the
//  harness via settings files. Two modes: [hooks-only] emits only the hook
//  documentation + construction flow; the full mode appends a JSON Schema
//  GENERATED from the live settings schema, so a new settings field changes
//  the emitted schema without a prompt edit.
// ============================================================================
import { z } from 'zod/v4'
import { registerBundledSkill } from '../bundledSkills.js'
import { SettingsSchema } from '../../utils/settings/types.js'

const HOOKS_ONLY_MARKER = '[hooks-only]'

const HOOKS_DOCUMENTATION = `## Hooks

Shape: settings.json > "hooks" > { "<Event>": [ { "matcher": "<pattern>", "hooks": [ <hook>, ... ] } ] }. The matcher is a pattern over event-related values — tool names on the tool events, the start source on SessionStart; events with nothing to match ignore it. Matcher grammar: empty or * claims everything; word characters with | alternation (Write|Edit) match exactly; anything else is a regular expression.

The events wired most often:

| Event | Fires |
|---|---|
| PermissionRequest | when a tool call needs a permission decision — a hook can decide it |
| PreToolUse | before a tool runs — validate, block, or rewrite the input |
| PostToolUse | after a tool call succeeds |
| PostToolUseFailure | after a tool call fails |
| UserPromptSubmit | when the user submits a prompt — inspect or add context |
| SessionStart / SessionEnd | session lifecycle (SessionStart's matcher is the start source) |
| Stop | when a turn ends |
| PreCompact / PostCompact | around a compaction |
| ConfigChange | when a settings file changes on disk — a blocking result vetoes the hot reload |
| Notification | when the harness raises a notification |

The full event enum — subagent and task events, worktree events, FileChanged, CwdChanged and the rest — is in the generated schema's hooks section; every event name there is wireable.

Four hook kinds, discriminated on "type":
- command: { "type": "command", "command": "<shell command>" } — plus optional shell ("bash" | "powershell"), async (background, non-blocking), asyncRewake (background, wakes the model when the hook exits blocking).
- prompt: { "type": "prompt", "prompt": "..." } — a model evaluates the prompt; $ARGUMENTS receives the hook input JSON.
- agent: { "type": "agent", "prompt": "..." } — a small agent runs with tools; $ARGUMENTS as above; its timeout defaults to 60s.
- http: { "type": "http", "url": "https://..." } — POSTs the hook input JSON; header values may reference $VARS only when allowedEnvVars lists them, and the URL must be allowed by the allowedHttpHookUrls setting.
Every kind also takes: "if" (a permission-rule-syntax condition over the tool name and input — the hook is skipped, never spawned, when it does not match), "timeout" (seconds), "statusMessage" (spinner text), "once" (run once, then remove).

Hook standard input is one JSON object: session_id, transcript_path, cwd, permission_mode, plus agent_id/agent_type inside agents; tool events add tool_name and tool_input, and PostToolUse adds tool_response.

A command hook answers in one of two ways:
- Exit status alone: 0 = success (stdout may add context), 2 = BLOCK — stderr becomes the model-facing feedback, any other status = a non-blocking error that is surfaced but stays out of the model's way.
- A JSON object on stdout: continue (false stops the turn) with stopReason; suppressOutput; decision "approve"/"block" with reason; systemMessage (user-visible note); hookSpecificOutput per event — PreToolUse takes permissionDecision "allow"/"deny"/"ask", permissionDecisionReason and updatedInput (a rewritten tool input); UserPromptSubmit takes additionalContext; PostToolUse takes additionalContext. Malformed JSON is reported back with the offending paths named — it never silently downgrades to prose.
HTTP hooks answer in JSON or not at all (an empty body reads as {}).

Related settings keys: disableAllHooks, allowManagedHooksOnly, allowedHttpHookUrls, httpHookAllowedEnvVars.`

const HOOK_CONSTRUCTION_FLOW = `## Building a hook, with proof

1. Read the target settings file first. An existing hook on the same event and matcher is a question for the user — replace or add beside — never a silent overwrite.
2. Write the command for THIS project: inspect the repo for its package manager and invocation style instead of assuming one. Pull stdin fields through a quoted variable (f=$(jq -r .tool_input.file_path) and then "$f"), never through word splitting. End with ; true unless a failure should really surface on every fire — any exit that is not 0 or 2 is reported as a hook error each time.
3. Pipe-test before wiring: feed a synthesized stdin payload for the event and check the exit status AND the side effect. Remember 2 is the blocking status — a formatter that exits 2 on unformatted input would block the tool call it was meant to follow.
4. Write the JSON by merging into the file's existing content — carry the arrays forward and add to them; a write that replaces the hooks object drops the user's other hooks. When you create .mercury/settings.local.json by hand, add the matching ignore rule too: Mercury gitignores that file only when its own writer creates it.
5. Validate: jq . <file> proves the JSON parses; then re-check the shape against the generated schema. A file that fails to parse simply drops out of the settings merge — the other settings files keep working, and the file's errors surface in the session.
6. Prove the hook fires. Prefix the command with a sentinel append (echo x >> <scratch>/hook-proof) or introduce a change the hook must visibly transform, trigger the event once, and read the evidence. Clean the sentinel up afterwards, pass or fail.
7. The pipe-test passed but the live proof did not: the usual cause is that the settings file's parent directory did not exist when the session started — the hot-reload watcher arms only directories that existed at initialisation. A session restart picks the file up; creating the directory before the next session avoids the repeat.
8. Hand off: say which file carries the hook and on which event; /hooks shows the hooks wired to this session's tool events. A clean hook run is silent by design — failures and blocks surface, success does not.

Frequent mistakes: replacing arrays instead of extending them; unquoted jq extraction; a hook that exits 2 by accident and blocks its event; prompt/agent hook output expectations applied to command hooks.`

const FULL_PROMPT = `You configure the Mercury harness through its settings files.

A REQUEST FOR AUTOMATIC BEHAVIOUR IS A HOOK. "After every edit…", "whenever a session starts…", "before each bash command…" — the harness executes hooks; nothing written into memory or instruction files can run a command by itself. Format-on-write → PostToolUse; command logging → PreToolUse; end-of-turn notice → Stop.

THE FILES, LOWEST PRIORITY FIRST:
- user: <config-home>/settings.json — every project. The config home is ~/.mercury, or whatever MERCURY_CONFIG_DIR names.
- project: .mercury/settings.json — checked in, shared with the team.
- local: .mercury/settings.local.json — personal, gitignored.
- flag: a file passed on the command line; managed: managed-settings.json plus its drop-ins — policy, not editable here.
MERGE LAW across sources: objects deep-merge with later sources winning, and ARRAYS CONCATENATE (de-duplicated) — a project allow-list adds to the user's, it cannot subtract from it. Changes hot-apply through a file watcher; ConfigChange hooks observe every reload and a blocking result vetoes it.

EDITING RULES:
- Read before writing, always.
- Merge into what is there: extend arrays, preserve unrelated keys. Losing a user's existing permissions.allow entries is the classic failure.
- Ambiguity — which scope, which value, add or replace — goes to the user as an AskUserQuestion, not a guess.
- Simple interactive knobs (theme, appearance, model) live in the /config panel; suggest it rather than editing those by file.

PERMISSION RULES (the permissions.allow / deny / ask arrays):
- A rule is a tool name, or a tool name with a parenthesised pattern: "Bash", "Bash(npm run test:*)" (prefix rules for Bash end in :*), "Read(src/**)" and glob forms for the file tools, "WebFetch(domain:example.com)", "WebSearch(exact terms)".
- defaultMode sets the session's starting permission mode; additionalDirectories widens the file-access root.

WORKFLOW: clarify → read → merge → write → show the result and where it landed.

${HOOKS_DOCUMENTATION}

${HOOK_CONSTRUCTION_FLOW}

WORKED SHAPES:
1. "Format after every write" → hooks.PostToolUse, matcher Write|Edit, a command hook built and proven per the flow above.
2. "Allow npm test without asking" → read the chosen scope's file, append "Bash(npm test:*)" to permissions.allow, show the merged result.
3. "Set DEBUG=1 for every session" → env: { "DEBUG": "1" } in the scope the user picks.`

/** The generated schema section: produced from the LIVE settings schema. */
function generatedSchemaSection(): string {
  const jsonSchema = z.toJSONSchema(SettingsSchema(), { io: 'input' })
  return `## Generated settings JSON Schema (from the live schema)\n\n\`\`\`json\n${JSON.stringify(jsonSchema, null, 2)}\n\`\`\``
}

export function registerUpdateConfigSkill(): void {
  registerBundledSkill({
    name: 'update-config',
    description:
      'Use this skill for any change to Mercury settings files: permission rules ("allow X"), environment variables ("set X=Y"), MCP server enablement, extension settings, and every event-driven automation ("whenever X, do Y" — that is a hook, and only a hook configured in settings actually executes). Also the place for hook troubleshooting. Simple interactive knobs like theme or model belong to the /config panel instead.',
    allowedTools: ['Read'],
    getPromptForCommand: async args => {
      const trimmed = args.trim()
      if (trimmed.startsWith(HOOKS_ONLY_MARKER)) {
        const task = trimmed.slice(HOOKS_ONLY_MARKER.length).trim()
        const text = [
          HOOKS_DOCUMENTATION,
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
