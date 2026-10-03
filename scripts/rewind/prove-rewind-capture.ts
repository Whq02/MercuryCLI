#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isOutcome, isSessionRow, type LooseRow } from '../../src/rows/read.ts'
import { RUNNER_PROTOCOL } from '../../src/runner/wire/methods.ts'
import { createPeer } from '../../src/runner/wire/peer.ts'
import { startFixtureApi, type FixtureApi } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

const PURE_HOME = mkdtempSync(join(tmpdir(), 'rewind-capture-pure-'))
process.env.MERCURY_CONFIG_DIR = PURE_HOME
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CONCOURSE_WORKER

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — rewind capture proofs exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

section('§1 — the capture gate: the seat runner captures under the interactive law')
{
  const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { setIsInteractive, getIsNonInteractiveSession } = await import('../../src/bootstrap/state.ts')
  const { fileHistoryEnabled } = await import('../../src/utils/fileHistory.ts')

  saveGlobalConfig(c => ({ ...c, fileCheckpointingEnabled: true }))
  setIsInteractive(false)
  check('the run posture reads non-interactive (the premise)', getIsNonInteractiveSession())
  check('a plain run process keeps the SDK contract: capture OFF (control)', fileHistoryEnabled() === false)

  process.env.MERCURY_CONCOURSE_WORKER = '1'
  check('THE FIX: the seat runner (worker stamp under run) captures — the audit red', fileHistoryEnabled() === true)

  saveGlobalConfig(c => ({ ...c, fileCheckpointingEnabled: false }))
  check("the operator's Settings off-switch reaches the seat runner", fileHistoryEnabled() === false)
  saveGlobalConfig(c => ({ ...c, fileCheckpointingEnabled: true }))
  delete process.env.MERCURY_CONCOURSE_WORKER

  setIsInteractive(true)
  check('an interactive process is unchanged (on)', fileHistoryEnabled() === true)
  saveGlobalConfig(c => ({ ...c, fileCheckpointingEnabled: false }))
  check('…and its off-switch still holds', fileHistoryEnabled() === false)
  saveGlobalConfig(c => ({ ...c, fileCheckpointingEnabled: true }))
}

function findTranscript(root: string, sessionId: string): string | null {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const p = join(dir, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) stack.push(p)
      else if (name === `${sessionId}.jsonl`) return p
    }
  }
  return null
}

