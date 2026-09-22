#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'mcp-remove-needs-auth-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'mcp-remove-needs-auth-cwd-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
process.chdir(cwd)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(cwd)
const config = await import('../../src/services/mcp/config.ts')
const client = await import('../../src/services/mcp/client.ts')

const cachePath = join(home, 'mcp-needs-auth-cache.json')
const readCache = (): Record<string, unknown> => (existsSync(cachePath) ? (JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>) : {})
const server = { type: 'http', url: 'http://127.0.0.1:1/mcp' }

console.log('[1] mcp remove forgets the removed server\'s needs-auth mark and keeps the others')
{
  await config.addMcpConfig('probe', server, 'user')
  await config.addMcpConfig('other', server, 'user')
  writeFileSync(cachePath, JSON.stringify({ probe: { timestamp: Date.now() }, other: { timestamp: Date.now() } }))
  await config.removeMcpConfig('probe', 'user')
  const after = readCache()
  console.log(`  cache after remove: ${JSON.stringify(after)}`)
  check('the removed server\'s mark is gone', after.probe === undefined, JSON.stringify(after))
  check('a sibling server\'s mark stands', after.other !== undefined, JSON.stringify(after))
  check('the server itself is gone from the user scope', !('probe' in (config.getMcpConfigsByScope('user').servers as Record<string, unknown>)))
}

console.log('[2] a server re-added under the same name is dialled, not painted needs-auth from the stale mark')
{
  await config.addMcpConfig('probe', server, 'user')
  const reports: Array<{ client: { name: string; type: string } }> = []
  await client.getMcpToolsCommandsAndResources(report => reports.push(report as never), { probe: { ...server, scope: 'user' } } as never)
  const probe = reports.find(r => r.client.name === 'probe')
  console.log(`  re-added server connection report: ${probe?.client.type ?? 'none'} (a dialled 127.0.0.1:1 answers failed)`)
  check('the re-added server is dialled', probe !== undefined && probe.client.type !== 'needs-auth', probe?.client.type ?? 'no report')
}

console.log('[3] a remove that finds no server leaves the cache untouched')
{
  writeFileSync(cachePath, JSON.stringify({ ghost: { timestamp: Date.now() } }))
  let threw = false
  try {
    await config.removeMcpConfig('ghost', 'user')
  } catch {
    threw = true
  }
  check('removing a server that is not configured throws as before', threw)
  check('and the cache is untouched', readCache().ghost !== undefined)
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
