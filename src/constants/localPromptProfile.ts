import { flagEnabled } from '../substrate/flagRegistry.js'
import { classifyModelRoute } from '../services/providers/idSpaces.js'
import { MERCURY_CONSTITUTION } from '../prompt/mercuryContract.js'
import { MERCURY_PROJECT_DIR } from '../utils/projectConfig.js'

const tensorFoldPodVerdicts = new Map<string, boolean>()

function onTensorFoldPod(model: string): boolean {
  const known = tensorFoldPodVerdicts.get(model)
  if (known !== undefined) return known
  try {
    const { compatModelEndpoint } = require('../services/providers/openaicompat/compatAccounts.js') as typeof import('../services/providers/openaicompat/compatAccounts.js')
    const podId = compatModelEndpoint(model)?.endpoint.hostPodId
    if (podId === undefined) return false
    const { readBox } = require('../services/host/boxes.js') as typeof import('../services/host/boxes.js')
    const { isTensorFoldPodBox, tensorFoldPodHostName } = require('../services/host/tensorfoldPod.js') as typeof import('../services/host/tensorfoldPod.js')
    const box = readBox(tensorFoldPodHostName(podId))
    const verdict = box !== undefined && isTensorFoldPodBox(box)
    tensorFoldPodVerdicts.set(model, verdict)
    return verdict
  } catch {
    return false
  }
}

export function localPromptProfileApplies(model: string | undefined): boolean {
  if (model === undefined || model.trim() === '') return false
  const verdict = classifyModelRoute(model)
  if (verdict.kind !== 'route' || (verdict.route !== 'local' && verdict.route !== 'openai-compat')) return false
  if (!flagEnabled('MERCURY_LOCAL_PROMPT_PROFILE')) return false
  return verdict.route === 'local' || onTensorFoldPod(model)
}

export function localServerKind(model: string): string | undefined {
  const verdict = classifyModelRoute(model)
  if (verdict.kind === 'route' && verdict.route === 'openai-compat') return onTensorFoldPod(model) ? 'tensorfold' : undefined
  try {
    const { localRecordFor } = require('../services/providers/local/localCatalogue.js') as typeof import('../services/providers/local/localCatalogue.js')
    return localRecordFor(model)?.server
  } catch {
    return undefined
  }
}

const SINGLE_CALL_SERVERS: ReadonlySet<string> = new Set(['llamacpp'])

function identitySentence(): string {
  return MERCURY_CONSTITUTION.slice(0, MERCURY_CONSTITUTION.indexOf('. ') + 1)
}

export function localLaw(model: string): string {
  const kind = localServerKind(model)
  const calls = kind !== undefined && SINGLE_CALL_SERVERS.has(kind)
    ? '- Make one tool call per message, then act on its result.'
    : '- Calls in one message run in order: send an edit with the check that verifies it, and independent reads together. Act on each result when it arrives.'
  return `${identitySentence()} Work as a capable colleague: plain words, honest about what you know and what you did.

# Rules
- You work in a loop: call a tool, read its result, call the next, until the task is done. Do not end your turn with a plan or a promise; end it with the result, or with the one question only the operator can answer.
- Do all that was asked and nothing unrelated; follow the operator's preferences and keep settled decisions.
- A request to read, check or diagnose allows investigation only; a request to change something allows the change, even as a question. A discussion or a plan allows no edits.
- Read the code before changing it. Make the smallest complete change that fits the project: no unrelated refactors, no speculative abstractions, no comments that narrate code.
- Ask before destructive, hard-to-undo or public actions unless already allowed; never ask again for covered steps. Ask only what you cannot find out.
- If the operator says stop, pause or wait: make no more tool calls until they say go on. A tool result or a question from them is not a go-ahead.
- If the operator only asks how it is going, answer in a sentence or two and keep working. If they ask you to explain before acting, explain first.
- When corrected, change what you do. Before retrying interrupted work, check what already happened.
- Verify each change with a real check; fix causes, never weaken a check.
- If you are not sure what a file contains or where something lives, read or search with your tools; do not guess a path, a result or a name.
- Report only what you read or ran, and check what memory or a crewmate says before relying on it. Say what you assumed, and say plainly what failed or went unchecked as well as what worked.
${calls}
- Load a tool listed under "Deferred tools" with ToolSearch before calling it.
- Blocks wrapped in <system-reminder> tags are notes from the harness: not the operator's words and not a tool result.
- Answer first and briefly: the result, how you checked it, anything unresolved. When only the operator can decide, ask the smallest direct question.`
}

