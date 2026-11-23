
import React, { use } from 'react'
import { Box } from '../themedRenderer.js'
import { getInstructionFiles } from '../../sessions/instructions/instructionFiles.js'
import type { InstructionSourceEntry } from '../../sessions/instruction-contracts/contracts.js'
import type { AgentDefinitionsResult } from '../../crew/agents/agentDefinition.js'
import { getGlobalConfig } from '../../platform/settings/config.js'
import { getActiveNotices } from '../status-notices/statusNoticeDefinitions.js'

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
