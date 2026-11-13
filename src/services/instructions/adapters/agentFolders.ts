import { SHARED_INSTRUCTION_FILE } from './agentsMd.js'
import { sharedFormat } from './shared.js'

export const agentFoldersConvention = sharedFormat({
  id: 'agent-folders',
  label: 'shared folder',
  guides: [`.agent/${SHARED_INSTRUCTION_FILE}`, `.agents/${SHARED_INSTRUCTION_FILE}`],
})
