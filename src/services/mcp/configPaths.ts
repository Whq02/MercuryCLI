import { join } from 'node:path'

import { projectConfigDirs } from '../../utils/projectConfig.js'
import { getManagedFilePath } from '../../utils/settings/managedPath.js'

export const PROJECT_MCP_FILE = 'mcp.json'

export function projectMcpFilePath(dir: string): string {
  return join(projectConfigDirs(dir)[0], PROJECT_MCP_FILE)
}

export function getEnterpriseMcpFilePath(): string {
  return join(getManagedFilePath(), 'managed-mcp.json')
}
