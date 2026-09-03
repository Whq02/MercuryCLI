#!/usr/bin/env bun
// ============================================================================
//  scripts/crew/prove-crew-handler.ts
//  PROOF: makeCrewSpawnHandler — the COMPLETE crewSpawn policy as ONE
//  drivable function (gate → name → model → roster-ready → dupe → SPEND CAP →
//  durable team member → registerLongLived → onSpawned). The roster is a
//  structural CrewRosterPort fake (no cast); the team files are REAL writes
//  under a scratch MERCURY_CONFIG_DIR. This is the daemon-side floor a
//  key-authed client bug can never widen.
//  Run:  ~/.bun/bin/bun run scripts/crew/prove-crew-handler.ts
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'crew-handler-'))
process.env.MERCURY_CONFIG_DIR = scratch
delete process.env.MERCURY_CREW
// THE PROOF'S HERMETICITY: the credential store is pinned to the FILE
// backend under the scratch home — on darwin the keychain chain ignores
// MERCURY_CONFIG_DIR, so a presence check would otherwise read this
// machine's OS keychain (a prover never touches the operator's keychain).
process.env.MERCURY_CREDENTIAL_STORE = 'file'
// THE SEAT LAW reads the worker registry (config-backed) for a NAMED key.
// The ladder's policy floors — disabled, name, roster, duplicate, cap,
// never-Haiku — answer BEFORE the seat and need no config (the prover's
// law: failure ≠ silence); the probe below shows the seat itself answering
// TYPED while configs are not yet allowed; the valid spawns then enable
// configs and seed anthropic signed in (a fixture key + the ledger row).
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
// The config guard must be LIVE for that probe (a 'test' NODE_ENV silences it).
delete process.env.NODE_ENV
const MK = 'MACRO' as const
const setStamp = (on: boolean) => { if (on) (globalThis as Record<string, unknown>)[MK] = { VERSION: '1.0.0' }; else delete (globalThis as Record<string, unknown>)[MK] }
setStamp(true)

const cs = (await import('../../src/daemon/crewSpawn.js')) as typeof import('../../src/daemon/crewSpawn.js')
const { readTeamFileAsync } = await import('../../src/utils/swarm/teamHelpers.js')
type ChildSpec = import('../../src/daemon/headlessRun.js').StreamJsonChildSpec

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void { console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76)) }

console.log('============================================================')
console.log(' Crew spawn handler (policy floor) — proof')
console.log('============================================================')

section('the ladder never throws — before configs are allowed, a NAMED key answers a typed refusal')
{
  const early = await cs.resolveCrewSeatModel('sonnet')
  check('a named key with configs not yet allowed ⇒ a typed refusal naming the fault (never a throw up the control socket)', !early.ok && /registry-unavailable/.test(early.error ?? '') && /Config accessed before allowed/.test(early.error ?? ''), early.ok ? 'ok' : early.error)
  const earlyHaiku = await cs.resolveCrewSeatModel('haiku')
  check('…and the never-Haiku floor answers pure ahead of the registry, configs or not', !earlyHaiku.ok && /worker-policy:frontier-only/.test(earlyHaiku.error ?? ''), earlyHaiku.ok ? 'ok' : earlyHaiku.error)
}
// The valid spawns below need the registry: enable configs and seed the
// sign-in (the memo reset re-reads the ledger).
;(await import('../../src/utils/config.js')).enableConfigs()
;(await import('../../src/utils/accounts/signInLedger.js')).recordSignIn('anthropic', 'api-key')
;(await import('../../src/utils/model/computedDefault.js')).resetComputedDefaultMemo()

// ── the fake roster port (structural — the real TaskRoster satisfies it) ────
function makePort() {
  const live = new Map<string, { outcome?: string }>()
  let nextPid = 100
  let refuse: { ok: boolean; pid?: number; error?: string } | null = null
  return {
    live,
    setRefuse(r: { ok: boolean; pid?: number; error?: string } | null) { refuse = r },
    port: {
      has: (short: string) => ({ present: live.has(short) && !live.get(short)!.outcome }),
      list: () => [...live.entries()].map(([short, v]) => ({ short, outcome: v.outcome })),
      registerLongLived: (short: string, _spec: ChildSpec) => {
        if (refuse) return refuse
        live.set(short, {})
        return { ok: true, pid: nextPid++ }
      },
    },
  }
}

