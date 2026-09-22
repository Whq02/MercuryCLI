#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_PROOF_DIST ?? join(ROOT, 'dist', 'mercury.mjs')
const home = mkdtempSync(join(tmpdir(), 'mcp-entry-isolation-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'mcp-entry-isolation-cwd-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
process.chdir(cwd)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const document = {
  mcpServers: {
    x: { type: 'sdk', name: 'x' },
    y: { command: '/usr/bin/true', args: [] },
    z: { type: 'http', url: 42 },
  },
}
const { parseMcpConfig } = await import('../../src/services/mcp/config.ts')

console.log('[1] the pure parse: one bad entry never voids its neighbours')
{
  const parsed = parseMcpConfig({ configObject: document, expandVars: false, scope: 'project', filePath: join(cwd, '.mcp.json') })
  const names = Object.keys(parsed.config?.mcpServers ?? {})
  console.log(`  parse: config ${parsed.config === null ? 'null' : 'present'} · servers ${JSON.stringify(names)} · errors ${JSON.stringify(parsed.errors.map(e => `${e.path}: ${e.message} [${e.severity}]`))}`)
  check('the valid server y survives an entry of an unknown type beside it', parsed.config !== null && names.includes('y'))
  check('the unknown-typed entry x is dropped, not kept as a server', !names.includes('x'))
  check('the malformed entry z (a number for a url) is dropped too', !names.includes('z'))
  const xRow = parsed.errors.find(e => e.serverName === 'x')
  const zRow = parsed.errors.find(e => e.serverName === 'z')
  check('x is named once as a warning that carries its server name, never a fatal error for the whole file', xRow !== undefined && xRow.severity === 'warning' && parsed.errors.filter(e => e.serverName === 'x').length === 1, JSON.stringify(xRow))
  check('z is named once as a warning too', zRow !== undefined && zRow.severity === 'warning' && parsed.errors.filter(e => e.serverName === 'z').length === 1, JSON.stringify(zRow))
  check('the warning keeps the document path of the entry (mcpServers.<name>) so the doctor row reads as before', xRow !== undefined && xRow.path === 'mcpServers.x' && zRow?.path === 'mcpServers.z')
  check('no fatal error is reported for a document whose only faults are per entry', parsed.errors.every(e => e.severity !== 'fatal'))
  check('the kept entry carries its scope tag', (parsed.config?.mcpServers.y as { scope?: string } | undefined)?.scope === 'project')
}

console.log('[2] a document that is not an mcpServers object still fails whole')
{
  const parsed = parseMcpConfig({ configObject: { mcpServers: 'nope' }, expandVars: false, scope: 'project', filePath: join(cwd, '.mcp.json') })
  check('a non-object mcpServers member is a fatal error', parsed.config === null && parsed.errors.some(e => e.severity === 'fatal'))
  const empty = parseMcpConfig({ configObject: { mcpServers: {} }, expandVars: false, scope: 'user' })
  check('an empty server map parses to an empty document with no error', empty.config !== null && Object.keys(empty.config.mcpServers).length === 0 && empty.errors.length === 0)
}

console.log('[3] the built product lists the valid server beside the bad entry')
if (existsSync(DIST)) {
  const node = process.env.MERCURY_NODE ?? 'node'
  const bundleHome = mkdtempSync(join(tmpdir(), 'mcp-entry-isolation-bundle-home-'))
  const bundleCwd = mkdtempSync(join(tmpdir(), 'mcp-entry-isolation-bundle-cwd-'))
  writeFileSync(
    join(bundleHome, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [bundleCwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    }),
  )
  writeFileSync(join(bundleHome, 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
  writeFileSync(join(bundleCwd, '.mcp.json'), JSON.stringify({ mcpServers: { x: document.mcpServers.x, y: document.mcpServers.y } }))
  const env = { ...process.env, MERCURY_CONFIG_DIR: bundleHome, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', BROWSER: '/usr/bin/true' }
  const list = spawnSync(node, [DIST, 'mcp', 'list'], { cwd: bundleCwd, env, encoding: 'utf8', timeout: 120_000 })
  const listOut = `${list.stdout}\n${list.stderr}`
  console.log(`  ${DIST} mcp list rc=${list.status} · ${JSON.stringify(list.stdout.trim().split('\n').slice(0, 4))}`)
  check('mcp list on the built product names the valid server y', /^y:/m.test(list.stdout), listOut.slice(0, 300))
  check('mcp list on the built product does not read the whole file as empty', !/No MCP servers configured/.test(list.stdout), listOut.slice(0, 300))
  check('mcp list on the built product carries no line for the dropped entry x', !/^x:/m.test(list.stdout))
  const doctor = spawnSync(node, [DIST, 'doctor', '--json'], { cwd: bundleCwd, env, encoding: 'utf8', timeout: 120_000 })
  const report = JSON.parse(doctor.stdout || '{}') as { sections?: Array<{ checks?: Array<{ evidence?: string }> }> }
  const evidences = (report.sections ?? []).flatMap(section => section.checks ?? []).map(c => c.evidence ?? '')
  const row = evidences.find(e => e.includes('mcpServers.x'))
  console.log(`  ${DIST} doctor --json rc=${doctor.status} · mcp evidence ${JSON.stringify(row ?? 'none')}`)
  check('the doctor still names the dropped entry x by its document path', row !== undefined, evidences.filter(e => /validation/.test(e)).join(' | ').slice(0, 300))
} else {
  console.log(`  no bundle at ${DIST}; the built-product leg is skipped`)
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
