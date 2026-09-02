import { validateBoundedIntEnvVar } from '../envValidation.js'
import { getTaskOutputPath } from './diskOutput.js'


export const TASK_MAX_OUTPUT_UPPER_LIMIT = 160_000
export const TASK_MAX_OUTPUT_DEFAULT = 32_000

function getMaxTaskOutputLength(): number {
  return validateBoundedIntEnvVar(
    'TASK_MAX_OUTPUT_LENGTH',
    process.env.TASK_MAX_OUTPUT_LENGTH,
    TASK_MAX_OUTPUT_DEFAULT,
    TASK_MAX_OUTPUT_UPPER_LIMIT,
  ).effective
}

export function formatTaskOutput(output: string, taskId: string): { content: string; wasTruncated: boolean } {
  const limit = getMaxTaskOutputLength()
  if (output.length <= limit) {
    return { content: output, wasTruncated: false }
  }
  const header = `<task output truncated — the complete output is saved at ${getTaskOutputPath(taskId)}>`
  const budget = limit - (header.length + 2)
  return { content: `${header}\n\n${output.slice(-budget)}`, wasTruncated: true }
}
