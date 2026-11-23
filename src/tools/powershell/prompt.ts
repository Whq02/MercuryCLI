import { getDefaultBashTimeoutMs, getMaxBashTimeoutMs } from '../kit/timeouts.js'
import { getMaxOutputLength } from '../../platform/shell/outputLimits.js'
import { PREVIEW_SIZE_CHARS } from '../../engine/tool-dispatch/toolResultStorage.js'

export function getDefaultTimeoutMs(): number {
  return getDefaultBashTimeoutMs()
}

export function getMaxTimeoutMs(): number {
  return getMaxBashTimeoutMs()
}

export function describeTimeout(): string {
  return `Milliseconds the call waits (default ${getDefaultTimeoutMs()}, max ${getMaxTimeoutMs()}). When it passes, the command moves to the background and keeps running, and the result names the task id TaskStop takes; a \`Start-Sleep\`-first command is killed instead.`
}

export async function getPrompt(): Promise<string> {
  const opening =
    'Runs one PowerShell command and returns its output, stdout and stderr merged in the order written. The output comes back to you; the operator sees at most a folded preview.'
  const output = `Up to ${getMaxOutputLength()} characters come back inline; a longer output is saved to a file, and the result carries its path with about ${PREVIEW_SIZE_CHARS} characters from its start and end. A non-zero exit comes back as an error naming the code, except exit 1 when the last command is grep, rg, findstr, where, fc, comp, diff or cmp, or a robocopy code under 8, which are results labelled with what the exit means.`
  const cwd =
    "In the main conversation the working directory persists between calls (a crewmate's does not); other shell state never does."
  return [opening, output, cwd].join('\n\n')
}
