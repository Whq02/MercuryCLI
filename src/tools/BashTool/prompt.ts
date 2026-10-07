import { getDefaultBashTimeoutMs, getMaxBashTimeoutMs } from '../../utils/timeouts.js'
import { getMaxOutputLength, getMinOutputLength } from '../../utils/shell/outputLimits.js'
import { PREVIEW_SIZE_CHARS } from '../../utils/toolResultStorage.js'
import { resolveShellEngine, resolveEngineSessionCeiling } from '../../utils/shell/engineSession.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { getPlatform } from '../../utils/platform.js'
import { hasEmbeddedSearchTools } from '../../utils/embeddedTools.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getMercuryTempDir } from '../../utils/permissions/filesystem.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
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
  const passes =
    resolveShellEngine(getInitialSettings().shell?.engine).engine === 'brush'
      ? 'When it passes, the command is killed and the shell session resets.'
      : 'When it passes, the command moves to the background and keeps running; a command whose first word is `sleep` is killed instead.'
  return `Milliseconds the call waits (default ${getDefaultBashTimeoutMs()}, max ${getMaxBashTimeoutMs()}). ${passes}`
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
    "Background: `run_in_background: true` returns at once with a task id and an output file. When the command ends, a notice with its exit code reaches you after your next tool result, or in a new turn if the session outlives your turn. It is stopped when the run that started it ends: a crewmate's run when the crewmate finishes, and a `mercury run` given its prompt at launch when your turn ends (unless a crewmate is still running); then no notice comes. The start result says which applies and how to wait. Never poll with repeated calls.",
  )
  if (brush) {
    sections.push(...brushShellParagraphs())
    sections.push('Prefer absolute paths to `cd`, and double-quote a path with spaces.')
  } else {
    sections.push(
      'Shell: the working directory persists between calls; variables, functions and options do not, and each call starts from your profile (bash or zsh). Prefer absolute paths to `cd`, and double-quote a path with spaces.',
    )
  }
  sections.push(buildToolsParagraph(embedded))
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
  const sandbox = buildSandboxSection()
  if (sandbox !== '') sections.push(sandbox)
  return sections.join('\n\n')
}

function minutes(ms: number): number {
  return Math.round(ms / 60000)
}

function buildTimeoutParagraph(brush: boolean, offers: (name: string) => boolean): string {
  const maxMs = getMaxBashTimeoutMs()
  const defaultMs = getDefaultBashTimeoutMs()
  const figures = `Timeout: \`timeout\` is in milliseconds, default ${defaultMs} (${minutes(defaultMs)} minutes), at most ${maxMs} (${minutes(maxMs)} minutes).`
  if (brush) {
    return `${figures} When it passes, the command is killed (exit 143) and the shell session resets. For work that may take longer, use \`run_in_background\`.`
  }
  const stop = offers('TaskStop')
    ? ` TaskStop with that id ends it and the processes under it${offers('ToolSearch') ? ' (ToolSearch `select:TaskStop` loads TaskStop when it is deferred)' : ''}. So to bound a command that may hang, pass a short \`timeout\`, then TaskStop it; no watchdog script is needed.`
    : ''
  return `${figures} When it passes, the command is not killed: it moves to the background, and the result shows its output so far and a task id.${stop} A command whose first word is \`sleep\` is killed at its timeout instead.`
}

function buildOutputParagraph(): string {
  return `Output: up to ${getMaxOutputLength()} characters come back whole. A longer output is saved to a file, and you get its size, its path and about ${PREVIEW_SIZE_CHARS} characters from its start and end. \`max_output_chars\` (${getMinOutputLength()} to ${getMaxOutputLength()}) keeps only the head and the tail of a long output. Every cut is marked. A non-zero exit comes back as an error ending \`Exited with code N\`, except exit 1 when the last command is grep, rg, find, diff, cmp, pgrep, test, \`[\`, which or \`command -v\`: that is a result with a label such as \`no matches found (exit code 1)\`.`
}

function buildToolsParagraph(embedded: boolean): string {
  const search = embedded ? '' : `${GLOB_TOOL_NAME} to find files, ${GREP_TOOL_NAME} to search contents, `
  return `Prefer the dedicated tools when they fit: ${search}${FILE_READ_TOOL_NAME} to read a file, ${FILE_EDIT_TOOL_NAME} to change one, ${FILE_WRITE_TOOL_NAME} to create one. Run independent commands as parallel calls; chain dependent ones with \`&&\` (\`;\` only when an earlier failure does not matter). A bare newline does not separate commands.`
}

