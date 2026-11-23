
import React from 'react'
import { Box } from '../../screen/themedRenderer.js'
import { BASH_INPUT_TAG } from '../message-shapes/messageTags.js'
import type { ShellProgress } from '../../tools/kit/toolProgress.js'
import { renderToolUseProgressMessage } from '../../tools/shell/rows.js'
import { ShellProgressMessage } from '../../screen/shell-output/ShellProgressMessage.js'
import { UserBashInputMessage } from '../../screen/messages/UserBashInputMessage.js'

export function BashModeProgress({
  input,
  progress,
  verbose,
}: {
  input: string
  progress: ShellProgress | null
  verbose: boolean
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <UserBashInputMessage
        addMargin={false}
        param={{
          type: 'text',
          text: `<${BASH_INPUT_TAG}>${input}</${BASH_INPUT_TAG}>`,
        }}
      />
      {progress ? (
        <ShellProgressMessage
          output={progress.output}
          fullOutput={progress.fullOutput}
          elapsedTimeSeconds={progress.elapsedTimeSeconds}
          totalLines={progress.totalLines}
          totalBytes={progress.totalBytes}
          timeoutMs={progress.timeoutMs}
          taskId={progress.taskId}
          verbose={verbose}
        />
      ) : (
        renderToolUseProgressMessage([], { verbose })
      )}
    </Box>
  )
}

export default BashModeProgress
