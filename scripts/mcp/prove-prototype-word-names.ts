#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'mcp-proto-names-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'mcp-proto-names-cwd-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
process.env.NODE_ENV = 'test'
process.chdir(cwd)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const attempt = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work()
    return 'ok'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(cwd)
const config = await import('../../src/services/mcp/config.ts')
const { connectToServer, fetchToolsForClient, clearServerCache } = await import('../../src/services/mcp/client.ts')
const { mcpToolPartition } = await import('../../src/tools.ts')
const { parseMcpConfig } = config

const fixture = join(import.meta.dir, '_fixture-stdio-server.mjs')
const server = { type: 'stdio', command: process.execPath, args: [fixture] }
const words = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'prototype']

console.log('[1] a server named after an Object.prototype member is added, read back and removed like any other')
for (const scope of ['local', 'user'] as const) {
  for (const name of words) {
    const added = await attempt(() => config.addMcpConfig(name, server, scope))
    check(`${scope}: "${name}" is added`, added === 'ok', added)
    const found = config.getMcpConfigByName(name)
    check(`${scope}: "${name}" reads back as the stored stdio entry`, found !== null && typeof found === 'object' && (found as { command?: unknown }).command === process.execPath, typeof found === 'function' ? 'the inherited function came back' : JSON.stringify(found))
    const again = await attempt(() => config.addMcpConfig(name, server, scope))
    check(`${scope}: a second add of "${name}" is refused as a duplicate`, again.includes('already exists'), again)
    const removed = await attempt(() => config.removeMcpConfig(name, scope))
    check(`${scope}: "${name}" is removed`, removed === 'ok', removed)
    const gone = await attempt(() => config.removeMcpConfig(name, scope))
    check(`${scope}: removing "${name}" again is refused — nothing is reported removed for nothing`, gone !== 'ok', gone)
    check(`${scope}: "${name}" no longer reads back`, config.getMcpConfigByName(name) === null)
  }
}

console.log('[2] an absent name that is an Object.prototype member is absent, not an inherited function')
for (const name of words) {
  check(`getMcpConfigByName("${name}") is null when nothing is configured`, config.getMcpConfigByName(name) === null)
}

console.log('[3] the project file: an entry named "constructor" is the one on disk, never the inherited function')
{
  mkdirSync(join(cwd, '.mercury'), { recursive: true })
  const projectFile = join(cwd, '.mercury', 'mcp.json')
  writeFileSync(projectFile, JSON.stringify({ mcpServers: { constructor: { command: process.execPath, args: [fixture] } } }))
  const parsed = parseMcpConfig({ configObject: { mcpServers: { constructor: { command: process.execPath, args: [fixture] } } }, expandVars: false, scope: 'project', filePath: projectFile })
  const entry = parsed.config?.mcpServers.constructor
  check('the parsed document carries the entry under its own key', entry !== undefined && typeof entry === 'object' && (entry as { command?: unknown }).command === process.execPath, typeof entry)
  const added = await attempt(() => config.addMcpConfig('constructor', server, 'project'))
  check('adding "constructor" to the project file is refused as a duplicate of the entry on disk', added.includes('already exists'), added)
  const removed = await attempt(() => config.removeMcpConfig('constructor', 'project'))
  check('removing it from the project file works', removed === 'ok', removed)
}

console.log('[4] "__proto__" is refused as a server name, with the next step')
{
  const refused = await attempt(() => config.addMcpConfig('__proto__', server, 'local'))
  check('the add names the problem and says to choose another name', refused.includes('__proto__') && refused.includes('choose another'), refused)
  check('nothing was stored under it', config.getMcpConfigByName('__proto__') === null)
}

console.log('[5] a tool-permission ceiling on a tool named after an Object.prototype member holds, __proto__ included')
{
  const fileText = '{"mcpServers":{"probe":{"type":"http","url":"https://127.0.0.1:1/x","toolPermissions":{"constructor":"blocked","toString":"blocked","__proto__":"blocked","fix_ping":"ask"}}}}'
  const parsed = parseMcpConfig({ configObject: JSON.parse(fileText), expandVars: false, scope: 'project', filePath: join(cwd, 'x.json') })
  const ceilings = (parsed.config?.mcpServers.probe as { toolPermissions?: Record<string, string> } | undefined)?.toolPermissions
  check('the parser keeps every ceiling the file names', ceilings !== undefined && ['constructor', 'toString', '__proto__', 'fix_ping'].every(name => Object.hasOwn(ceilings, name) && ceilings[name] === (name === 'fix_ping' ? 'ask' : 'blocked')), JSON.stringify(ceilings))
  check('…as a plain object that stringifies back to the file', JSON.stringify(ceilings) === '{"constructor":"blocked","toString":"blocked","__proto__":"blocked","fix_ping":"ask"}', JSON.stringify(ceilings))
  const connection = await connectToServer('proto-tools', { type: 'stdio', scope: 'dynamic', command: process.execPath, args: [fixture], env: { MCP_FIXTURE_PROTO_NAMED_TOOLS: '1' }, toolPermissions: ceilings } as never)
  try {
    check('the fixture with prototype-named tools connects', connection.type === 'connected')
    if (connection.type === 'connected') {
      const tools = await fetchToolsForClient(connection)
      const info = (tool: unknown) => (tool as { mcpInfo?: { toolName: string; effectiveMaxPermission?: unknown } }).mcpInfo
      const listed = tools.map(tool => info(tool)?.toolName).sort()
      check('the server lists constructor, __proto__, toString, valueOf and fix_ping', JSON.stringify(listed) === JSON.stringify(['__proto__', 'constructor', 'fix_ping', 'toString', 'valueOf']), listed.join(', '))
      const unset = tools.find(tool => info(tool)?.toolName === 'valueOf')
      check('a tool with no ceiling of its own carries none (valueOf)', unset !== undefined && info(unset)?.effectiveMaxPermission === undefined, String(info(unset)?.effectiveMaxPermission))
      const ctx = { alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, mode: 'default' }
      const kept = mcpToolPartition(tools, ctx as never).map(tool => info(tool)?.toolName).sort()
      check('the blocked filter removes constructor, toString and __proto__', JSON.stringify(kept) === JSON.stringify(['fix_ping', 'valueOf']), kept.join(', '))
      const asked = tools.find(tool => info(tool)?.toolName === 'fix_ping')
      check('an ask ceiling rides on its tool', asked !== undefined && info(asked)?.effectiveMaxPermission === 'ask')
    }
  } finally {
    await clearServerCache('proto-tools', { type: 'stdio', scope: 'dynamic', command: process.execPath, args: [fixture], env: { MCP_FIXTURE_PROTO_NAMED_TOOLS: '1' }, toolPermissions: ceilings } as never)
  }
}

console.log(failures === 0 ? '\nPASS prove-prototype-word-names' : `\nFAIL prove-prototype-word-names (${failures})`)
process.exit(failures === 0 ? 0 : 1)
