#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'

const SCRATCH = mkdtempSync(join(tmpdir(), 'cleared-mark-'))
const HOME = join(SCRATCH, 'home')
const DAEMON_DIR = join(SCRATCH, 'daemon')
const PROJECT = join(SCRATCH, 'project')
for (const dir of [HOME, DAEMON_DIR, PROJECT]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_FAULT_INJECT

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}${ok ? '' : ' | to fix, change src/sessions/transcripts/clearedSessions.ts (publishAtomicSync + typed kind + markSessionClearedRidingOut) and clearFocusedSession in src/daemon/switchboard/hopIntoSession.ts'}`)
  if (!ok) failures = 1
}

try {
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const cleared = await import('../../src/sessions/transcripts/clearedSessions.ts')
  const publish = await import('../../src/platform/substrate/durablePublish.ts')
  const id = 'sess-cleared-proof-1'
  t('§2 an unmarked id reads uncleared', cleared.isSessionCleared(id) === false)
  cleared.markSessionCleared(id)
  t('§2 the mark lands and reads back', cleared.isSessionCleared(id) === true)

  process.env.MERCURY_FAULT_INJECT = 'rename@cleared-sessions.json:eperm'
  publish._resetFaultInjectionCountersForTests()
  const syncHeld = cleared.markSessionCleared('sess-held-sync') as { ok: boolean; kind?: string; error?: string }
  delete process.env.MERCURY_FAULT_INJECT
  t('§3 sync markSessionCleared writes through durable publish and reports kind=held when rename is refused', syncHeld.ok === false && syncHeld.kind === 'held', JSON.stringify(syncHeld))

  const rideOut = (cleared as Record<string, unknown>).markSessionClearedRidingOut as
    | ((sessionId: string | null | undefined) => Promise<{ ok: boolean; kind?: string; error?: string }>)
    | undefined
  t('§3 markSessionClearedRidingOut is exported', typeof rideOut === 'function')

  if (typeof rideOut === 'function') {
    process.env.MERCURY_FAULT_INJECT = 'rename@cleared-sessions.json:eperm'
    publish._resetFaultInjectionCountersForTests()
    const release = setTimeout(() => { delete process.env.MERCURY_FAULT_INJECT }, 900)
    const rode = await rideOut('sess-held-ride')
    clearTimeout(release)
    delete process.env.MERCURY_FAULT_INJECT
    t('§3 a 900ms held file is ridden out and returns ok', rode.ok === true, JSON.stringify(rode))
    cleared.resetClearedSessionsMemo()
    t('§3 the ridden-out mark is persisted on disk', cleared.isSessionCleared('sess-held-ride') === true)

    process.env.MERCURY_FAULT_INJECT = 'rename@cleared-sessions.json:eperm'
    publish._resetFaultInjectionCountersForTests()
    const forever = await rideOut('sess-held-forever')
    delete process.env.MERCURY_FAULT_INJECT
    t('§3 a permanently held file settles with kind=held', forever.ok === false && forever.kind === 'held' && typeof forever.error === 'string', JSON.stringify(forever))

    const mapPath = join(HOME, 'cleared-sessions.json')
    const broken = '{not valid json'
    writeFileSync(mapPath, broken)
    const t0 = Date.now()
    const bad = await rideOut('sess-broken')
    const badMs = Date.now() - t0
    t('§3 a broken map settles immediately with kind=broken-map (no hold wait)', bad.ok === false && bad.kind === 'broken-map' && badMs < 350, `${badMs}ms ${JSON.stringify(bad)}`)
    t('§3 a broken map is preserved byte for byte', readFileSync(mapPath, 'utf8') === broken)

    rmSync(mapPath, { force: true })
    cleared.resetClearedSessionsMemo()
    const receipts = await import('../../src/models/facts/seatReceipts.ts')
    const focused = await import('../../src/engine/connector/focusedConnector.ts')
    const { noSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
    mock.module(join(import.meta.dir, '../../src/daemon/switchboard/bornSession.ts'), () => ({ bornSession: async () => ({ ok: true }) }))
    const hop = await import('../../src/daemon/switchboard/hopIntoSession.ts')

    const seen: Array<{ level?: string; text?: string }> = []
    const unsub = receipts.subscribeSeatReceipts(r => seen.push(r))
    focused.setFocusedSessionConnector(new Proxy(noSessionConnector(), {
      get(target, prop, receiver) {
        if (prop === 'sessionId') return () => 'sess-hop-held'
        if (prop === 'turnActive') return () => false
        if (prop === 'workspace') return () => ({ cwd: PROJECT, originalCwd: PROJECT })
        if (prop === 'modelFacts') return () => ({ effective: null })
        const v = Reflect.get(target, prop, receiver)
        return typeof v === 'function' ? v.bind(target) : v
      },
    }))
    try {
      process.env.MERCURY_FAULT_INJECT = 'rename@cleared-sessions.json:eperm'
      publish._resetFaultInjectionCountersForTests()
      const rel2 = setTimeout(() => { delete process.env.MERCURY_FAULT_INJECT }, 900)
      const outcome = await hop.clearFocusedSession()
      clearTimeout(rel2)
      delete process.env.MERCURY_FAULT_INJECT
      t('§3 /clear rides out a 900ms held cleared-sessions.json with no warning receipt', outcome.ok === true && seen.filter(r => r.level === 'warning').length === 0, JSON.stringify({ outcome, seen }))
      cleared.resetClearedSessionsMemo()
      t('§3 /clear wrote the cleared mark after the hold ended', cleared.isSessionCleared('sess-hop-held') === true)
    } finally {
      unsub()
      focused.releaseFocusedSessionConnector()
    }
  }
} finally {
  delete process.env.MERCURY_FAULT_INJECT
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? 'CLEARED MARK WIRED: ALL PASS' : 'CLEARED MARK WIRED: RED')
process.exit(failures)