section('refusal ladder — every gate answers a PLAIN string (failure ≠ silence)')
{
  const spawned: Array<{ name: string; spec: ChildSpec; pid: number | undefined }> = []
  const rig = makePort()
  const handler = cs.makeCrewSpawnHandler({
    roster: () => rig.port,
    dir: scratch,
    onSpawned: (name, spec, pid) => spawned.push({ name, spec, pid }),
  })

  // Prove the gate is
  // stamp-blind WITHOUT spawning: a haiku request under a bare stamp reaches
  // the model TABLE refusal (past the gate), never the disabled one.
  setStamp(false)
  const bareStampProbe = await handler('atlas', 'haiku')
  check('bare stamp ⇒ gate passes (the never-Haiku floor refuses pure, not the disabled refusal)', !bareStampProbe.ok && /worker-policy:frontier-only/.test(bareStampProbe.error ?? '') && /opus/.test(bareStampProbe.error ?? ''), bareStampProbe.error ?? '')
  setStamp(true)
  process.env.MERCURY_CREW = '0'
  const killed = await handler('atlas', 'sonnet')
  check("MERCURY_CREW='0' ⇒ disabled refusal naming the kill", !killed.ok && /MERCURY_CREW=0/.test(killed.error ?? ''))
  delete process.env.MERCURY_CREW

  const badName = await handler('Atlas', 'sonnet')
  check('bad name ⇒ allowlist refusal', !badName.ok && /invalid agent name/.test(badName.error ?? ''))
  const reserved = await handler('tank', 'sonnet')
  check("reserved name 'tank' refused", !reserved.ok && /invalid agent name/.test(reserved.error ?? ''))
  const badModel = await handler('atlas', 'haiku')
  check("model 'haiku' ⇒ the never-Haiku floor refuses pure (no registry, no config), naming the frontier rows", !badModel.ok && /worker-policy:frontier-only/.test(badModel.error ?? '') && /opus/.test(badModel.error ?? ''), badModel.error ?? '')
  const noRoster = await cs.makeCrewSpawnHandler({ roster: () => undefined, dir: scratch, onSpawned: () => {} })('atlas', 'sonnet')
  check('roster not ready ⇒ honest refusal', !noRoster.ok && /not ready/.test(noRoster.error ?? ''))

  const ok = await handler('atlas', 'sonnet')
  check('valid spawn ⇒ ok + pid', ok.ok === true && typeof ok.pid === 'number')
  check('onSpawned fired with (name, floor spec, pid)', spawned.length === 1 && spawned[0]!.name === 'atlas' && spawned[0]!.spec.model === 'claude-sonnet-5' && spawned[0]!.spec.permissionMode === 'flow' && spawned[0]!.pid === ok.pid)
  const dupe = await handler('atlas', 'opus')
  check('live dupe refused', !dupe.ok && /already live/.test(dupe.error ?? ''))

  rig.setRefuse({ ok: false, error: 'boom' })
  const reg = await handler('bravo', 'opus')
  check('registerLongLived refusal passes through verbatim', !reg.ok && reg.error === 'boom')
  rig.setRefuse(null)
}

section('SPEND CAP — 6 live crew, crew-scoped, kill frees a slot')
{
  const rig = makePort()
  const handler = cs.makeCrewSpawnHandler({ roster: () => rig.port, dir: scratch, onSpawned: () => {} })
  // Six teammates fill the cap.
  for (const n of ['c-one', 'c-two', 'c-three', 'c-four', 'c-five', 'c-six']) {
    const r = await handler(n, 'sonnet')
    check(`spawn ${n} within cap`, r.ok === true)
  }
  const seventh = await handler('c-seven', 'sonnet')
  check('7th refused at the cap', !seventh.ok && /crew cap reached \(6 live/.test(seventh.error ?? ''))
  // Cap refusal happens BEFORE the team-file write — no phantom durable chat.
  const teamAtCap = await readTeamFileAsync('crew')
  check('cap-refused name never reached the team file', !(teamAtCap?.members ?? []).some(m => m.name === 'c-seven'))
  // Killing one frees a slot (the guard counts LIVE workers, not members).
  rig.live.get('c-three')!.outcome = 'killed'
  const after = await handler('c-seven', 'sonnet')
  check('after a kill the 7th spawns', after.ok === true)
}
{
  // Crew-scoping: six live NON-crew workers (other daemon seats) never
  // eat the crew cap.
  const rig = makePort()
  for (const other of ['seat-a', 'seat-b', 'seat-c', 'seat-d', 'seat-e', 'seat-f']) rig.live.set(other, {})
  const handler = cs.makeCrewSpawnHandler({ roster: () => rig.port, dir: scratch, onSpawned: () => {} })
  const r = await handler('solo', 'fable')
  check('other daemon seats do not count against the crew cap', r.ok === true)
}

section('durable team-file identity — governance OFF, members persist, no dupes')
{
  const team = await readTeamFileAsync('crew')
  check('team file exists after spawns', team !== null && team !== undefined)
  check('governance: broadcasts OFF (a teammate can never spam the bus)', team?.governance?.broadcastEnabled === false)
  check("lead is team-lead@crew", team?.leadAgentId === 'team-lead@crew')
  const c1 = (team?.members ?? []).filter(m => m.name === 'c-one')
  check('spawned member present exactly once', c1.length === 1)
  check('member carries the picked model', c1[0]?.model === 'claude-sonnet-5')
  // Respawn-after-kill re-attaches to the SAME durable chat: no dupe member.
  const rig = makePort()
  const handler = cs.makeCrewSpawnHandler({ roster: () => rig.port, dir: scratch, onSpawned: () => {} })
  const re = await handler('c-one', 'sonnet')
  check('respawn of a killed name succeeds (fresh handler/daemon)', re.ok === true)
  const team2 = await readTeamFileAsync('crew')
  check('respawn did NOT duplicate the member (durable chat identity)', (team2?.members ?? []).filter(m => m.name === 'c-one').length === 1)
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) { console.log(`❌ ${failures} CREW HANDLER PROOF(S) FAILED`); process.exit(1) }
console.log('✅ ALL CREW HANDLER PROOFS PASS')
