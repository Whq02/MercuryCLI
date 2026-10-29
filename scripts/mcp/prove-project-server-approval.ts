#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DIST, MODEL, NODE, PROBE_KEY, SCRATCH_ROOT, childEnv, configKeyOf, makeTally } from '../daemon/dupline-world.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { parseFrame, type Frame } from '../lib/rows.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'project-server-approval-')))
const SERVER = join(SCRATCH, 'server.cjs')
const LINE = 'MCP server probe (project) skipped: not approved · open Mercury in this folder to approve it'
const TRUST_LINE = 'mcp: this folder is not trusted, so its project MCP server probe was not loaded from .mercury/mcp.json'
const tally = makeTally('prove-project-server-approval')

if (!existsSync(DIST)) {
  console.log(`no bundle at ${DIST} — build first; this proof drives the artifact`)
  process.exit(1)
}

writeFileSync(
  SERVER,
  `require('node:fs').writeFileSync(process.argv[2], 'started ' + process.argv.slice(3).join(' '));
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

function world(
  name: string,
  opts: { trusted: boolean; homeSettings?: object; localSettings?: object; projectSettings?: object; extraArgs?: string[] },
): World {
  const home = join(SCRATCH, name, 'home')
  const project = join(SCRATCH, name, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(project, '.mercury'), { recursive: true })
  const marker = join(home, 'server-started.txt')
  writeFileSync(
    join(home, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: opts.trusted ? { [configKeyOf(realpathSync(project))]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } : {},
      customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
    }),
  )
  writeFileSync(join(home, 'settings.json'), JSON.stringify(opts.homeSettings ?? {}))
  writeFileSync(
    join(project, '.mercury', 'mcp.json'),
    JSON.stringify({ mcpServers: { probe: { type: 'stdio', command: process.execPath, args: [SERVER, marker, ...(opts.extraArgs ?? [])] } } }),
  )
  const local = join(project, '.mercury', 'settings.local.json')
  if (opts.localSettings !== undefined) writeFileSync(local, JSON.stringify(opts.localSettings))
  if (opts.projectSettings !== undefined) writeFileSync(join(project, '.mercury', 'settings.json'), JSON.stringify(opts.projectSettings))
  return { home, project: realpathSync(project), marker, local }
}

function mcp(w: World, ...args: string[]): { rc: number | null; out: string } {
  const result = spawnSync(NODE, [DIST, 'mcp', ...args], {
    cwd: w.project,
    env: { ...childEnv(w.home, 1), MERCURY_MCP_TIMEOUT_MS: '8000' },
    encoding: 'utf8',
    timeout: 120_000,
  })
  return { rc: result.status, out: `${result.stdout}${result.stderr}` }
}

type Turn = { rows: Frame[]; stderr: string; exitCode: number | null }

async function run(w: World): Promise<Turn> {
  const api = await startFixtureApi([{ kind: 'text', text: 'The approval turn completed.' }])
  try {
    return await new Promise<Turn>(resolveTurn => {
      const port = Number(new URL(api.url).port)
      const child = spawn(NODE, [DIST, 'run', '--format', 'rows', '--model', MODEL, '--', 'say hi'], {
        cwd: w.project,
        env: { ...childEnv(w.home, port), MERCURY_MCP_TIMEOUT_MS: '8000' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const rows: Frame[] = []
      const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
      child.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        const lines = stdout.split('\n')
        stdout = lines.pop() ?? ''
        for (const line of lines) {
          const frame = parseFrame(line)
          if (frame !== null) rows.push(frame)
        }
      })
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('close', code => {
        clearTimeout(timer)
        resolveTurn({ rows, stderr, exitCode: code })
      })
    })
  } finally {
    await api.close()
  }
}

const localEntries = (w: World): string[] => {
  if (!existsSync(w.local)) return []
  const parsed = JSON.parse(readFileSync(w.local, 'utf8')) as { kit?: { projectOn?: string[]; projectOff?: string[] } }
  return [...(parsed.kit?.projectOn ?? []), ...(parsed.kit?.projectOff ?? []).map(name => `off:${name}`)]
}
const marker = (w: World): string => (existsSync(w.marker) ? readFileSync(w.marker, 'utf8') : 'ABSENT')

try {
  tally.section('§1 trusted folder, server never approved: run, mcp list and mcp get start nothing and say so')
  {
    const w = world('unapproved', { trusted: true })
    const got = mcp(w, 'get', 'probe')
    console.log(`  mcp get rc=${got.rc} · ${JSON.stringify(got.out.trim().split('\n').slice(0, 3))}`)
    tally.check('mcp get exits 0 and prints the skip line', got.rc === 0 && got.out.includes(LINE), got.out.slice(0, 300))
    tally.check('mcp get prints no Status (the server was not probed)', !got.out.includes('Status:'), got.out.slice(0, 300))
    tally.check('mcp get started nothing', marker(w) === 'ABSENT', marker(w))
    const listed = mcp(w, 'list')
    console.log(`  mcp list rc=${listed.rc} · ${JSON.stringify(listed.out.trim().split('\n').filter(line => line.includes('probe')))}`)
    tally.check('mcp list prints the skip line and no probe row', listed.out.includes(LINE) && !new RegExp(`^probe: `, 'm').test(listed.out), listed.out.slice(0, 400))
    tally.check('mcp list started nothing', marker(w) === 'ABSENT', marker(w))
    const turn = await run(w)
    const notices = turn.rows.filter(row => row.type === 'notice') as Array<{ text?: string; code?: string }>
    console.log(`  run rows: ${turn.rows.map(row => String(row.type)).join(' ')} (exit ${turn.exitCode ?? '?'})`)
    console.log(`  run notices: ${notices.map(notice => `[${notice.code ?? '-'}] ${notice.text ?? ''}`).join(' | ')}`)
    tally.check('the run reached an outcome', turn.rows.some(row => row.type === 'outcome'), JSON.stringify({ exit: turn.exitCode, stderr: turn.stderr.slice(-300) }))
    tally.check('one notice row carries the skip line under the mcp_server_skipped code', notices.filter(notice => notice.code === 'mcp_server_skipped' && notice.text === LINE).length === 1, JSON.stringify(notices))
    tally.check('stderr carries the skip line once', turn.stderr.split('\n').filter(line => line.includes(LINE)).length === 1, turn.stderr.slice(-400))
    tally.check('the run started nothing', marker(w) === 'ABSENT', marker(w))
    tally.check('the run recorded no choice (nobody answered, nothing is rejected)', localEntries(w).length === 0, JSON.stringify(localEntries(w)))
  }

  tally.section('§2 approved by name in the local settings: the server starts, and the entry is rewritten to the definition form')
  {
    const w = world('approved', { trusted: true, localSettings: { kit: { projectOn: ['probe'] } } })
    const got = mcp(w, 'get', 'probe')
    console.log(`  mcp get rc=${got.rc} · ${JSON.stringify(got.out.trim().split('\n').slice(0, 3))}`)
    tally.check('mcp get probes it (Status printed, no skip line)', /^\s+Status: /m.test(got.out) && !got.out.includes(LINE), got.out.slice(0, 300))
    tally.check('the server started', marker(w).startsWith('started'), marker(w))
    const entries = localEntries(w)
    tally.check('the name-only entry now carries the definition digest', entries.length === 1 && /^probe#[0-9a-f]{16}$/.test(entries[0] ?? ''), JSON.stringify(entries))
    const digestEntry = entries[0] ?? ''
    rmSync(w.marker, { force: true })
    const again = mcp(w, 'get', 'probe')
    tally.check('the same definition stays approved on the next call', /^\s+Status: /m.test(again.out) && marker(w).startsWith('started'), again.out.slice(0, 300))
    tally.check('the digest entry is stable', JSON.stringify(localEntries(w)) === JSON.stringify([digestEntry]), JSON.stringify(localEntries(w)))
    rmSync(w.marker, { force: true })
    writeFileSync(
      join(w.project, '.mercury', 'mcp.json'),
      JSON.stringify({ mcpServers: { probe: { type: 'stdio', command: process.execPath, args: [SERVER, w.marker, '--changed'] } } }),
    )
    const changed = mcp(w, 'get', 'probe')
    console.log(`  mcp get (args changed) rc=${changed.rc} · ${JSON.stringify(changed.out.trim().split('\n').slice(0, 2))}`)
    tally.check('the args changed: the approval no longer holds, the skip line prints', changed.out.includes(LINE) && !changed.out.includes('Status:'), changed.out.slice(0, 300))
    tally.check('the changed server did not start', marker(w) === 'ABSENT', marker(w))
    const listed = mcp(w, 'list')
    tally.check('mcp list says the same for the changed server', listed.out.includes(LINE) && marker(w) === 'ABSENT', listed.out.slice(0, 400))
  }

  tally.section('§3 trustProjectServers: true approves every project server, a changed definition included')
  {
    const w = world('trust-all', { trusted: true, homeSettings: { kit: { trustProjectServers: true } }, extraArgs: ['--changed'] })
    const got = mcp(w, 'get', 'probe')
    tally.check('mcp get probes it', /^\s+Status: /m.test(got.out) && !got.out.includes(LINE), got.out.slice(0, 300))
    tally.check('the server started', marker(w).startsWith('started'), marker(w))
  }

  tally.section('§4 the Sovereign consent flag alone approves nothing')
  {
    const w = world('consent-only', { trusted: true, homeSettings: { guardrails: { sovereignConsentSeen: true } } })
    const got = mcp(w, 'get', 'probe')
    tally.check('mcp get prints the skip line', got.out.includes(LINE) && !got.out.includes('Status:'), got.out.slice(0, 300))
    tally.check('the server did not start', marker(w) === 'ABSENT', marker(w))
    const listed = mcp(w, 'list')
    tally.check('mcp list prints the skip line and started nothing', listed.out.includes(LINE) && marker(w) === 'ABSENT', listed.out.slice(0, 400))
  }

  tally.section('§4b a checked-in .mercury/settings.json approves nothing: trustProjectServers and projectOn there are not read')
  {
    const w = world('checked-in', { trusted: true, projectSettings: { kit: { trustProjectServers: true, projectOn: ['probe'] } } })
    const got = mcp(w, 'get', 'probe')
    tally.check('mcp get prints the skip line', got.out.includes(LINE) && !got.out.includes('Status:'), got.out.slice(0, 300))
    tally.check('the server did not start', marker(w) === 'ABSENT', marker(w))
    const listed = mcp(w, 'list')
    tally.check('mcp list prints the skip line and started nothing', listed.out.includes(LINE) && marker(w) === 'ABSENT', listed.out.slice(0, 400))
    tally.check('no approval was written to the local settings', localEntries(w).length === 0, localEntries(w).join(','))
  }

  tally.section('§5 an untrusted folder keeps the trust refusal, approval or not')
  {
    const w = world('untrusted', { trusted: false, localSettings: { kit: { projectOn: ['probe'] } } })
    const got = mcp(w, 'get', 'probe')
    tally.check('mcp get prints the trust sentence, not the approval one', got.out.includes(TRUST_LINE) && !got.out.includes(LINE), got.out.slice(0, 300))
    tally.check('the server did not start', marker(w) === 'ABSENT', marker(w))
    const listed = mcp(w, 'list')
    tally.check('mcp list prints the counted trust sentence only', listed.out.includes('its 1 project MCP server was not loaded') && !listed.out.includes(LINE), listed.out.slice(0, 400))
  }

  tally.section('§6 in process: the status reader and the one writer')
  {
    const w = world('in-process', { trusted: true })
    process.env.MERCURY_CONFIG_DIR = w.home
    process.env.NODE_ENV = 'test'
    const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
    const { setIsInteractive, setSessionTrustAccepted, setOriginalCwd, setProjectRoot } = await import('../../src/bootstrap/state.js')
    const { setCwd } = await import('../../src/utils/Shell.js')
    const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
    const { getProjectMcpConfigsFromCwd } = await import('../../src/services/mcp/config.js')
    const { getProjectMcpServerStatus, projectMcpApprovalEntry, projectMcpServerDefinitionDigest, recordProjectMcpServerChoices } = await import('../../src/services/mcp/utils.js')
    enableConfigs()
    setCwd(w.project)
    setOriginalCwd(w.project)
    setProjectRoot(w.project)
    setSessionTrustAccepted(true)
    resetSettingsCache()
    const probe = getProjectMcpConfigsFromCwd().servers.probe as { command: string; args: string[]; scope: 'project' }
    for (const interactive of [true, false]) {
      setIsInteractive(interactive)
      tally.check(`${interactive ? 'interactive' : 'non-interactive'} road, never approved: pending`, getProjectMcpServerStatus('probe', probe) === 'pending', getProjectMcpServerStatus('probe', probe))
    }
    recordProjectMcpServerChoices({ approved: [{ name: 'probe', config: probe }] })
    resetSettingsCache()
    tally.check('the writer records name#digest in the local settings', JSON.stringify(localEntries(w)) === JSON.stringify([projectMcpApprovalEntry('probe', probe)]), JSON.stringify(localEntries(w)))
    tally.check('approved for this definition', getProjectMcpServerStatus('probe', probe) === 'approved', getProjectMcpServerStatus('probe', probe))
    const originalCwd = process.cwd()
    const otherCwd = join(w.project, 'other')
    mkdirSync(otherCwd)
    try {
      process.chdir(otherCwd)
      tally.check('a different stdio working directory needs approval', getProjectMcpServerStatus('probe', probe) === 'pending')
    } finally {
      process.chdir(originalCwd)
    }
    tally.check('the original stdio working directory stays approved', getProjectMcpServerStatus('probe', probe) === 'approved')
    const changed = { ...probe, args: [...probe.args, '--changed'] }
    tally.check('a changed definition has another digest and reads pending', projectMcpServerDefinitionDigest(changed) !== projectMcpServerDefinitionDigest(probe) && getProjectMcpServerStatus('probe', changed) === 'pending', getProjectMcpServerStatus('probe', changed))
    tally.check('the digest reads the definition as written, not the expanded values', projectMcpServerDefinitionDigest({ ...probe, args: ['expanded'], unexpanded: { args: probe.args } }) === projectMcpServerDefinitionDigest(probe))
    recordProjectMcpServerChoices({ approved: [{ name: 'probe', config: changed }] })
    resetSettingsCache()
    tally.check('approving the changed definition replaces the old entry', JSON.stringify(localEntries(w)) === JSON.stringify([projectMcpApprovalEntry('probe', changed)]) && getProjectMcpServerStatus('probe', changed) === 'approved', JSON.stringify(localEntries(w)))
    recordProjectMcpServerChoices({ rejected: ['probe'] })
    resetSettingsCache()
    tally.check('a rejection wins over an approval', getProjectMcpServerStatus('probe', changed) === 'rejected', getProjectMcpServerStatus('probe', changed))
    const src = readFileSync(join(ROOT, 'src', 'services', 'mcp', 'utils.ts'), 'utf8')
    tally.check('the status reader consults no road, no trust record and no consent flag', !/getIsNonInteractiveSession|checkHasTrustDialogAccepted|sovereignConsentSeen|requireExplicitApproval/.test(src))
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

tally.finish()
