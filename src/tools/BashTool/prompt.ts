import { getDefaultBashTimeoutMs, getMaxBashTimeoutMs } from '../../utils/timeouts.js'
import { getMaxOutputLength, getMinOutputLength } from '../../utils/shell/outputLimits.js'
import { PREVIEW_SIZE_CHARS } from '../../utils/toolResultStorage.js'
import { resolveShellEngine, resolveEngineSessionCeiling } from '../../utils/shell/engineSession.js'
import { windowsBashAbsent } from '../../utils/shell/windowsShellRoad.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { hasEmbeddedSearchTools } from '../../utils/embeddedTools.js'
import { ideTerminalAvailable } from '../../services/acp/ideToolBridge.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'


export function getDefaultTimeoutMs(): number {
  return getDefaultBashTimeoutMs()
}

export function getMaxTimeoutMs(): number {
  return getMaxBashTimeoutMs()
}

export function describeMaxOutputChars(): string {
  return `Inline character budget: a longer output comes back as its head and tail around a notice of the cut. Default and cap ${getMaxOutputLength()}, floor ${getMinOutputLength()} (a value outside is clamped, and the result says so). Ignored by run_in_background.`
}

export function describeTimeout(): string {
  return `Milliseconds the call waits (default ${getDefaultBashTimeoutMs()}, max ${getMaxBashTimeoutMs()}). When it passes, the command moves to the background and keeps running; a \`sleep\`-first command, or any command under the shell engine, is killed instead.`
}

export function describeCommandDescription(): string {
  return 'What the command does, in five to ten words of active voice, shown to the operator: for example "List files in the current directory". Do not use the words "complex" or "risk".'
}

export function describeRunInBackground(): string {
  return 'Start the command and return at once with a task id and an output file; the tool description says when its end is reported and when it is stopped.'
}

export function maxOutputCharsBullet(): string {
  return 'The optional `max_output_chars` parameter bounds this call\'s inline output to its head and tail (the field\'s description has the bounds): pass a small value for a huge log where only the beginning and the verdict at the end matter.'
}

export const EDITOR_TERMINAL_RESULT_NOTE =
  'This command ran in the editor terminal: its working directory and shell variables end with the call; start a command that needs a directory with `cd dir && …` in the same call.'

const EDITOR_TERMINAL_PARAGRAPH =
  "Editor terminal: in this session a foreground command from the main conversation runs in a fresh terminal of the editor, in the session folder, not in the shell described above. The working directory and shell variables do not carry to the next call, so a command that needs a directory starts with `cd dir && …` in the same call. A `run_in_background` command and a crewmate's command run in the shell described above."


export function getSimplePrompt(offered: ReadonlySet<string> | null = null): string {
  const embedded = hasEmbeddedSearchTools()
  const offers = (name: string): boolean => offered === null || offered.has(name)
  const brush = resolveShellEngine(getInitialSettings().shell?.engine).engine === 'brush'
  const sections: string[] = []
  sections.push(
    'Runs one shell command and returns its output: stdout and stderr merged, in the order written. It comes back to you; the operator does not reliably see it, so put what they need in your reply.',
  )
  sections.push(buildTimeoutParagraph(brush, offers))
  sections.push(buildOutputParagraph())
  sections.push(
    "Background: when a `run_in_background: true` command ends, a notice with its exit code reaches you after your next tool result, or in a new turn if the session outlives your turn. It is stopped when the run that started it ends: a crewmate's run when the crewmate finishes, and a `mercury run` given its prompt at launch when your turn ends (unless a crewmate is still running); then no notice comes. The start result says which applies and how to wait. Never poll with repeated calls." +
      (offers('Service') ? ` A process that must stay up after the run that started it (a server something checks once the run has ended) is a \`Service\` with lifecycle project${offers('ToolSearch') ? ' (ToolSearch `select:Service` loads it when deferred)' : ''}, not a background shell.` : ''),
  )
  if (brush) {
    sections.push(...brushShellParagraphs())
    sections.push('Prefer absolute paths or `cwd` to `cd`, and double-quote a path with spaces.')
  } else {
    sections.push(
      'Shell: the working directory persists between calls; variables, functions and options do not, and each call starts from your profile (bash or zsh). Prefer absolute paths or `cwd` to `cd`, and double-quote a path with spaces.',
    )
  }
  if (ideTerminalAvailable()) sections.push(EDITOR_TERMINAL_PARAGRAPH)
  sections.push(buildToolsParagraph(embedded, offers))
  if (embedded) {
    sections.push(
      "The embedded `find` implementation's `-regex` uses leftmost-first alternation (unlike GNU find's leftmost-longest), so list the longest alternative first: prefer `'.*\\.tsx?'` written as `.tsx|.ts`, not `.ts|.tsx`.",
    )
  }
  if (offers('Browser')) {
    sections.push(
      `To drive a web page, use the \`Browser\` tool${offers('ToolSearch') ? ' (ToolSearch `select:Browser` loads it when deferred)' : ''}; never install a browser driver for a one-off check.`,
    )
  }
  return sections.join('\n\n')
}

