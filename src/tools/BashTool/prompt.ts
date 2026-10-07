import { getDefaultBashTimeoutMs, getMaxBashTimeoutMs } from '../../utils/timeouts.js'
import { getMaxOutputLength, getMinOutputLength } from '../../utils/shell/outputLimits.js'
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
  const sections: string[] = []

  sections.push('Runs a shell command in the session bash and hands back its combined output (stdout and stderr interleaved).')
  sections.push(
    'Command output comes back to you, the model — the operator does not reliably see it. Anything they need from a command belongs in your reply.',
  )
  if (resolveShellEngine(getInitialSettings().shell?.engine).engine === 'brush') {
    sections.push(
      'One shell session serves the whole conversation: the working directory and every other piece of shell state — variables, functions, aliases, options — persist from call to call. Each crewmate has a shell session of its own: state set by one agent is not seen by another or by the main conversation, and an agent\'s session ends with the agent. A command that hangs and is timed out, or that ends the shell (a bare `exit`, a `set -u` failure), resets the session; you are told when earlier state was lost. A stop from the operator while a command runs ends that command and resets the session; the result says so. A call with `run_in_background` runs in its own shell: it does not see the session\'s state, and its own does not persist.',
    )
    const ceiling = resolveEngineSessionCeiling(getInitialSettings().shell?.sessions)
    sections.push(
      ceiling === 1
        ? 'The shell.sessions setting is 1: only the main conversation has an engine session. A crewmate\'s call is refused with the reason; a `run_in_background` call still runs, in its own system shell.'
        : `At most ${ceiling} engine sessions are kept alive at once (the shell.sessions setting): the main conversation's own and ${ceiling - 1} for crewmates. A crewmate that needs one when all are in use waits for a free session — never sharing another's — and the wait is bounded by the call's timeout.`,
    )
    if (getPlatform() === 'windows') {
      sections.push(
        'On Windows the engine has two known holes at this version: a `.cmd` shim such as `npm` or `npx` fails with os error 193 (exit 126) — run it through `cmd /c npm …`, or call `node` on the script directly — and a relative program path after a `cd` is not found — call it by its absolute path.',
      )
    }
  } else {
    sections.push(
      'The working directory persists from call to call; every other piece of shell state (variables, functions, options) resets between calls. Each call starts from your profile (bash or zsh).',
    )
  }

  const avoidSet = embedded
    ? ['cat', 'head', 'tail', 'sed', 'awk', 'echo']
    : ['find', 'grep', 'cat', 'head', 'tail', 'sed', 'awk', 'echo']
  sections.push(
    `Avoid running ${avoidSet.map(c => `\`${c}\``).join(', ')} through this tool unless you are explicitly asked to, or you have verified that no dedicated tool can do the job. A dedicated tool is a better experience.`,
  )

  const preferenceBullets: string[] = []
  if (!embedded) {
    preferenceBullets.push(`File search: use the ${GLOB_TOOL_NAME} tool, not \`find\` or \`ls\`.`)
    preferenceBullets.push(`Content search: ${GREP_TOOL_NAME} is the search path here — never shell \`grep\`/\`rg\`.`)
  }
  preferenceBullets.push(`Reading a file: ${FILE_READ_TOOL_NAME} owns it — never \`cat\`/\`head\`/\`tail\`.`)
  preferenceBullets.push(`Editing a file: ${FILE_EDIT_TOOL_NAME} owns it — never \`sed\`/\`awk\`.`)
  preferenceBullets.push(`Write files: use the ${FILE_WRITE_TOOL_NAME} tool, not \`echo >\` or a heredoc.`)
  preferenceBullets.push('Talking to the user: write it in your reply — an `echo`/`printf` reaches nobody.')
  sections.push(preferenceBullets.map(b => `- ${b}`).join('\n'))

  sections.push(
    "When a dedicated tool exists, it's the stronger path: purpose-built calls render better for the operator and are simpler to review and permission.",
  )

  sections.push(buildInstructions(embedded, offers))

  sections.push(buildSandboxSection())

  return sections.join('\n\n')
}

function minutes(ms: number): number {
  return Math.round(ms / 60000)
}

function buildInstructions(embedded: boolean, offers: (name: string) => boolean): string {
  const maxMs = getMaxBashTimeoutMs()
  const defaultMs = getDefaultBashTimeoutMs()
  const bullets: string[] = [
    'Before creating a directory or file, `ls` the parent — confirm it exists and is the location you mean.',
    'A path with spaces travels double-quoted, always.',
    'Keep the working directory stable: absolute paths instead of `cd` (a `cd` is fine when the user asks for one).',
    `The optional \`timeout\` parameter takes a value in milliseconds, up to a maximum of ${maxMs} ms (${minutes(maxMs)} minutes); when omitted it defaults to ${defaultMs} ms (${minutes(defaultMs)} minutes).`,
    maxOutputCharsBullet(),
  ]
  bullets.push(
    'Set `run_in_background: true` when the result can wait: the command detaches (no trailing `&`) and completion is notified.',
  )
  bullets.push(
    'When issuing multiple commands:\n  - independent commands should be separate parallel tool calls in one message (for example, one call for `git status` and another for `git diff`);\n  - dependent commands should be one call chained with `&&`; use `;` only when an earlier failure does not matter;\n  - commands never separate on a bare newline (newlines WITHIN a quoted string are fine).',
  )
  bullets.push(
    'Avoid unnecessary sleeps: never sleep between commands that are ready to run; use `run_in_background` for long-running work rather than sleeping; diagnose a failing command instead of re-running it in a sleep-and-retry loop; do not poll a task started with `run_in_background`, since completion is notified; if an external process must be polled, use a status command (for example `gh run view <run-id>`) rather than sleeping first; and if a sleep is truly unavoidable, keep it to roughly 1-5 seconds so the user is not blocked.',
  )
  if (offers('Browser')) {
    bullets.push(
      `To drive a web page — click, type, wait for an element, read rendered text or console errors, screenshot — use the \`Browser\` tool${offers('ToolSearch') ? ' (when deferred, load it with ToolSearch `select:Browser`)' : ''}. Never hand-roll a headless-Chrome harness or install a browser driver (\`npm i puppeteer\`, \`npx playwright install\`) for a one-off check; the driver is bundled and already resolved.`,
    )
  }
  if (embedded) {
    bullets.push(
      "The embedded `find` implementation's `-regex` uses leftmost-first alternation (unlike GNU find's leftmost-longest), so list the longest alternative first: prefer `'.*\\.tsx?'` written as `.tsx|.ts`, not `.ts|.tsx`.",
    )
  }
  return `# Instructions\n${bullets.map(b => `- ${b}`).join('\n')}`
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
