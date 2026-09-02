// The startup notice strip: global config + an optional agent-definitions
// result + the resolved instruction files (suspending on that promise) feed
// the notice catalogue, and each active notice renders its own output.
// Neutral or positive status belongs on the status screen, not here.

import React, { use } from 'react'
import { Box } from '../ink.js'
import { getInstructionFiles } from '../services/instructions/engine.js'
import type { InstructionSourceEntry } from '../services/instructions/contracts.js'
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import { getGlobalConfig } from '../utils/config.js'
import { getActiveNotices } from '../utils/statusNoticeDefinitions.js'

// One stable promise per process — a fresh promise per render would
// re-suspend the strip on every commit.
let instructionFilesPromise: Promise<InstructionSourceEntry[]> | null = null
function resolvedInstructionFiles(): Promise<InstructionSourceEntry[]> {
  instructionFilesPromise ??= getInstructionFiles()
  return instructionFilesPromise
}

export function StatusNotices(
  { agentDefinitions }: { agentDefinitions?: AgentDefinitionsResult } = {},
): React.ReactNode {
  const memoryFiles = use(resolvedInstructionFiles())
  const context = {
    config: getGlobalConfig(),
    agentDefinitions,
    memoryFiles,
  }
  const notices = getActiveNotices(context)
  if (notices.length === 0) return null
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {notices.map(notice => (
        <Box key={notice.id} flexDirection="column">
          {notice.render(context)}
        </Box>
      ))}
    </Box>
  )
}

export default StatusNotices
