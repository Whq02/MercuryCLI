#!/usr/bin/env bun
// ============================================================================
//  scripts/rewind/prove-rewind-capture.ts — THE CAPTURE END of /rewind
//  (release-hardening audit FN-015 rank 8, the checkpoint half).
//
//  THE FINDING: the process that executes tools is the daemon-hosted session
//  runner, spawned with `-p`, and fileHistoryEnabled() answered false there
//  — so no per-turn file checkpoint was ever captured for a real session,
//  while the Settings row said checkpointing was on.
//
//   §1 THE GATE (pure): the seat runner — MERCURY_CONCOURSE_WORKER=1 under
//      the -p posture — captures under the interactive world's law; a plain
//      -p run keeps the SDK contract (off); the operator's config off-switch
//      reaches the runner; an interactive process is unchanged.
//   §2 THE REAL RUNNER (the built dist, a fixture provider, no PTY): a
//      stream-json child wearing the worker stamp runs ONE tool turn (a
//      Write over an existing file) and the store holds the pre-edit bytes
//      — a blob under <home>/file-history/<sid>/ and a file-history-snapshot
//      row in the transcript keyed by the turn's user message.
//   §3 THE CONTROL: the identical run WITHOUT the stamp captures nothing —
//      the headless SDK contract keeps its own truth.
//
//  Requires the prebuilt dist for §2/§3. Run:
//    ~/.bun/bin/bun run scripts/rewind/prove-rewind-capture.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi, type FixtureApi } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

// Hermetic config home for the pure section — pinned before any src import.
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

