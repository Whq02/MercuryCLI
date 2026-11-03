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
  return `Milliseconds the call waits (default ${getDefaultBashTimeoutMs()}, max ${getMaxBashTimeoutMs()}). When it passes, the command moves to the background and keeps running, and the result names its task id; a \`Start-Sleep\`-first command is killed instead.`
}

export async function getPrompt(): Promise<string> {
  return [
    'Runs one PowerShell command and returns its output, stdout and stderr merged in the order written. The output comes back to you, not to the operator.',
    `Up to ${getMaxOutputLength()} characters come back inline; a longer output is saved to a file, and the result carries its path with about ${PREVIEW_SIZE_CHARS} characters from its start and end. A non-zero exit comes back as an error naming the code, except exit 1 from grep, rg, findstr, where, fc, comp, diff or cmp, and a robocopy code under 8, which are results.`,
    'The working directory persists between calls; other shell state does not.',
  ].join('\n\n')
}