function buildTimeoutParagraph(brush: boolean, offers: (name: string) => boolean): string {
  if (brush) {
    return 'When `timeout` passes, the command is killed (exit 143) and the shell session resets. For work that may take longer, use `run_in_background`.'
  }
  const stop = offers('TaskStop')
    ? ` TaskStop with that id ends it and the processes under it${offers('ToolSearch') ? ' (ToolSearch `select:TaskStop` loads TaskStop when it is deferred)' : ''}. So to bound a command that may hang, pass a short \`timeout\`, then TaskStop it; no watchdog script is needed.`
    : ''
  return `When \`timeout\` passes, the result shows the command's output so far and a task id.${stop}`
}

function buildOutputParagraph(): string {
  return `Output: up to ${getMaxOutputLength()} characters come back whole. A longer output is saved to a file, and you get its size, its path and about ${PREVIEW_SIZE_CHARS} characters from its start and end. A smaller \`max_output_chars\` narrows that inline budget. A non-zero exit comes back as an error ending \`Exited with code N\`, except exit 1 when the last command is grep, rg, find, diff, cmp, pgrep, test, \`[\`, which or \`command -v\`: that is a result with a label such as \`no matches found (exit code 1)\`.`
}

function buildToolsParagraph(embedded: boolean, offers: (name: string) => boolean): string {
  const roads: Array<[string, string]> = [
    ...(embedded ? [] : [[GLOB_TOOL_NAME, 'to find files'], [GREP_TOOL_NAME, 'to search contents']] as Array<[string, string]>),
    [FILE_READ_TOOL_NAME, 'to read a file'],
    [FILE_EDIT_TOOL_NAME, 'to change one'],
    [FILE_WRITE_TOOL_NAME, 'to create one'],
  ]
  const named = roads.filter(([name]) => offers(name)).map(([name, road]) => `${name} ${road}`)
  const prefer = named.length > 0 ? `Prefer the dedicated tools when they fit: ${named.join(', ')}. ` : ''
  return `${prefer}Chain dependent commands with \`&&\` (\`;\` only when an earlier failure does not matter); a bare newline does not separate commands.`
}

function brushShellParagraphs(): string[] {
  const paragraphs: string[] = []
  paragraphs.push(
    'One shell session serves the whole conversation: the working directory and every other piece of shell state — variables, functions, aliases, options — persist from call to call. Each crewmate has a shell session of its own: state set by one crewmate is not seen by another or by the main conversation, and a crewmate\'s session ends with the crewmate. A command that hangs and is timed out, or that ends the shell (a bare `exit`, a `set -u` failure), resets the session; you are told when earlier state was lost. A stop from the operator while a command runs ends that command and resets the session; the result says so. A call with `run_in_background` runs in its own shell: it does not see the session\'s state, and its own does not persist.',
  )
  const ceiling = resolveEngineSessionCeiling(getInitialSettings().shell?.sessions)
  paragraphs.push(
    ceiling === 1
      ? `The shell.sessions setting is 1: only the main conversation has an engine session. A crewmate's call is refused with the reason; a \`run_in_background\` call still runs, in its own ${windowsBashAbsent() ? 'engine process' : 'system shell'}.`
      : `At most ${ceiling} engine sessions are kept alive at once (the shell.sessions setting): the main conversation's own and ${ceiling - 1} for crewmates. A crewmate that needs one when all are in use waits for a free session — never sharing another's — and the wait is bounded by the call's timeout.`,
  )
  return paragraphs
}
