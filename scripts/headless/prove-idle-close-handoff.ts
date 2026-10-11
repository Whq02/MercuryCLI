#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { handoffTurn, isHandoffRequest, startFixtureApi } from '../lib/fixtureApi.ts'

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

const home = realpathSync(mkdtempSync(join(tmpdir(), 'idle-close-handoff-')))
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

const fixture = await startFixtureApi([{ kind: 'text' as const, text: 'The run answered.' }, handoffTurn(NOTE)])
const env = {
  HOME: home,
  PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(NODE)}`,
  TERM: 'dumb',
  MERCURY_CONFIG_DIR: configDir,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_BASE_URL: fixture.url,
  ANTHROPIC_API_KEY: API_KEY,
}

console.log('\n§1 the input closes while the run is idle (the host waited for the answer): the closing ask still runs')
const child = spawn(NODE, [DIST, 'run', '--input', 'rows', '--format', 'rows', '--model', MODEL], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
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
const asks = requests.filter(request => isHandoffRequest(request))
check('two requests reached the model: the answer and then the closing ask', requests.length === 2 && asks.length === 1 && isHandoffRequest(requests[1]!), `${requests.length} requests, ${asks.length} asks`)
check('one outcome row; the ask opened no second turn', rows().filter(row => row.type === 'outcome').length === 1)
check('the ask leaves no warning or error row behind (the ledger is the record, as on the turn-end road)', rows().every(row => row.type !== 'notice'), JSON.stringify(rows().filter(row => row.type === 'notice')))
let ledgerNote: string | null = null
const projects = join(configDir, 'projects')
if (existsSync(projects)) {
  for (const key of readdirSync(projects)) {
    const ledger = join(projects, key, 'lineage', 'ledger.jsonl')
    if (!existsSync(ledger)) continue
    for (const line of readFileSync(ledger, 'utf8').split('\n')) {
      if (!line.startsWith('{')) continue
      try {
        const entry = JSON.parse(line) as { handoff?: { text?: string } | null }
        if (entry.handoff && typeof entry.handoff.text === 'string') ledgerNote = entry.handoff.text
      } catch {}
    }
  }
}
check('the ledger holds the note exactly as the model wrote it', ledgerNote === NOTE, JSON.stringify(ledgerNote))
await fixture.close()
rmSync(home, { recursive: true, force: true })

console.log(failures === 0 ? '\nprove-idle-close-handoff: ALL LAWS HOLD' : `\nprove-idle-close-handoff: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
