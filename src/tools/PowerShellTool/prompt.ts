import { getDefaultBashTimeoutMs, getMaxBashTimeoutMs } from '../../utils/timeouts.js'
import { getMaxOutputLength } from '../../utils/shell/outputLimits.js'
import { PREVIEW_SIZE_CHARS } from '../../utils/toolResultStorage.js'

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
  const output = `Up to ${getMaxOutputLength()} characters come back inline; a longer output is saved to a file, and the result carries its path with about ${PREVIEW_SIZE_CHARS} characters from its start and end. A non-zero exit comes back as an error.`
  const cwd =
    "In the main conversation the working directory persists between calls (a crewmate's does not); shell variables, functions and aliases never do."
  return [opening, output, cwd].join('\n\n')
}
