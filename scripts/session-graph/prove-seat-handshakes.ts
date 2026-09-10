#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'crew-handshake-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(join(scratch, 'home'), { recursive: true })

type CliProbe =
  | { state: 'absent' }
  | { state: 'present'; version: string }
  | { state: 'broken'; reason: string }

const probe = (cmd: string, timeoutMs = 15_000): CliProbe => {
  try {
    const version = execFileSync(cmd, ['--version'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return { state: 'present', version }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null; signal?: string | null; stderr?: string }
    if (e.code === 'ENOENT') return { state: 'absent' }
    if (e.code === 'ETIMEDOUT' || (e.status === null && e.signal !== null && e.signal !== undefined)) {
      return { state: 'broken', reason: `--version did not answer within ${timeoutMs} ms (${e.signal ?? e.code})` }
    }
    const stderr = String(e.stderr ?? '').trim().split('\n')[0] ?? ''
    return { state: 'broken', reason: `--version exited ${e.status ?? e.code ?? 'unknown'}${stderr ? ` — ${stderr}` : ''}` }
  }
}

t.section('§0 — the machine gate tells absent from broken (deterministic fixtures)')
{
  const bin = join(scratch, 'bin')
  mkdirSync(bin, { recursive: true })
  const script = (name: string, body: string): string => {
    const path = join(bin, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return path
  }
  const good = script('fixture-good-cli', 'echo "fixture-cli 1.2.3"')
  const failing = script('fixture-failing-cli', 'echo "fixture: no config" >&2; exit 3')
  const hanging = script('fixture-hanging-cli', 'exec sleep 30')
  const absent = join(bin, 'fixture-absent-cli')
  const notExecutable = join(bin, 'fixture-unexecutable-cli')
  writeFileSync(notExecutable, '#!/bin/sh\necho never\n', { mode: 0o644 })

  const g = probe(good)
  t.check('a present, answering CLI is PRESENT with its version', g.state === 'present' && g.version === 'fixture-cli 1.2.3', JSON.stringify(g))
  const a = probe(absent)
  t.check('a missing executable is ABSENT (the only state the gate may skip on)', a.state === 'absent', JSON.stringify(a))
  const f = probe(failing)
  t.check(
    'a present CLI whose --version exits non-zero is BROKEN, naming the exit and stderr',
    f.state === 'broken' && /exited 3/.test(f.reason) && /no config/.test(f.reason),
    JSON.stringify(f),
  )
  const started = Date.now()
  const h = probe(hanging, 400)
  const took = Date.now() - started
  t.check(
    'a present CLI whose --version hangs is BROKEN as a timeout, within the budget',
    h.state === 'broken' && /did not answer within 400 ms/.test(h.reason) && took < 5_000,
    `${JSON.stringify(h)} after ${took} ms`,
  )
  const x = probe(notExecutable)
  t.check('a present file that cannot execute is BROKEN, never ABSENT', x.state === 'broken', JSON.stringify(x))
}

const bridge = await import('../../src/services/crew/seatBridge.ts')
const caps = await import('../../src/services/crew/capabilities.ts')
const dir = join(scratch, 'store')


t.section('§2 — codex: the real app-server JSON-RPC initialize')
{
  const codex = probe('codex')
  if (codex.state === 'absent') {
    console.log('  SKIP — the codex CLI is not installed on this machine (machine gate honoured)')
  } else if (codex.state === 'broken') {
    t.check('the codex CLI is installed but its --version handshake failed — a broken install is never skipped', false, codex.reason)
  } else {
    const version = codex.version
    const { codexSeatTransport } = await import('../../src/services/crew/adapters/codex.ts')
    const seat = await bridge.attachExternalSeat(codexSeatTransport({ cwd: scratch }), {
      displayName: 'Codex (live)',
      dir,
    })
    t.check('the LIVE handshake negotiated', seat.protocol === 'codex-app-server@jsonrpc-initialize')
    t.check(
      `the revision carries the installed version (${version})`,
      seat.revision.includes(version.replace('codex-cli ', '')),
      seat.revision,
    )
    t.check(
      'the sparse capability variant recorded (turn surface unknown)',
      caps.capabilityStateOf(seat.seatId, 'start-turn').state === 'unknown' &&
        caps.capabilityStateOf(seat.seatId, 'structured-activity').state === 'supported',
    )
    const detached = await bridge.detachExternalSeat(seat.seatId)
    t.check('detach closes the owned child', detached === true)
  }
}

t.finish('prove-seat-handshakes')
