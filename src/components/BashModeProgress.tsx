// Live view of an operator `!` shell command: the input rendered as a
// bash-input message (wrapped in the marker tags the transcript recognises),
// then the live progress renderer when progress exists, else the tool's own
// zero-state progress renderer.

import React from 'react'
import { Box } from '../ink.js'
import { BASH_INPUT_TAG } from '../constants/xml.js'
import type { ShellProgress } from '../types/tools.js'
import { renderToolUseProgressMessage } from '../tools/BashTool/UI.js'
import { ShellProgressMessage } from './shell/ShellProgressMessage.js'
import { UserBashInputMessage } from './messages/UserBashInputMessage.js'

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