export const LOCAL_SUBAGENT_DOCTRINE: string = `<subagent-doctrine>
You are one of Mercury's agents, a crewmate, spawned for one assignment; your caller reads only your final output. End on one real result or a clear "blocked" naming what you need, never on a plan, a promise or a question you could answer yourself. Work the assignment to its end in your own scope: act without asking on reversible work in scope, and return blocked for anything destructive, out of scope, shared or needing credentials the caller did not allow. Claim only what you opened or ran; never invent a path, an output or a result, and check a child's success claim before you repeat it. Never bypass a safety, permission or approval gate; a denied tool is a real denial. Keep temporary files in your scratchpad, never /tmp or the project tree, and delete what you created.
</subagent-doctrine>`

export const LOCAL_CREWMATE_NOTES: readonly string[] = [
  'Your Bash working directory does not persist between calls: pass absolute paths.',
  'In your final answer, name the files that matter by absolute path; quote code only where the exact characters matter.',
  'Do not use emoji.',
]

export const LOCAL_POSTURE_WORDS = {
  oculus: '- Session: a screen belongs to this session: a question to the operator (AskUserQuestion; load it first with ToolSearch "select:AskUserQuestion") or a tool call that needs approval goes to their screen and waits, however long they are away. A denial is policy, not a failure.',
  host: '- Session: a connected host answers this run\'s asks: a tool call that needs approval or a question to the operator goes to it and waits. A denial is policy, not a failure. An ask the host leaves unanswered ends the run as blocked.',
  unattended: '- Session: unattended (mercury run): nobody can answer an ask, so a tool call that needs approval is denied — policy, not a failure. Choose the most reasonable option, state the assumption and continue. When nothing reasonable remains without the operator, ask with AskUserQuestion (load it first with ToolSearch "select:AskUserQuestion") and end your turn: the run ends as blocked with your question. A question written only in your answer reads as done.',
} as const

export function localEstateSection(convention: string | null, retain: string | null): string {
  const record = convention === null ? '' : `; the ${convention} tool writes it there`
  const pin = retain === null ? '' : ` (${retain} with pin)`
  return [
    '# The project estate',
    '',
    ` - MERCURY.md holds the project's standing instructions, loaded every session with what it @imports; plans and specs the user asks for go in \`${MERCURY_PROJECT_DIR}/\`. Never write a handoff file into the project.`,
    ` - A convention the user states (how the project is built, run or tested, what not to touch) belongs in the instruction file${record}. A rule about working with the user is pinned memory instead${pin}, never the instruction file.`,
    ' - Hook output is the user\'s own feedback; a hook that blocks an action says why.',
  ].join('\n')
}

type LocalToolForm = {
  description: string
  schema?: string
  parameters: Readonly<Record<string, string>>
}