// ── §1 the gate ─────────────────────────────────────────────────────────────
section('§1 — the capture gate: the seat runner captures under the interactive law')
{
  const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { setIsInteractive, getIsNonInteractiveSession } = await import('../../src/bootstrap/state.ts')
  const { fileHistoryEnabled } = await import('../../src/utils/fileHistory.ts')

  saveGlobalConfig(c => ({ ...c, fileCheckpointingEnabled: true }))
  setIsInteractive(false)
  check('the -p posture reads non-interactive (the premise)', getIsNonInteractiveSession())
  check('a plain -p process keeps the SDK contract: capture OFF (control)', fileHistoryEnabled() === false)

  process.env.MERCURY_CONCOURSE_WORKER = '1'
  check('THE FIX: the seat runner (worker stamp under -p) captures — the audit red', fileHistoryEnabled() === true)

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

// ── §2/§3 the real runner ───────────────────────────────────────────────────
type Envelope = Record<string, unknown> & { type: string; subtype?: string }

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
  const configDir = join(home, '.claude')
  mkdirSync(configDir, { recursive: true })
  const target = join(cwd, 'note.txt')
  writeFileSync(target, 'ZERO\n')
  // The scripted tools carry their real input — the fixture's tool_use turn
  // takes `input` verbatim, so the tools run in the child for real. The
  // Write tool refuses to overwrite a file the turn never read, so the
  // script reads first (the edit tools' own law, obeyed rather than bypassed).
  const fixture: FixtureApi = await startFixtureApi([
    { kind: 'tool_use', name: 'Read', input: { file_path: target }, id: 'toolu_rewind_read_1' },
    { kind: 'tool_use', name: 'Write', input: { file_path: target, content: 'ONE\n' }, id: 'toolu_rewind_write_1' },
    { kind: 'text', text: 'CAP-DONE.' },
  ])
  const nodeBin = Bun.which('node')!
  // The cold concourse spawn pins the born session's id on the argv
  // (headlessRun.ts); a stamped runner with no pin is the WARM pool's shape
  // and waits for a claim control before it opens a turn.
  const pinnedSessionId = randomUUID()
  const env: Record<string, string> = {
    HOME: home,
    PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: fixture.url,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    ...(opts.stamp ? { MERCURY_CONCOURSE_WORKER: '1' } : {}),
  }
  const child = spawn(
    nodeBin,
    [
      DIST,
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--model',
      'claude-opus-4-8',
      '--session-id',
      pinnedSessionId,
      '--allowedTools',
      'Read',
      'Write',
    ],
    { cwd, env },
  )
  const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  const envelopes: Envelope[] = []
  const waiters: Array<{ pred: (e: Envelope) => boolean; res: (e: Envelope) => void }> = []
  let buf = ''
  child.stdout.on('data', d => {
    buf += String(d)
    for (;;) {
      const nl = buf.indexOf('\n')
      if (nl === -1) break
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as Envelope
        envelopes.push(e)
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]!.pred(e)) {
            const w = waiters.splice(i, 1)[0]!
            w.res(e)
          }
        }
      } catch {
        /* a non-JSON line is a §-level failure below */
      }
    }
  })
  let stderr = ''
  child.stderr.on('data', d => (stderr += d))
  const exited = new Promise<number | null>(res =>
    child.on('close', code => {
      clearTimeout(killer)
      res(code)
    }),
  )
  const waitFor = (pred: (e: Envelope) => boolean, label: string, timeoutMs = 60_000): Promise<Envelope | undefined> =>
    new Promise(res => {
      const hit = envelopes.find(pred)
      if (hit) return res(hit)
      const t = setTimeout(() => {
        console.log(`  [dbg] waitFor timeout: ${label}; envelopes=${j(envelopes.map(e => `${e.type}:${e.subtype ?? ''}`))} stderr=${stderr.slice(-400)}`)
        res(undefined)
      }, timeoutMs)
      waiters.push({
        pred,
        res: e => {
          clearTimeout(t)
          res(e)
        },
      })
    })
  const send = (o: unknown): void => {
    child.stdin.write(JSON.stringify(o) + '\n')
  }

  send({ type: 'control_request', request_id: 'req_init', request: { subtype: 'initialize' } })
  const initResp = await waitFor(e => e.type === 'control_response' && j(e).includes('req_init'), 'initialize')
  check(`${opts.label}: initialize acknowledged`, !!initResp && j(initResp).includes('"success"'))

  send({ type: 'user', message: { role: 'user', content: 'overwrite note.txt with ONE' }, parent_tool_use_id: null })
  const sysInit = (await waitFor(e => e.type === 'system' && e.subtype === 'init', 'system:init')) as (Envelope & { session_id?: string }) | undefined
  const sessionId = sysInit?.session_id ?? ''
  check(`${opts.label}: the turn opened with system:init carrying the session id`, /^[0-9a-f-]{36}$/.test(sessionId), j(sysInit ?? {}).slice(0, 200))
  const result = (await waitFor(e => e.type === 'result', 'result')) as (Envelope & { subtype?: string; result?: string }) | undefined
  check(`${opts.label}: the tool turn settled (result:success)`, result?.subtype === 'success', j({ s: result?.subtype, r: result?.result, stderr: stderr.slice(-300) }))
  const toolResultText = envelopes
    .filter(e => e.type === 'user' && j(e).includes('tool_result'))
    .map(e => j(e).slice(0, 400))
    .join(' | ')
  check(`${opts.label}: the Write landed on disk (the tool ran in THIS process)`, existsSync(target) && readFileSync(target, 'utf8') === 'ONE\n', `${existsSync(target) ? readFileSync(target, 'utf8') : 'absent'} tool_result=${toolResultText}`)

  child.stdin.end()
  const exit = await exited
  check(`${opts.label}: the runner exited clean`, exit === 0, `exit=${exit} stderr=${stderr.slice(-300)}`)
  await fixture.close()

  // ── the store ──
  const blobDir = join(configDir, 'file-history', sessionId)
  const blobs = existsSync(blobDir) ? readdirSync(blobDir) : []
  const transcript = sessionId ? findTranscript(configDir, sessionId) : null
  const rows = transcript ? readFileSync(transcript, 'utf8').split('\n').filter(l => l.trim() !== '') : []
  const snapshotRows = rows.filter(l => l.includes('"file-history-snapshot"'))
  // The store's record envelope: an operator prompt is payload.kind 'input'
  // with string content; its message uuid rides annotations.uuid.
  const userUuid = ((): string | null => {
    for (const l of rows) {
      try {
        const r = JSON.parse(l) as { payload?: { kind?: string; content?: unknown }; annotations?: { uuid?: string } }
        if (r.payload?.kind === 'input' && typeof r.payload.content === 'string' && typeof r.annotations?.uuid === 'string') return r.annotations.uuid
      } catch {
        /* not a record line */
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
    check('§3 CONTROL — the plain -p run captured no blob (the SDK contract keeps its truth)', blobs.length === 0, j(blobs))
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
section('§3 — the control: the plain -p run keeps the headless contract (nothing captured)')
await driveRunner({ stamp: false, label: 'plain' })

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL REWIND CAPTURE PROOFS PASS')
else console.log(`❌ ${failures} REWIND CAPTURE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