async function driveRunner(opts: { stamp: boolean; label: string }): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), `rewind-capture-home-${opts.stamp ? 'seat' : 'plain'}-`))
  const cwd = mkdtempSync(join(tmpdir(), 'rewind-capture-cwd-'))
  const configDir = join(home, '.mercury')
  mkdirSync(configDir, { recursive: true })
  const target = join(cwd, 'note.txt')
  writeFileSync(target, 'ZERO\n')
  const fixture: FixtureApi = await startFixtureApi([
    { kind: 'tool_use', name: 'Read', input: { file_path: target }, id: 'toolu_rewind_read_1' },
    { kind: 'tool_use', name: 'Write', input: { file_path: target, content: 'ONE\n' }, id: 'toolu_rewind_write_1' },
    { kind: 'text', text: 'CAP-DONE.' },
  ])
  const nodeBin = Bun.which('node')!
  const pinnedSessionId = randomUUID()
  const env: Record<string, string> = {
    HOME: home,
    PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: fixture.url,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREWS_DIR: join(home, 'crews'),
    ...(opts.stamp ? { MERCURY_CONCOURSE_WORKER: '1' } : {}),
  }
  const child = spawn(nodeBin, [DIST, 'runner', '--model', 'claude-opus-4-8', '--session-id', pinnedSessionId, '--allowed-tools', 'Read', 'Write'], { cwd, env })
  const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  const rows: LooseRow[] = []
  const waiters: Array<{ pred: (row: LooseRow) => boolean; res: (row: LooseRow) => void }> = []
  const peer = createPeer({ input: child.stdout, output: child.stdin, side: 'host' })
  peer.onRequest('permission/request', () => ({ outcome: 'deny', message: 'the capture proof answers no asks' }))
  peer.onNotification('row', row => {
    const seen = row as LooseRow
    rows.push(seen)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(seen)) {
        const w = waiters.splice(i, 1)[0]!
        w.res(seen)
      }
    }
  })
  let stderr = ''
  child.stderr.on('data', d => (stderr += d))
  const exited = new Promise<number | null>(res =>
    child.on('close', code => {
      clearTimeout(killer)
      peer.close('the runner exited')
      res(code)
    }),
  )
  const waitFor = (pred: (row: LooseRow) => boolean, label: string, timeoutMs = 60_000): Promise<LooseRow | undefined> =>
    new Promise(res => {
      const hit = rows.find(pred)
      if (hit) return res(hit)
      const t = setTimeout(() => {
        console.log(`  [dbg] waitFor timeout: ${label}; rows=${j(rows.map(row => `${row.type}${typeof row.state === 'string' ? `:${row.state}` : ''}`))} stderr=${stderr.slice(-400)}`)
        res(undefined)
      }, timeoutMs)
      waiters.push({
        pred,
        res: row => {
          clearTimeout(t)
          res(row)
        },
      })
    })

  const init = await peer
    .request('initialize', { protocol: RUNNER_PROTOCOL, host: { name: 'prove-rewind-capture', version: '0' }, capabilities: { holds_asks: true, elicitation: false, partial_rows: false } })
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
  check(`${opts.label}: initialize answered with the pinned session id`, typeof init === 'object' && init.session_id === pinnedSessionId, j(init).slice(0, 200))

  const accepted = await peer.request('queue/add', { type: 'prompt', content: 'overwrite note.txt with ONE' }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
  check(`${opts.label}: the prompt row was accepted`, typeof accepted === 'object' && accepted.accepted === true, j(accepted))
  const sessionRow = await waitFor(isSessionRow, 'session')
  const sessionId = typeof sessionRow?.session_id === 'string' ? sessionRow.session_id : ''
  check(`${opts.label}: the stream opened with the session row carrying the session id`, /^[0-9a-f-]{36}$/.test(sessionId), j(sessionRow ?? {}).slice(0, 200))
  const outcome = await waitFor(isOutcome, 'outcome')
  check(`${opts.label}: the tool turn settled (outcome completed)`, outcome?.status === 'completed', j({ status: outcome?.status, answer: outcome?.answer, stderr: stderr.slice(-300) }))
  const toolResultText = rows
    .filter(row => row.type === 'tool_result')
    .map(row => j(row).slice(0, 400))
    .join(' | ')
  check(`${opts.label}: the Write landed on disk (the tool ran in THIS process)`, existsSync(target) && readFileSync(target, 'utf8') === 'ONE\n', `${existsSync(target) ? readFileSync(target, 'utf8') : 'absent'} tool_result=${toolResultText}`)

  child.stdin.end()
  const exit = await exited
  check(`${opts.label}: the runner exited clean`, exit === 0, `exit=${exit} stderr=${stderr.slice(-300)}`)
  await fixture.close()

  const blobDir = join(configDir, 'file-history', sessionId)
  const blobs = existsSync(blobDir) ? readdirSync(blobDir) : []
  const transcript = sessionId ? findTranscript(configDir, sessionId) : null
  const records = transcript ? readFileSync(transcript, 'utf8').split('\n').filter(l => l.trim() !== '') : []
  const snapshotRows = records.filter(l => l.includes('"file-history-snapshot"'))
  const userUuid = ((): string | null => {
    for (const l of records) {
      try {
        const r = JSON.parse(l) as { payload?: { kind?: string; content?: unknown }; annotations?: { uuid?: string } }
        if (r.payload?.kind === 'input' && typeof r.payload.content === 'string' && typeof r.annotations?.uuid === 'string') return r.annotations.uuid
      } catch {
      }
    }
    return null
  })()
  if (opts.stamp) {
    check('§2 a backup blob exists under <home>/file-history/<sid>/ (the pre-edit bytes)', blobs.length >= 1, `dir=${blobDir} blobs=${j(blobs)}`)
    const preEdit = blobs.map(b => readFileSync(join(blobDir, b), 'utf8'))
    check('§2 the blob holds the PRE-EDIT bytes (ZERO), never the post-edit content', preEdit.includes('ZERO\n'), j(preEdit))
    check('§2 the transcript carries a file-history-snapshot row (resume rehydrates it)', snapshotRows.length >= 1, transcript ?? 'no transcript found')
    const keyed = snapshotRows.some(l => userUuid !== null && l.includes(userUuid))
    check("§2 the snapshot is keyed by the turn's own user message (the restore point /rewind names)", keyed, `userUuid=${userUuid} rows=${snapshotRows.map(r => r.slice(0, 160)).join(' | ')}`)
    check('§2 the snapshot tracks note.txt', snapshotRows.some(l => l.includes('note.txt')), snapshotRows.map(r => r.slice(0, 200)).join(' | '))
  } else {
    check('§3 CONTROL — the plain run captured no blob (the SDK contract keeps its truth)', blobs.length === 0, j(blobs))
    check('§3 CONTROL — and wrote no snapshot row', snapshotRows.length === 0, String(snapshotRows.length))
  }
}

if (!existsSync(DIST)) {
  console.log('❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)')
  process.exit(1)
}
if (!Bun.which('node')) {
  console.log('❌ no node binary on PATH')
  process.exit(1)
}

section('§2 — the real seat runner captures a checkpoint after a tool turn (built dist, fixture provider)')
await driveRunner({ stamp: true, label: 'seat' })
section('§3 — the control: the plain run keeps the headless contract (nothing captured)')
await driveRunner({ stamp: false, label: 'plain' })

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL REWIND CAPTURE PROOFS PASS')
else console.log(`❌ ${failures} REWIND CAPTURE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
