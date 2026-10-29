#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { handoffTurn, isHandoffRequest, startFixtureApi } from '../lib/fixtureApi.ts'
import { hostRunner } from '../lib/runnerHost.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — build the product first')
  process.exit(1)
}
const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const NODE = existsSync(vendoredNode) ? vendoredNode : Bun.which('node') ?? 'node'
const API_KEY = 'fixture-key-000'
const MODEL = 'claude-opus-4-8'
const NOTE = 'The note left when the input closed while the run was idle.'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

type LedgerEntry = { sessionId: string; endedAt?: string | null; handoff?: { text?: string } | null }
function world(prefix: string): { home: string; cwd: string; configDir: string; env: (url: string) => Record<string, string> } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const cwd = join(home, 'project')
  const configDir = join(home, '.mercury')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# fixture\n')
  writeFileSync(join(configDir, '.config.json'), JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: [API_KEY.slice(-20)] },
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }))
  return {
    home, cwd, configDir,
    env: url => ({
      HOME: home,
      PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(NODE)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: API_KEY,
    }),
  }
}
function ledgerEntriesOf(configDir: string): LedgerEntry[] {
  const projects = join(configDir, 'projects')
  if (!existsSync(projects)) return []
  const latest = new Map<string, LedgerEntry>()
  for (const key of readdirSync(projects)) {
    const ledger = join(projects, key, 'lineage', 'ledger.jsonl')
    if (!existsSync(ledger)) continue
    for (const line of readFileSync(ledger, 'utf8').split('\n')) {
      if (!line.startsWith('{')) continue
      try {
        const entry = JSON.parse(line) as LedgerEntry
        latest.set(entry.sessionId, entry)
      } catch {}
    }
  }
  return [...latest.values()]
}

console.log('\n§1 mercury run --input rows: the input closes while the run is idle (the host waited for the answer) — an unattended run leaves no note, so no closing ask runs')
{
  const { home, cwd, configDir, env } = world('idle-close-run-')
  const fixture = await startFixtureApi([{ kind: 'text' as const, text: 'The run answered.' }, handoffTurn(NOTE)])
  const child = spawn(NODE, [DIST, 'run', '--input', 'rows', '--format', 'rows', '--model', MODEL], { cwd, env: env(fixture.url), stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', chunk => (stderr += chunk))
  const rows = (): Array<Record<string, unknown>> => stdout.split('\n').filter(line => line.startsWith('{')).flatMap(line => {
    try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] }
  })
  let closedAfterOutcome = false
  child.stdout.on('data', chunk => {
    stdout += chunk
    if (!closedAfterOutcome && rows().some(row => row.type === 'outcome')) {
      closedAfterOutcome = true
      child.stdin.end()
    }
  })
  child.stdin.write(JSON.stringify({ type: 'prompt', content: 'say hello' }) + '\n')
  const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  const exitCode = await new Promise<number | null>(resolveExit => child.on('close', code => { clearTimeout(killer); resolveExit(code) }))
  check('the input was closed only after the outcome row (the run was idle)', closedAfterOutcome)
  check('the run exits 0', exitCode === 0, `exit ${String(exitCode)} · ${stderr.slice(-300)}`)
  const requests = fixture.messageRequests()
  check('one request reached the model: the answer, and never the closing ask (the fixture\'s note turn stayed unserved)', requests.length === 1 && !requests.some(request => isHandoffRequest(request)), `${requests.length} requests, ${requests.filter(request => isHandoffRequest(request)).length} asks`)
  check('one outcome row, and the stream ends on it with no close row', rows().filter(row => row.type === 'outcome').length === 1 && rows().at(-1)?.type === 'outcome' && !rows().some(row => row.type === 'close'), rows().map(row => row.type).join(','))
  check('no warning or error row rides the close', rows().every(row => row.type !== 'notice'), JSON.stringify(rows().filter(row => row.type === 'notice')))
  const entries = ledgerEntriesOf(configDir)
  check('the ledger entry closes with no note: the next session reads that this one left none', entries.length === 1 && entries[0]!.endedAt !== null && entries[0]!.endedAt !== undefined && entries[0]!.handoff === null, JSON.stringify(entries))
  await fixture.close()
  rmSync(home, { recursive: true, force: true })
}

console.log('\n§2 mercury runner: a host that holds the asks waited for the answer, then closed its end — the closing ask runs and the note lands in the ledger')
{
  const { home, cwd, configDir, env } = world('idle-close-runner-')
  const fixture = await startFixtureApi([{ kind: 'text' as const, text: 'The run answered.' }, handoffTurn(NOTE)])
  const host = hostRunner({ node: NODE, dist: DIST, cwd, home, env: env(fixture.url), argv: ['--model', MODEL] })
  const killer = setTimeout(() => host.child.kill('SIGKILL'), 90_000)
  try {
    await host.initialize()
    await host.prompt('say hello', { id: 'idle-close-1' })
    await host.waitFor('the outcome row', row => row.type === 'outcome', 60_000)
    host.end()
    const exitCode = await host.exited
    check('the runner exits 0', exitCode === 0, `exit ${String(exitCode)} · ${host.stderr().slice(-300)}`)
    const requests = fixture.messageRequests()
    check('two requests reached the model: the answer and then the closing ask', requests.length === 2 && isHandoffRequest(requests[1]!) && !isHandoffRequest(requests[0]!), `${requests.length} requests, ${requests.filter(request => isHandoffRequest(request)).length} asks`)
    check('one outcome row; the ask opened no second turn', host.rows.filter(row => row.type === 'outcome').length === 1)
    check('the ask leaves no warning or error row behind (the ledger is the record)', host.rows.every(row => row.type !== 'notice'), JSON.stringify(host.rows.filter(row => row.type === 'notice')))
    const entries = ledgerEntriesOf(configDir)
    check('the ledger holds the note exactly as the model wrote it', entries.length === 1 && entries[0]!.handoff?.text === NOTE, JSON.stringify(entries))
  } finally {
    clearTimeout(killer)
    await host.stop()
    await fixture.close()
    rmSync(home, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\nprove-idle-close-handoff: ALL LAWS HOLD' : `\nprove-idle-close-handoff: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
