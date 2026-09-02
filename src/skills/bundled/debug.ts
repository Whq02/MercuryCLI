// ============================================================================
//  src/skills/bundled/debug.ts — /debug: enable session debug logging and
//  hand the model a diagnosis brief over the log tail.
// ============================================================================
import { promises as fsPromises } from 'node:fs'
import { registerBundledSkill } from '../bundledSkills.js'
import { enableDebugLogging, getDebugLogPath } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { formatFileSize } from '../../utils/format.js'
import { getSettingsFilePathForSource } from '../../utils/settings/settings.js'
import { MERCURY_GUIDE_AGENT_TYPE } from '../../tools/AgentTool/built-in/mercuryGuideAgent.js'

// The tail window: both constants appear in the rendered text (heading and
// instruction step), so they are single constants, never repeated literals.
const TAIL_BYTES = 64 * 1024
const TAIL_LINES = 20

async function readLogTail(logPath: string): Promise<
  | { kind: 'tail'; text: string; totalSize: number }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }
> {
  try {
    const stat = await fsPromises.stat(logPath)
    const handle = await fsPromises.open(logPath, 'r')
    try {
      const offset = Math.max(0, stat.size - TAIL_BYTES)
      const length = Math.min(TAIL_BYTES, stat.size)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, offset)
      const lines = buffer.toString('utf8').split('\n')
      return {
        kind: 'tail',
        text: lines.slice(-TAIL_LINES).join('\n'),
        totalSize: stat.size,
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'error', message: errorMessage(error) }
  }
}

export function registerDebugSkill(): void {
  registerBundledSkill({
    name: 'debug',
    description: 'Enable debug logging for this session and help diagnose issues',
    argumentHint: '[issue description]',
    allowedTools: ['Read', 'Grep', 'Glob'],
    disableModelInvocation: true,
    getPromptForCommand: async args => {
      const wasAlreadyOn = enableDebugLogging()
      const logPath = getDebugLogPath()
      const tail = await readLogTail(logPath)

      const justEnabledSection = wasAlreadyOn
        ? ''
        : [
            '',
            'Debug logging was OFF until this invocation, so nothing before now was captured.',
            `Logging is active from this point at ${logPath}. Ask the user to reproduce the issue, then re-read the log.`,
            'To capture startup behaviour instead, they can restart with the --debug flag.',
            '',
          ].join('\n')

      let tailSection: string
      if (tail.kind === 'tail') {
        tailSection = [
          `Last ${TAIL_LINES} lines of the log (file size ${formatFileSize(tail.totalSize)}):`,
          '```',
          tail.text,
          '```',
        ].join('\n')
      } else if (tail.kind === 'missing') {
        tailSection = 'The debug log file does not exist yet — logging was just enabled.'
      } else {
        tailSection = `The log tail could not be read: ${tail.message}`
      }

      const issueSection = args.trim()
        ? `The user describes the issue as: ${args.trim()}`
        : 'The user gave no issue description — summarise the notable errors yourself.'

      const text = [
        'Diagnose an issue in the CURRENT Mercury session.',
        justEnabledSection,
        `Debug log path: ${logPath}`,
        '',
        tailSection,
        '',
        `Grep the WHOLE log file for the [ERROR] and [WARN] markers, not only the ${TAIL_LINES}-line tail above.`,
        '',
        issueSection,
        '',
        'Settings files that may be involved:',
        `- user: ${getSettingsFilePathForSource('userSettings') ?? '(none)'}`,
        `- project: ${getSettingsFilePathForSource('projectSettings') ?? '(none)'}`,
        `- local: ${getSettingsFilePathForSource('localSettings') ?? '(none)'}`,
        '',
        'Procedure:',
        '1. Read the tail above, then grep the full log for [ERROR] and [WARN].',
        '2. Correlate hits with what the user was doing; read the relevant settings files.',
        `3. Consult the ${MERCURY_GUIDE_AGENT_TYPE} subagent when you need to understand a harness feature.`,
        '4. Finish with plain-language findings and concrete next steps.',
      ].join('\n')

      return [{ type: 'text', text }]
    },
  })
}
