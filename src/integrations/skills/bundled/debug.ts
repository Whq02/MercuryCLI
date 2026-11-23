import { promises as fsPromises } from 'node:fs'
import { registerBundledSkill } from '../bundledSkills.js'
import { enableDebugLogging, getDebugLogPath } from '../../../platform/logs/debugLog.js'
import { errorMessage } from '../../../platform/errors/errors.js'
import { formatFileSize } from '../../../platform/text/format.js'
import { getSettingsFilePathForSource } from '../../../platform/settings/settings.js'
import { MERCURY_DOCS_SKILL_NAME } from './mercuryDocs.js'

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
    description:
      'Turns on debug logging for the rest of this session and reads the log to diagnose the issue you describe',
    argumentHint: '<issue description>',
    allowedTools: ['Read', 'Grep', 'Glob'],
    disableModelInvocation: true,
    async getPromptForCommand(args: string) {
      const wasActive = enableDebugLogging()
      const logPath = getDebugLogPath()
      const tail = await readLogTail(logPath)
      const lines: string[] = ['Diagnose an issue in the current Mercury session.', '']
      if (!wasActive) {
        lines.push(
          `Debug logging was off until now, so earlier events were not captured. Active log: ${logPath}. Ask the user to reproduce the issue, then re-read it (for startup issues, restart with \`--debug\`).`,
          '',
        )
      }
      lines.push(`Debug log: ${logPath}`, '')
      if (tail.kind === 'tail') {
        lines.push(
          `Last ${TAIL_LINES} lines (${formatFileSize(tail.totalSize)}):`,
          '```',
          tail.text,
          '```',
        )
      } else if (tail.kind === 'missing') {
        lines.push('Debug log file does not exist yet (logging was just enabled).')
      } else {
        lines.push(`Could not read log tail: ${tail.message}`)
      }
      const issue = args.trim()
      lines.push(
        '',
        issue ? `User issue: ${issue}` : 'No issue description given — summarise notable errors.',
      )
      const userSettings = getSettingsFilePathForSource('userSettings') ?? '(none)'
      const projectSettings = getSettingsFilePathForSource('projectSettings') ?? '(none)'
      const localSettings = getSettingsFilePathForSource('localSettings') ?? '(none)'
      lines.push(
        '',
        'Settings files:',
        `- user: ${userSettings}`,
        `- project: ${projectSettings}`,
        `- local: ${localSettings}`,
        '',
        'Steps:',
        `1. Read the ${TAIL_LINES}-line tail above, then Grep the full log file for \`[ERROR]\` and \`[WARN]\`.`,
        '2. Correlate hits with user actions and inspect relevant settings files.',
        `3. Invoke \`${MERCURY_DOCS_SKILL_NAME}\` when checking harness behavior.`,
        '4. Report plain-language findings and concrete next steps.',
      )
      return [{ type: 'text', text: lines.join('\n') }]
    },
  })
}
