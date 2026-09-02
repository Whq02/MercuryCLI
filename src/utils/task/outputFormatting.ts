import { validateBoundedIntEnvVar } from '../envValidation.js'
import { getTaskOutputPath } from './diskOutput.js'

/**
 * Truncates a task's captured output down to the model-facing size limit,
 * pointing at the full file on disk.
 *
 * `TASK_MAX_OUTPUT_LENGTH` is a bare external compat spelling — read
 * straight from the process environment, never renamed, never registered
 * as a Mercury flag.
 */

export const TASK_MAX_OUTPUT_UPPER_LIMIT = 160_000
export const TASK_MAX_OUTPUT_DEFAULT = 32_000

// Re-read on every call so an environment change takes effect immediately.
function getMaxTaskOutputLength(): number {
  return validateBoundedIntEnvVar(
    'TASK_MAX_OUTPUT_LENGTH',
    process.env.TASK_MAX_OUTPUT_LENGTH,
    TASK_MAX_OUTPUT_DEFAULT,
    TASK_MAX_OUTPUT_UPPER_LIMIT,
  ).effective
}

/**
 * The END of task output is what matters, so the head is dropped: over the
 * limit, the result is a header naming the full output file, a blank line,
 * and the tail that fits in the remaining budget.
 */
export function formatTaskOutput(output: string, taskId: string): { content: string; wasTruncated: boolean } {
  const limit = getMaxTaskOutputLength()
  if (output.length <= limit) {
    return { content: output, wasTruncated: false }
  }
  const header = `<task output truncated — the complete output is saved at ${getTaskOutputPath(taskId)}>`
  const budget = limit - (header.length + 2)
  return { content: `${header}\n\n${output.slice(-budget)}`, wasTruncated: true }
}
