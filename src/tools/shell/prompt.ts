import { getDefaultBashTimeoutMs, getMaxBashTimeoutMs } from '../kit/timeouts.js'
import { getMaxOutputLength, getMinOutputLength } from '../../platform/shell/outputLimits.js'
import { PREVIEW_SIZE_CHARS } from '../../engine/tool-dispatch/toolResultStorage.js'
import { resolveShellEngine, resolveEngineSessionCeiling } from '../../platform/shell/engineSession.js'
import { loginFilesNotCarried, profileShellWords, shellRecordNow } from '../../platform/shell/shellRecord.js'
import { windowsBashAbsent } from '../../platform/shell/windowsShellRoad.js'
import { getInitialSettings } from '../../platform/settings/settings.js'
import { ideTerminalAvailable } from '../../integrations/acp/ideToolBridge.js'


export function getDefaultTimeoutMs(): number {
  return getDefaultBashTimeoutMs()
}

export function getMaxTimeoutMs(): number {
  return getMaxBashTimeoutMs()
}

export function describeMaxOutputChars(): string {
  return `Inline character budget: a longer output comes back as its head and tail around a notice of the cut. Default and cap ${getMaxOutputLength()}, floor ${getMinOutputLength()}; a value outside is clamped and the result says so. Ignored by run_in_background.`
}

export function describeTimeout(): string {
  return `Milliseconds the call waits (default ${getDefaultBashTimeoutMs()}, max ${getMaxBashTimeoutMs()}). When it passes, the command moves to the background and keeps running, and the result names the task id TaskStop takes; a \`sleep\`-first command, or any command under the shell engine, is killed instead.`
}

export function describeCommandDescription(): string {
  return 'A few words naming what the command does, shown to the operator.'
}

export function describeRunInBackground(): string {
  return 'Start the command and return at once with a task id and an output file. A notice with its exit code reaches you when it ends; the command is stopped when the run that started it ends.'
}

export const EDITOR_TERMINAL_RESULT_NOTE =
  'This command ran in the editor terminal: its working directory and shell variables end with the call; start a command that needs a directory with `cd dir && …` in the same call.'

const EDITOR_TERMINAL_PARAGRAPH =
  "Editor terminal: in this session a foreground command from the main conversation runs in a fresh terminal of the editor, in the session folder. The editor is asked to start there the same shell a `run_in_background` command runs in, so the command is read as it is everywhere else; when the editor cannot start it the command runs in the local shell and the result says so. The working directory and shell variables do not carry to the next call, so a command that needs a directory starts with `cd dir && …` in the same call. A `run_in_background` command and a crewmate's command run in the shell described above."


export function getSimplePrompt(offered: ReadonlySet<string> | null = null): string {
  void offered
  const shell = shellRecordNow()
  const brush = shell?.origin === 'engine'
  const sections: string[] = []
  sections.push(
    'Runs one shell command and returns its output, stdout and stderr merged in the order written. The output comes back to you; the operator sees at most a folded preview.',
  )
  if (brush) sections.push('When `timeout` passes, the command is killed (exit 143) and the shell session resets.')
  sections.push(buildOutputParagraph())
  if (brush) {
    sections.push(...brushShellParagraphs(windowsBashAbsent() || resolveShellEngine(getInitialSettings().shell?.engine).engine !== 'brush'))
  } else {
    sections.push(
      `In the main conversation the working directory persists between calls (a crewmate's does not); shell variables, functions and options never do, and ${loginFilesNotCarried() === null ? `each call starts from your profile (${profileShellWords(shell)})` : `no call carries the aliases, functions or options of your profile (${profileShellWords(shell)}) in this session`}.`,
    )
  }
  if (ideTerminalAvailable()) sections.push(EDITOR_TERMINAL_PARAGRAPH)
  return sections.join('\n\n')
}

function buildOutputParagraph(): string {
  return `Up to ${getMaxOutputLength()} characters come back inline; a longer output is saved to a file, and the result carries its path with about ${PREVIEW_SIZE_CHARS} characters from its start and end. A non-zero exit comes back as an error ending \`Exited with code N\`, except exit 1 when the last command is grep, rg, find, diff, cmp, pgrep, test, \`[\`, which or \`command -v\`: a result labelled with what the exit means, such as \`no matches found (exit code 1)\`.`
}

function brushShellParagraphs(backgroundInEngine: boolean): string[] {
  const paragraphs: string[] = []
  paragraphs.push(
    'One shell session serves the whole conversation: the working directory, variables, functions, aliases and options persist from call to call. Each crewmate has a shell session of its own, which ends with the crewmate. An operator stop ends the command and resets the session, as do a bare `exit` or a `set -u` failure; the result says when earlier state was lost. A `run_in_background` call runs in its own shell and shares no state with the session.',
  )
  const ceiling = resolveEngineSessionCeiling(getInitialSettings().shell?.sessions)
  paragraphs.push(
    ceiling === 1
      ? `The shell.sessions setting is 1: only the main conversation has an engine session. A crewmate's call is refused with the reason; a \`run_in_background\` call still runs, in its own ${backgroundInEngine ? 'engine process' : 'system shell'}.`
      : `At most ${ceiling} engine sessions are kept alive at once (the shell.sessions setting): the main conversation's own and ${ceiling - 1} for crewmates. A crewmate that needs one when all are in use waits for a free session, bounded by the call's timeout.`,
  )
  return paragraphs
}
