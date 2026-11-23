import stripAnsi from 'strip-ansi'
import type { ToolResultBlockParam } from '../../engine/message-shapes/wire.js'
import { formatDuration } from '../../platform/text/format.js'
import { HARD_CAP_MULTIPLIER } from '../../platform/shell/shellProcess.js'
import { getTaskOutputPath } from '../../engine/task-framework/diskOutput.js'
import { buildLargeToolResultMessage, generatePreview, PREVIEW_SIZE_CHARS } from '../../engine/tool-dispatch/toolResultStorage.js'
import type { Out } from './BashTool.js'
import { buildImageToolResult } from '../../platform/shell/shellOutput.js'

export function mapResultToBlock(output: Out, toolUseID: string): ToolResultBlockParam {
  if (output.structuredContent) {
    return { tool_use_id: toolUseID, type: 'tool_result', content: output.structuredContent }
  }
  if (output.isImage) {
    const image = buildImageToolResult(output.stdout, toolUseID)
    if (image) return image
  }
  let stdout = stripAnsi(output.stdout).replace(/^\s*\n/g, '').trimEnd()
  if (output.persistedOutputPath) {
    const { preview, hasMore } = generatePreview(stdout, PREVIEW_SIZE_CHARS, output.persistedOutputSize)
    stdout = buildLargeToolResultMessage({
      filepath: output.persistedOutputPath,
      originalSize: output.persistedOutputSize ?? 0,
      isJson: false,
      preview,
      hasMore,
    })
  }
  let errorText = stripAnsi(output.stderr).trimEnd()
  if (output.interrupted) {
    errorText += '\n<error>The command was aborted before completion.</error>'
  }
  const backgroundNotice = output.backgroundTaskId ? backgroundNoticeFor(output) : ''
  const scrubNotice = output.sessionEnvNotice ?? ''
  const content = [stdout, errorText, output.exitNote ?? '', output.timeoutClampNotice ?? '', output.outputBudgetNotice ?? '', output.outputCopyNotice ?? '', backgroundNotice, scrubNotice].filter(part => part !== '').join('\n')
  return { tool_use_id: toolUseID, type: 'tool_result', content, is_error: output.interrupted }
}

function backgroundNoticeFor(output: Out): string {
  const id = output.backgroundTaskId as string
  const outputPath = getTaskOutputPath(id)
  if (output.backgroundedByUser) {
    return `The operator moved this command to the background as task ${id}; it is still running, and its output arrives as a notification when it completes. Output: ${outputPath}.`
  }
  if (output.timeoutAutoBackgroundedAfterMs) {
    const deadline = formatDuration(HARD_CAP_MULTIPLIER * output.timeoutAutoBackgroundedAfterMs)
    const soFar =
      output.stdout.trim() === ''
        ? `It has printed nothing yet; its output goes to ${outputPath}.`
        : `${output.backgroundOutputIsTail ? 'The end of its output so far is above' : 'Its output so far is above'}; the rest goes to ${outputPath}.`
    const stopNow = output.stopOffered ? ` TaskStop with task_id "${id}" ends it now, with the processes under it.` : ''
    const until =
      output.backgroundLifetime === 'turn'
        ? ' This run ends when your turn ends (unless a crewmate is still running) and stops it then.'
        : output.backgroundLifetime === 'crewmate'
          ? ' It is stopped when you finish.'
          : ' When it ends, a notice reaches you after your next tool result, or in a new turn once yours is over.'
    return `Command timed out after ${formatDuration(output.timeoutAutoBackgroundedAfterMs)} and was moved to the background with ID: ${id}; it was not stopped. ${soFar} It is still running under an absolute deadline of ${HARD_CAP_MULTIPLIER}× the timeout (${deadline} from now), after which it will be killed.${stopNow}${until} Next time, pass a larger \`timeout\` if it needs longer, or \`run_in_background\` for a command meant to keep running.`
  }
  const pid = output.backgroundPid !== undefined ? ` Process id ${output.backgroundPid}.` : ''
  const wait = output.sleepOffered
    ? ' If you need its result, wait for it before you finish: Sleep returns as soon as this command ends (its seconds are the ceiling), and the notice with its exit code follows.'
    : ' If you need its result, wait for it before you finish; the notice with its exit code follows when it ends.'
  const serviceRoad = output.serviceOffered ? ' A process that must stay up after this run (a server something checks once the run has ended) is a Service with lifecycle project, not a background shell.' : ''
  const lifetime =
    output.backgroundLifetime === 'turn'
      ? ` This run ends when your turn ends (unless a crewmate is still running) and stops this command then, so its notice reaches you only while you are still working.${serviceRoad}${wait}`
      : output.backgroundLifetime === 'crewmate'
        ? ` It is stopped when you finish, so its notice reaches you only while you are still working.${wait}`
        : ' When it ends, a notice with its exit code reaches you after your next tool result, or in a new turn once yours is over; do not poll it.'
  const stop = output.stopOffered ? ` TaskStop with task_id "${id}" ends it.` : ''
  return `Running in the background (ID: ${id}). Output: ${outputPath}.${pid}${lifetime}${stop}`
}