function brushShellParagraphs(): string[] {
  const paragraphs: string[] = []
  paragraphs.push(
    'One shell session serves the whole conversation: the working directory and every other piece of shell state — variables, functions, aliases, options — persist from call to call. Each crewmate has a shell session of its own: state set by one agent is not seen by another or by the main conversation, and an agent\'s session ends with the agent. A command that hangs and is timed out, or that ends the shell (a bare `exit`, a `set -u` failure), resets the session; you are told when earlier state was lost. A stop from the operator while a command runs ends that command and resets the session; the result says so. A call with `run_in_background` runs in its own shell: it does not see the session\'s state, and its own does not persist.',
  )
  const ceiling = resolveEngineSessionCeiling(getInitialSettings().shell?.sessions)
  paragraphs.push(
    ceiling === 1
      ? 'The shell.sessions setting is 1: only the main conversation has an engine session. A crewmate\'s call is refused with the reason; a `run_in_background` call still runs, in its own system shell.'
      : `At most ${ceiling} engine sessions are kept alive at once (the shell.sessions setting): the main conversation's own and ${ceiling - 1} for crewmates. A crewmate that needs one when all are in use waits for a free session — never sharing another's — and the wait is bounded by the call's timeout.`,
  )
  if (getPlatform() === 'windows') {
    paragraphs.push(
      'On Windows the engine has two known holes at this version: a `.cmd` shim such as `npm` or `npx` fails with os error 193 (exit 126) — run it through `cmd /c npm …`, or call `node` on the script directly — and a relative program path after a `cd` is not found — call it by its absolute path.',
    )
  }
  return paragraphs
}

function buildSandboxSection(): string {
  if (!SandboxManager.isSandboxingEnabled()) return ''
  const unsandboxedAllowed = SandboxManager.areUnsandboxedCommandsAllowed()
  const lines: string[] = ['# Command sandbox']
  lines.push(
    'Commands run in a sandbox by default: it bounds which directories and network hosts a command can touch or change unless explicitly overridden.',
  )
  lines.push('The active restrictions are:')

  const fsWrite = SandboxManager.getFsWriteConfig()
  const fsRead = SandboxManager.getFsReadConfig()
  const tempDir = getMercuryTempDir()
  const filesystem: Record<string, unknown> = {
    read: fsRead.allowWithinDeny
      ? { denyOnly: dedupe(fsRead.denyOnly), allowWithinDeny: dedupe(fsRead.allowWithinDeny) }
      : { denyOnly: dedupe(fsRead.denyOnly) },
    write: {
      allowOnly: dedupeAndNormaliseTemp(fsWrite.allowOnly, tempDir),
      denyWithinAllow: dedupe(fsWrite.denyWithinAllow),
    },
  }
  lines.push(`- Filesystem: ${jsonStringify(filesystem)}`)

  const network = SandboxManager.getNetworkRestrictionConfig()
  const sockets = SandboxManager.getAllowUnixSockets()
  const networkObject: Record<string, unknown> = {}
  if (network.allowedHosts && network.allowedHosts.length > 0) networkObject.allowedHosts = dedupe(network.allowedHosts)
  if (network.deniedHosts && network.deniedHosts.length > 0) networkObject.deniedHosts = dedupe(network.deniedHosts)
  if (sockets && sockets.length > 0) networkObject.allowedUnixSockets = dedupe(sockets)
  if (Object.keys(networkObject).length > 0) lines.push(`- Network: ${jsonStringify(networkObject)}`)

  const ignored = SandboxManager.getIgnoreViolations()
  if (ignored) lines.push(`- Ignored violations: ${jsonStringify(ignored)}`)

  if (unsandboxedAllowed) {
    lines.push(
      '- Default to running inside the sandbox. Reach for `dangerouslyDisableSandbox: true` only when the user has asked outright for an unsandboxed run (most failures have nothing to do with the sandbox).',
    )
    lines.push(
      '- When a sandboxed command fails on a recorded violation, the harness itself asks once, inside the same call, whether to rerun it outside the sandbox, and the result says how that went; never retry by hand with the override. A failure with no recorded violation is not a sandbox failure. The `/sandbox` command manages the restrictions.',
    )
    lines.push('- Treat each overridden command individually; a recent override does not carry forward.')
    lines.push(
      '- Never suggest adding sensitive paths to the sandbox allowlist (`~/.bashrc`, `~/.zshrc`, `~/.ssh/*`, credential files).',
    )
  } else {
    lines.push('- Every command here runs sandboxed; policy has switched the `dangerouslyDisableSandbox` parameter off.')
    lines.push('- There is no circumstance in which a command runs outside the sandbox.')
    lines.push('- Resolve a sandbox-caused failure by adjusting the sandbox settings with the user.')
  }
  lines.push(
    'Temporary files belong under `$TMPDIR` — it already points at the sandbox-writable temp directory; never spell /tmp paths yourself.',
  )
  return lines.join('\n')
}


function dedupe(list: string[] | undefined): string[] | undefined {
  if (!list || list.length === 0) return list
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    if (!seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  return out
}

function dedupeAndNormaliseTemp(list: string[] | undefined, tempDir: string): string[] | undefined {
  if (!list || list.length === 0) return list
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    const value = item === tempDir ? '$TMPDIR' : item
    if (!seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return out
}
