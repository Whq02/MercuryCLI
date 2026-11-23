import { mcpServersFailed, mcpServerFailedWords } from '../../../integrations/mcp/utils.js'
import { noticeRow } from '../../../engine/rows/project.js'
import { MCP_SERVER_FAILED_CODE, MCP_SERVER_SKIPPED_CODE } from '../../../engine/rows/vocabulary.js'
import { GLYPH } from '../../../screen/theme/glyphs.js'
import { mcpServersSkippedForApprovalLines } from '../../../integrations/mcp/serverConfigs.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'tellFailedMcpServers' | 'tellSkippedProjectMcpServers'> {
  const { getAppState, options } = ports
  const failedMcpTold = new Set<string>()
  const tellFailedMcpServers = (): void => {
    for (const server of mcpServersFailed(getAppState().mcp.clients)) {
      if (failedMcpTold.has(server.name)) continue
      failedMcpTold.add(server.name)
      const words = mcpServerFailedWords(server.name, server.reason)
      ports.enqueueRow(noticeRow(ports.liveScope(), 'warning', words, MCP_SERVER_FAILED_CODE))
      if (options.door !== 'wire') process.stderr.write(`${GLYPH.warn} ${words}\n`)
    }
  }
  const skippedMcpTold = new Set<string>()
  const tellSkippedProjectMcpServers = (): void => {
    for (const { name, line } of mcpServersSkippedForApprovalLines()) {
      if (skippedMcpTold.has(name)) continue
      skippedMcpTold.add(name)
      ports.enqueueRow(noticeRow(ports.liveScope(), 'warning', line, MCP_SERVER_SKIPPED_CODE))
      if (options.door !== 'wire') process.stderr.write(`${GLYPH.warn} ${line}\n`)
    }
  }
  return { tellFailedMcpServers, tellSkippedProjectMcpServers }
}

export const tellMcpNotices: BootStep<'tellFailedMcpServers' | 'tellSkippedProjectMcpServers'> = { name: 'tellMcpNotices', makes: ['tellFailedMcpServers', 'tellSkippedProjectMcpServers'], run }
