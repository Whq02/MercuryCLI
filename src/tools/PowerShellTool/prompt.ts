/**
 * The PowerShell tool's model-visible prompt, plus two thin timeout accessors
 * that delegate to the shared bash timeout owners. The background and sleep
 * guidance is omitted when background tasks are disabled at module load.
 */
import { getDefaultBashTimeoutMs, getMaxBashTimeoutMs } from '../../utils/timeouts.js'

export function getDefaultTimeoutMs(): number {
  return getDefaultBashTimeoutMs()
}

export function getMaxTimeoutMs(): number {
  return getMaxBashTimeoutMs()
}

/** Always enabled: no background-tasks env kill exists. */
const BACKGROUND_DISABLED = false

function minutes(ms: number): number {
  return Math.round(ms / 60000)
}

/** Build the PowerShell tool's model-visible description. */
export async function getPrompt(): Promise<string> {
  const maxMs = getMaxBashTimeoutMs()
  const defaultMs = getDefaultBashTimeoutMs()
  const sections: string[] = [
    'Executes a PowerShell command and returns its combined output. Use this on Windows for PowerShell-native work; prefer the dedicated file and search tools when one exists.',
    'Command output comes back to you, the model — the operator does not reliably see it. Anything they need from a command belongs in your reply.',
    'The current working directory carries over between commands; other session state does not.',
    `# Instructions\n- Always quote any path carrying spaces.\n- Absolute paths over Set-Location; reach for Set-Location only on the user's ask.\n- The optional \`timeout\` rides in milliseconds, capped at ${maxMs} ms (${minutes(maxMs)} minutes); it defaults to ${defaultMs} ms (${minutes(defaultMs)} minutes) when omitted.`,
  ]
  if (!BACKGROUND_DISABLED) {
    sections.push(
      'Use the `run_in_background` parameter when a result is not needed immediately: the command runs in the background, you are notified on completion, and no trailing `&` is required.',
    )
    sections.push(
      'Avoid a standalone leading sleep to wait for a condition — use the Monitor tool with an until-loop instead, or `run_in_background` to wait on a command you already started. Chaining shorter sleeps to defeat the block is not allowed.',
    )
  }
  return sections.join('\n\n')
}
