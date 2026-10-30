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

console.log(failures === 0 ? '\nPASS prove-prototype-word-names' : `\nFAIL prove-prototype-word-names (${failures})`)
process.exit(failures === 0 ? 0 : 1)
