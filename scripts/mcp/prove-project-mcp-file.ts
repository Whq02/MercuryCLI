#!/usr/bin/env bun
// gate-watch: src/services/mcp/config.ts src/services/mcp/utils.ts src/components/MCPServerApprovalDialog.tsx src/components/MCPServerMultiselectDialog.tsx src/cli/handlers/mcp.tsx src/services/mcpServerApproval.tsx src/utils/projectConfig.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'project-mcp-file-config-')))
process.env.MERCURY_CONFIG_DIR = CONFIG_DIR
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'project-mcp-file-proj-')))

const { enableConfigs, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(PROJ)
bootstrap.setProjectRoot(PROJ)
bootstrap.setIsInteractive(false)
const { setCwd } = await import('../../src/utils/Shell.ts')
await setCwd(PROJ)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const j = (v: unknown): string => JSON.stringify(v)
const stdio = (cmd: string): Record<string, unknown> => ({ type: 'stdio', command: cmd, args: [], env: {} })

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — project mcp file proof exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

const otherName = ['.mcp', 'json'].join('.')
const projectFile = join(PROJ, '.mercury', 'mcp.json')
mkdirSync(join(PROJ, '.mercury'), { recursive: true })
writeFileSync(projectFile, JSON.stringify({ mcpServers: { 'in-home': stdio('in-home-cmd') } }))
writeFileSync(join(PROJ, otherName), JSON.stringify({ mcpServers: { 'other-file': stdio('other-file-cmd') } }))
writeFileSync(join(PROJ, '.mercury', 'settings.json'), JSON.stringify({ kit: { trustProjectServers: true } }))
saveCurrentProjectConfig(current => ({ ...current, hasTrustDialogAccepted: true }))

const config = await import('../../src/services/mcp/config.ts')
const utils = await import('../../src/services/mcp/utils.ts')

console.log('============================================================')
console.log(' the project MCP file is .mercury/mcp.json')
console.log('============================================================')

console.log('\n§1 the project scope reads .mercury/mcp.json and nothing else at the root')
{
  const { servers } = await config.getMercuryMcpConfigs({})
  const names = Object.keys(servers).sort()
  check('the server in the project-home file is in the walk, scoped project', (servers['in-home'] as { scope?: string } | undefined)?.scope === 'project', j(names))
  check('a server file under another name at the project root is not read', !('other-file' in servers), j(names))
  check('the cwd read sees the same one server', Object.keys(config.getProjectMcpConfigsFromCwd().servers).join(',') === 'in-home', j(Object.keys(config.getProjectMcpConfigsFromCwd().servers)))
}

console.log('\n§2 the scope describes itself by that file')
{
  check('projectMcpFilePath rides the project-config seam', config.projectMcpFilePath(PROJ) === projectFile, config.projectMcpFilePath(PROJ))
  check("describeMcpConfigFilePath('project') names the file", utils.describeMcpConfigFilePath('project') === projectFile, utils.describeMcpConfigFilePath('project'))
  check("getScopeLabel('project') names the file", utils.getScopeLabel('project').includes('.mercury/mcp.json'), utils.getScopeLabel('project'))
}

console.log('\n§3 mcp add/remove --scope project write that file')
{
  await config.addMcpConfig('added', stdio('added-cmd'), 'project')
  const doc = JSON.parse(readFileSync(projectFile, 'utf8')) as { mcpServers: Record<string, unknown> }
  check('add lands in .mercury/mcp.json beside the existing server', 'added' in doc.mcpServers && 'in-home' in doc.mcpServers, j(Object.keys(doc.mcpServers)))
  const other = JSON.parse(readFileSync(join(PROJ, otherName), 'utf8')) as { mcpServers: Record<string, unknown> }
  check('the other file at the root is untouched', Object.keys(other.mcpServers).join(',') === 'other-file')
  let duplicate = ''
  try {
    await config.addMcpConfig('added', stdio('added-cmd'), 'project')
  } catch (error) {
    duplicate = String(error)
  }
  check('a second add of the same name refuses and names the project file', duplicate.includes(projectFile), duplicate)
  await config.removeMcpConfig('added', 'project')
  const after = JSON.parse(readFileSync(projectFile, 'utf8')) as { mcpServers: Record<string, unknown> }
  check('remove takes it out again', !('added' in after.mcpServers) && 'in-home' in after.mcpServers, j(Object.keys(after.mcpServers)))
  const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'project-mcp-file-fresh-')))
  await setCwd(fresh)
  await config.addMcpConfig('first', stdio('first-cmd'), 'project')
  check('an add in a project with no config home creates .mercury/mcp.json', existsSync(join(fresh, '.mercury', 'mcp.json')) && !existsSync(join(fresh, otherName)))
  rmSync(fresh, { recursive: true, force: true })
  await setCwd(PROJ)
}

console.log('\n§4 the approval cards and the CLI label name the project file')
{
  const sources = [
    'src/components/MCPServerApprovalDialog.tsx',
    'src/components/MCPServerMultiselectDialog.tsx',
    'src/cli/handlers/mcp.tsx',
    'src/services/mcp/utils.ts',
    'src/commands/mcp/route.ts',
    'src/components/mcp/MCPSettings.tsx',
  ]
  for (const rel of sources) {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    check(`${rel} names .mercury/mcp.json and not the other file`, text.includes('.mercury/mcp.json') && !text.includes(otherName))
  }
  const approval = readFileSync(join(ROOT, 'src/services/mcpServerApproval.tsx'), 'utf8')
  check('the boot-time approval gate carries no name for the other file', !approval.includes(otherName) && !/Mcpjson/.test(approval))
}

rmSync(CONFIG_DIR, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ PROJECT MCP FILE — all checks pass' : `\n❌ PROJECT MCP FILE — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
