#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { nodeBinPath } from '../lib/nodeBin.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_PROOF_DIST ?? join(ROOT, 'dist', 'mercury.mjs')
const NODE = nodeBinPath()
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-trust-reset-')))
const SERVER = join(SCRATCH, 'server.cjs')
const RESET_LINE = 'All project-scoped MCP server approvals and rejections were reset.'

let checks = 0
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

if (!existsSync(DIST)) {
  console.log(`no bundle at ${DIST} — build first; this proof drives the artifact`)
  process.exit(1)
}

writeFileSync(
  SERVER,
  `require('node:fs').writeFileSync(process.argv[2], 'started');
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  const q = JSON.parse(line);
  if (q.id === undefined) return;
  const result = q.method === 'initialize'
    ? { protocolVersion: q.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } }
    : q.method === 'tools/list' ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }) + '\\n');
});
`,
)

type World = { home: string; project: string; marker: string; local: string }

function makeWorld(name: string, serverName: string, localSettings?: Record<string, unknown>): World {
  const home = join(SCRATCH, name, 'home')
  const project = join(SCRATCH, name, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(project, '.mercury'), { recursive: true })
  const realProject = realpathSync(project)
  const marker = join(home, 'server-started.txt')
  writeFileSync(
    join(home, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: {
        [realProject]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      },
    }),
  )
  writeFileSync(join(home, 'settings.json'), '{}')
  writeFileSync(
    join(realProject, '.mercury', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        [serverName]: { type: 'stdio', command: NODE, args: [SERVER, marker] },
      },
    }),
  )
  const local = join(realProject, '.mercury', 'settings.local.json')
  if (localSettings !== undefined) writeFileSync(local, JSON.stringify(localSettings, null, 2))
  return { home, project: realProject, marker, local }
}

function runMcp(w: World, ...args: string[]): { rc: number | null; stdout: string; stderr: string; out: string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    MERCURY_CONFIG_DIR: w.home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_MCP_TIMEOUT_MS: '8000',
    BROWSER: '/usr/bin/true',
  }
  delete env.MERCURY_HOME
  delete env.MERCURY_AUTH_SCOPE_DIR
  const result = spawnSync(NODE, [DIST, 'mcp', ...args], {
    cwd: w.project,
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  return { rc: result.status, stdout, stderr, out: `${stdout}${stderr}` }
}

function readLocalSettings(w: World): Record<string, unknown> {
  return JSON.parse(readFileSync(w.local, 'utf8')) as Record<string, unknown>
}

console.log('============================================================')
console.log(' built mercury mcp trust-reset clears project MCP approvals')
console.log('============================================================')

try {
  console.log('\n§1 approved and rejected project servers + trustProjectServers: trust-reset clears all three and preserves unrelated settings')
  {
    const w = makeWorld('approved', 'probe', {
      cleanupPeriodDays: 30,
      kit: {
        projectOn: ['probe'],
        projectOff: ['blocked'],
        trustProjectServers: true,
      },
    })
    const before = runMcp(w, 'list')
    check('before reset: mcp list exits 0', before.rc === 0, String(before.rc))
    check('before reset: approved server connects and starts', before.out.includes('probe:') && before.out.includes('connected') && existsSync(w.marker), before.out.slice(0, 400))
    check('before reset: no approval-skip notice', !before.out.includes('skipped: not approved'), before.out.slice(0, 400))

    rmSync(w.marker, { force: true })
    const reset = runMcp(w, 'trust-reset')
    check('trust-reset exits 0', reset.rc === 0, `${reset.rc} ${reset.stderr}`)
    check('trust-reset prints reset confirmation', reset.stdout.includes(RESET_LINE), reset.out.slice(0, 400))

    const settings = readLocalSettings(w)
    const kit = (settings.kit ?? {}) as Record<string, unknown>
    check('local settings kit.projectOn is empty', Array.isArray(kit.projectOn) && kit.projectOn.length === 0, JSON.stringify(kit.projectOn))
    check('local settings kit.projectOff is empty', Array.isArray(kit.projectOff) && kit.projectOff.length === 0, JSON.stringify(kit.projectOff))
    check('local settings kit.trustProjectServers is false', kit.trustProjectServers === false, JSON.stringify(kit.trustProjectServers))
    check('unrelated local setting is preserved', settings.cleanupPeriodDays === 30, JSON.stringify(settings.cleanupPeriodDays))

    const after = runMcp(w, 'list')
    check('after reset: mcp list exits 0', after.rc === 0, String(after.rc))
    check('after reset: mcp list reports probe waits for approval', after.out.includes('MCP server probe (project) skipped: not approved · open Mercury in this folder to approve it'), after.out.slice(0, 400))
    check('after reset: probe is not listed as connected and server never starts', !after.out.includes('probe:') && !existsSync(w.marker), after.out.slice(0, 400))
  }

  console.log('\n§2 trustProjectServers alone: trust-reset revokes bulk project approval')
  {
    const w = makeWorld('bulk', 'bulk', {
      kit: { trustProjectServers: true },
    })
    const before = runMcp(w, 'list')
    check('before reset: bulk-trusted server connects and starts', before.rc === 0 && before.out.includes('bulk:') && before.out.includes('connected') && existsSync(w.marker), before.out.slice(0, 400))

    rmSync(w.marker, { force: true })
    const reset = runMcp(w, 'trust-reset')
    check('trust-reset exits 0 for bulk trust', reset.rc === 0 && reset.stdout.includes(RESET_LINE), reset.out.slice(0, 400))

    const kit = ((readLocalSettings(w).kit ?? {}) as Record<string, unknown>)
    check('local settings clears trustProjectServers to false', kit.trustProjectServers === false && Array.isArray(kit.projectOn) && kit.projectOn.length === 0, JSON.stringify(kit))

    const after = runMcp(w, 'list')
    check('after reset: mcp list skips bulk as not approved and starts nothing', after.rc === 0 && after.out.includes('MCP server bulk (project) skipped: not approved · open Mercury in this folder to approve it') && !existsSync(w.marker), after.out.slice(0, 400))
  }

  console.log('\n§3 fresh project with no local settings file: trust-reset succeeds and leaves approvals empty')
  {
    const w = makeWorld('fresh', 'fresh')
    const reset = runMcp(w, 'trust-reset')
    check('fresh project: trust-reset exits 0 with confirmation', reset.rc === 0 && reset.stdout.includes(RESET_LINE), reset.out.slice(0, 400))
    check('fresh project: local settings written with empty approvals', existsSync(w.local) && ((readLocalSettings(w).kit as Record<string, unknown>)?.trustProjectServers === false))
    const after = runMcp(w, 'list')
    check('fresh project: mcp list skips fresh as not approved and starts nothing', after.rc === 0 && after.out.includes('MCP server fresh (project) skipped: not approved · open Mercury in this folder to approve it') && !existsSync(w.marker), after.out.slice(0, 400))
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — prove-mcp-trust-reset (${checks} checks, ${failures} failures)`)
process.exit(failures === 0 ? 0 : 1)
