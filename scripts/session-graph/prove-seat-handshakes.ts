#!/usr/bin/env bun
// ============================================================================
//  scripts/session-graph/prove-seat-handshakes.ts — the REAL local protocol
//  handshakes.
//
//  For each INSTALLED external CLI this machine carries, perform the genuine
//  attach handshake through the REAL bridge + adapter — no fixture, no fake
//  child — and assert the negotiated protocol, revision and capability set.
//  Neither handshake starts a model turn (verified in the M3 census: the
//  claude stream-json control-initialize and the codex app-server JSON-RPC
//  initialize both answer without touching a model), so this proof is free.
//
//  MACHINE GATE (the prove-fixture-cpp precedent): a CLI that is not
//  installed SKIPs loudly — the fixture-conformance prover (prove-seat-
//  bridge) remains the CI-enforced floor; THIS prover is the local-evidence
//  tier the scorecard row records. It must never fabricate a pass: when a
//  CLI is present, its handshake MUST succeed or the suite fails.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'crew-handshake-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(join(scratch, 'home'), { recursive: true })

const installed = (cmd: string): string | null => {
  try {
    return execFileSync(cmd, ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim()
  } catch {
    return null
  }
}

const bridge = await import('../../src/services/crew/seatBridge.ts')
const caps = await import('../../src/services/crew/capabilities.ts')
const dir = join(scratch, 'store')

// There is no §1: no claude-code seat adapter exists — the live-handshake
// tiers are the sections below; fixture conformance in prove-seat-bridge
// stays the enforced floor for the adapters.

t.section('§2 — codex: the real app-server JSON-RPC initialize')
{
  const version = installed('codex')
  if (version === null) {
    console.log('  SKIP — the codex CLI is not installed on this machine (machine gate honoured)')
  } else {
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