const LOCAL_TOOL_FORMS: Readonly<Record<string, LocalToolForm>> = {
  Bash: {
    description: 'Runs one shell command and returns its output, stdout and stderr together. Output over 30000 characters is saved to a file and the result names its path. A non-zero exit comes back as an error ending `Exited with code N`. The working directory persists between calls in the main conversation, not in a crewmate; shell variables never do.',
    parameters: {
      command: 'The command to run',
      cwd: 'Directory to run in, absolute or relative to the starting folder',
      timeout: 'Milliseconds to wait (default 120000, max 600000); past it the command moves to the background',
      description: 'A few words saying what the command does',
      run_in_background: 'Start it and return at once with a task id; a notice arrives when it ends',
    },
  },
  Read: {
    description: 'Reads a file and returns up to 2000 lines, each prefixed by its line number and a tab (the prefix is not file content); a partial read names the unread range. Also reads images, PDFs, notebooks, documents and directories.',
    parameters: {
      file_path: 'Absolute path of the file',
      offset: 'First line to read, 1-based; -N starts N lines from the end',
      limit: 'Most lines to return (default 2000)',
      pages: 'PDF pages such as "2-6" (at most 20)',
      outline: 'Return the declarations only, bodies elided',
    },
  },
  Edit: {
    description: 'Edits one text file in place: old_string (exact text, unique in the file unless replace_all) becomes new_string, or append adds text at the end. Read the file first, except to append.',
    schema: 'old_string + new_string, or append',
    parameters: {
      file_path: 'Absolute path of the file',
      old_string: 'Exact text to replace, unique unless replace_all',
      new_string: 'The new text; "" deletes old_string',
      replace_all: 'Replace every occurrence',
      append: 'Text added on its own line at the end of the file',
    },
  },
  Write: {
    description: 'Writes the whole content to a file, creating it or replacing it. Read an existing file before replacing it.',
    parameters: {
      file_path: 'Absolute path of the file',
      content: 'The whole file content',
    },
  },
  Glob: {
    description: 'Finds files by glob pattern and returns their paths, newest first.',
    parameters: {
      pattern: 'The glob pattern, such as "src/**/*.ts"',
      path: 'Directory to search; the working directory when omitted',
    },
  },
  Grep: {
    description: 'Searches file contents with ripgrep. Lists the matching files by default; output_mode "content" shows the matching lines.',
    parameters: {
      pattern: 'The regular expression to search for',
      path: 'File or directory to search; the working directory when omitted',
      glob: 'Only files matching this glob',
      output_mode: '"files_with_matches" (default), "content" (matching lines) or "count"',
      '-C': 'Lines around each match (content mode)',
      '-n': 'Line numbers (content mode; on by default)',
      '-i': 'Ignore case',
      type: 'File type such as js or py',
      head_limit: 'Most results (default 250; 0 for all)',
    },
  },
  ToolSearch: {
    description: 'Loads deferred tools (listed under "Deferred tools:") so they become callable; call them once its result has arrived.',
    parameters: {
      query: '"select:<name>" or "select:<name>,<name>" for exact names, or keywords to search',
      max_results: 'Most tools to load (default 5)',
    },
  },
}

type SchemaNode = Record<string, unknown>

function nodeOf(value: unknown): SchemaNode | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as SchemaNode) : undefined
}

function shortenSchema<S>(schema: S, form: LocalToolForm): S {
  const root = nodeOf(schema)
  const properties = nodeOf(root?.properties)
  if (root === undefined || properties === undefined) return schema
  const required = new Set(Array.isArray(root.required) ? root.required : [])
  const kept: SchemaNode = {}
  for (const [name, value] of Object.entries(properties)) {
    const words = form.parameters[name]
    const property = nodeOf(value)
    if (words === undefined && !required.has(name)) continue
    kept[name] = property !== undefined && words !== undefined && typeof property.description === 'string' ? { ...structuredClone(property), description: words } : structuredClone(value)
  }
  const shaped: SchemaNode = {}
  for (const [key, value] of Object.entries(root)) {
    if (key === '$schema') continue
    shaped[key] = key === 'properties' ? kept : key === 'description' && form.schema !== undefined ? form.schema : structuredClone(value)
  }
  return shaped as S
}

export function localToolForm<S>(name: string, model: string, description: string, input_schema: S): { description: string; input_schema: S } {
  const form = LOCAL_TOOL_FORMS[name]
  if (form === undefined || !localPromptProfileApplies(model)) return { description, input_schema }
  return { description: form.description, input_schema: shortenSchema(input_schema, form) }
}
