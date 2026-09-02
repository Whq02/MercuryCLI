// ============================================================================
// prove-kit-dials — the pins: /mcp + /skills are the SESSION'S OWN
//  dials (ledger L24(3) verbatim: "those stay in those sessions and they act
//  as, like, oh, session scope… it doesn't apply to my boot menu. So, like,
//  isolated from the boot menu's logic, same with the MCP").
//
//  THE LAWS UNDER PROOF (this commit's sections; later commits append):
//    §B  the dial's setter beside the completion — every prior latch state
//        is lawful ground; malformed never latches; the completion law
//        untouched; the record-less edit road materializes from the
//        process's STANDING reality (poison: the first dial WIDENING the
//        process — a record-disabled server becoming a member because the
//        unresolved membership arm never consults the record again).
//    §E  the reconcile's pure halves — the delta flips ONLY changed
//        membership (a dial is a delta, never a full-state heal); organs
//        are never severed; an unresolved kit's provisional lists never
//        enter the candidates; the drop updater takes exactly one server's
//        contributions and leaves the sibling's.
//    §H  the re-point — the child's session-dial arms write NO config file
//        anywhere (the disease: registry.toggle → setMcpServerEnabled →
//        the SHARED project record sibling sessions read).
//
//  Hermetic: scratch config home + scratch non-git project cwd; no network;
//  nothing spawns (cpu-pure — the latch driven pure; the child loop's
//  impure halves are pinned structurally and driven on the real box in the
//  receipt's NEEDS-REAL-BOX leg).
//  Run:  ~/.bun/bin/bun run scripts/mcp/prove-kit-dials.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRATCH = mkdtempSync(join(tmpdir(), 'kit-dials-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
const PROJECT = join(SCRATCH, 'project')
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_SESSION_KIT
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const deepEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — kit-dials prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

console.log('============================================================')
console.log(' KIT-DIALS — the session owns its dials')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

const pin = await import('../../src/services/mcp/sessionKitPin.ts')
const kit = await import('../../src/daemon/sessionKit.ts')
const dial = await import('../../src/services/mcp/kitDial.ts')
const membership = await import('../../src/services/mcp/membership.ts')

/** Snapshot every file under the scratch config home (path → bytes). */
const homeSnapshot = (): Record<string, string> => {
  const home = process.env.MERCURY_CONFIG_DIR!
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else out[p] = readFileSync(p, 'utf8')
    }
  }
  walk(home)
  return out
}

const K_A = { schema: 1, mcp: ['alpha'], skills: ['ns:deploy'], invocable: [] }
const K_B = { schema: 1, mcp: ['alpha', 'beta'], skills: [], invocable: ['ns:deploy'] }

// ── §B the dial's setter (poison-first) ─────────────────────────────────────
section('§B the setter beside the completion')
{
  pin._resetSessionKitPinForTesting()
  // B1 none → pinned.
  const s1 = pin.setProcessSessionKit(K_A as never)
  t('B1 none→pinned latches the validated kit', s1.ok === true && deepEq(pin.sessionKitOf(), K_A))
  // B2 pinned → pinned replaces.
  const s2 = pin.setProcessSessionKit(K_B as never)
  t('B2 pinned→pinned replaces whole', s2.ok === true && deepEq(pin.sessionKitOf(), K_B))
  // B4 POISON: malformed never latches, the standing latch unmoved.
  const bad = pin.setProcessSessionKit({ schema: 1, mcp: ['sp ace'], skills: [], invocable: [] } as never)
  t('B4 malformed refuses typed and the latch is unmoved', bad.ok === false && /is not an MCP server name/.test((bad as { reason: string }).reason) && deepEq(pin.sessionKitOf(), K_B))
  // B5 the completion law untouched: a RESOLVED latch never flips through
  // the completion; an UNRESOLVED one still does, only there.
  t('B5a completion refuses a resolved latch', pin.completeProcessSessionKit(K_A as never) === false && deepEq(pin.sessionKitOf(), K_B))
  const unresolved = { schema: 1, mcp: [], skills: [], invocable: [], resolved: false, deltas: { mcpOff: ['beta'], skillStates: {}, extensionsOff: [] } }
  t('B5b the setter may latch an unresolved kit (the materialized first dial)', pin.setProcessSessionKit(unresolved as never).ok === true && pin.sessionKitOf()?.resolved === false)
  t('B5c unresolved→resolved still moves ONLY through the completion', pin.completeProcessSessionKit(K_A as never) === true && pin.sessionKitOf()?.resolved === undefined)
  // B3 refused → pinned heals (the record is the truth; a validated forward
  // re-aligns record and process).
  pin._resetSessionKitPinForTesting()
  process.env.MERCURY_SESSION_KIT = 'not json'
  const consumed = pin.consumeSessionKitPin()
  const healed = pin.setProcessSessionKit(K_A as never)
  t('B3 refused→pinned heals through the setter', consumed.outcome === 'refused' && healed.ok === true && deepEq(pin.sessionKitOf(), K_A))
}
section('§B the record-less edit road (materialize from the STANDING reality)')
{
  // B6 POISON — the widening: the process was enforcing X off (the record);
  // its first dial (Y off) must NOT make X a member. The edit road
  // materializes deltas.mcpOff from the standing off-record the caller
  // renders.
  pin._resetSessionKitPinForTesting()
  const out = pin.applyProcessSessionKitEdit({ mcp: [{ name: 'ygg', on: false }] }, ['xoff'])
  const latched = pin.sessionKitOf()
  t('B6a the first dial materializes-then-edits (applied, unresolved, standing off carried)', out.outcome === 'applied' && latched?.resolved === false && deepEq(latched?.deltas?.mcpOff?.slice().sort(), ['xoff', 'ygg']))
  t('B6b the widening poison is dead: the record-off name stays OFF after the dial', membership.kitMembership(latched, 'xoff') === false)
  t('B6c the dialed name is off; an unspoken name stays a member', membership.kitMembership(latched, 'ygg') === false && membership.kitMembership(latched, 'zeta') === true)
  // B7 identity ⇒ noop, nothing re-latched.
  const again = pin.applyProcessSessionKitEdit({ mcp: [{ name: 'ygg', on: false }] }, ['xoff'])
  t('B7 the same dial again answers noop', again.outcome === 'noop' && deepEq(pin.sessionKitOf(), latched))
  // B8 the dial-on direction over the materialized kit.
  const on = pin.applyProcessSessionKitEdit({ mcp: [{ name: 'xoff', on: true }] }, ['xoff'])
  t('B8 dial-on lifts a standing off (session-scope widening is lawful)', on.outcome === 'applied' && membership.kitMembership(pin.sessionKitOf(), 'xoff') === true)
}

// ── §E the reconcile's pure halves ──────────────────────────────────────────
section('§E the delta (a dial is a delta, never a heal)')
{
  const before = { schema: 1, mcp: ['alpha', 'beta'], skills: [], invocable: [] }
  const after = { schema: 1, mcp: ['alpha', 'gamma'], skills: [], invocable: [] }
  const candidates = dial.kitDialCandidates(before as never, after as never, ['alpha', 'beta', 'stale'])
  t('E1a candidates = rows ∪ spoken names, deduped, row order first', deepEq(candidates, ['alpha', 'beta', 'stale', 'gamma']))
  const delta = dial.kitEditMcpDelta(before as never, after as never, candidates)
  t('E1b only CHANGED membership flips (beta off, gamma on; alpha untouched)', deepEq(delta, { connect: ['gamma'], disconnect: ['beta'] }))
  // 'stale' sits outside BOTH closed lists: was=false, is=false — a dial is
  // a delta, so it never flips (the full-state-heal poison).
  t('E1c a name off under both kits never flips', !delta.connect.includes('stale') && !delta.disconnect.includes('stale'))
}
{
  // E2 the unresolved arms: deltas-driven membership; provisional lists
  // never enter the candidates (the lead-ruled law).
  const before = { schema: 1, mcp: ['provisionalA'], skills: [], invocable: [], resolved: false, deltas: { mcpOff: ['beta'], skillStates: {}, extensionsOff: [] } }
  const after = { schema: 1, mcp: ['provisionalA'], skills: [], invocable: [], resolved: false, deltas: { mcpOff: [], skillStates: {}, extensionsOff: [] } }
  const candidates = dial.kitDialCandidates(before as never, after as never, ['alpha'])
  t('E2a provisional lists never enter the candidates', !candidates.includes('provisionalA') && deepEq(candidates, ['alpha', 'beta']))
  const delta = dial.kitEditMcpDelta(before as never, after as never, candidates)
  t('E2b lifting an off-delta connects exactly that name', deepEq(delta, { connect: ['beta'], disconnect: [] }))
}
{
  // E3 POISON: an empty kit must not sever an organ; a dial never governs one.
  const empty = { schema: 1, mcp: [], skills: [], invocable: [] }
  const delta = dial.kitEditMcpDelta(undefined, empty as never, dial.kitDialCandidates(undefined, empty as never, ['ide', 'mercury', 'alpha']))
  t('E3 organs are skipped whole (ide + the coordination server); the catalogue row flips', !delta.disconnect.includes('ide') && !delta.disconnect.includes('mercury') && delta.disconnect.includes('alpha'))
}
{
  // E4 the drop updater: one server's contributions leave; the sibling's
  // stay (the poison: a dial-off taking the sibling's tools with it).
  const cfg = { type: 'stdio', command: 'x', scope: 'dynamic' } as never
  const state = {
    mcp: {
      clients: [
        { name: 'alpha', type: 'connected', config: cfg },
        { name: 'beta', type: 'connected', config: cfg },
      ],
      tools: [{ name: 'mcp__alpha__go' }, { name: 'mcp__beta__go' }],
      commands: [{ name: 'mcp__alpha__cmd' }, { name: 'mcp__beta__cmd' }],
      resources: { alpha: [{ uri: 'a' }], beta: [{ uri: 'b' }] },
    },
  }
  const next = dial.dropMcpServerFromAppState(state as never, 'alpha', cfg)
  const alphaRow = next.mcp.clients.find(c => c.name === 'alpha')
  const betaRow = next.mcp.clients.find(c => c.name === 'beta')
  t('E4a the dropped server: row survives as a truthful disabled entry', alphaRow?.type === 'disabled')
  t('E4b its tools/commands/resources leave by prefix and key', !next.mcp.tools.some(x => x.name.startsWith('mcp__alpha__')) && !next.mcp.commands.some(x => x.name.startsWith('mcp__alpha__')) && !('alpha' in (next.mcp.resources ?? {})))
  t('E4c the sibling keeps everything (the poison is dead)', betaRow?.type === 'connected' && next.mcp.tools.some(x => x.name === 'mcp__beta__go') && next.mcp.commands.some(x => x.name === 'mcp__beta__cmd') && 'beta' in (next.mcp.resources ?? {}))
}

// ── §H the re-point (the disease is dead on the child's arms) ───────────────
section('§H the write re-point')
{
  // H1 the child's session-dial arms never write the shared record: the
  // print loop carries NO setMcpServerEnabled call at all (the old
  // mcp_toggle wrote it; the kit_edit arm never may).
  const src = read('src/cli/print.ts')
  // Call-shaped: the comment naming the dead disease may keep its name.
  t('H1 print.ts carries no setMcpServerEnabled CALL (the disease is gone from the child)', !src.includes('setMcpServerEnabled(') && !/import[^\n]*setMcpServerEnabled/.test(src))
  t('H1b the kit_edit arm exists and rides the serialized MCP mutation lane', /case 'kit_edit':/.test(src) && /kit_edit[\s\S]{0,2400}serializeMcpChange/.test(src))
  t('H1c the toggle arm dials the PROCESS KIT through the one edit road', /case 'mcp_toggle':[\s\S]{0,1800}applyProcessSessionKitEdit/.test(src))
  t('H1d the reconcile clears the command memos (the per-cwd model-list memo included)', /case 'kit_edit':[\s\S]{0,6200}clearCommandMemoizationCaches\(\)/.test(src))
  t('H1e the completion replay is guarded to the unresolved arm only', /sessionKitOf\(\)\?\.resolved === false/.test(src))
}
{
  // H2 DRIVEN: a process-local dial writes NO file under the config home
  // (the isolation law, the write half — byte-stable poison).
  pin._resetSessionKitPinForTesting()
  const beforeShot = homeSnapshot()
  const out = pin.applyProcessSessionKitEdit({ mcp: [{ name: 'alpha', on: false }] }, [])
  const afterShot = homeSnapshot()
  t('H2 a session dial writes NOTHING under the config home', out.outcome === 'applied' && deepEq(beforeShot, afterShot))
}
{
  // H3 the setter's caller census: the latch moves only through this
  // module's exported doors (consume/complete/set/edit) — no foreign
  // assignment.
  const pinSrc = read('src/services/mcp/sessionKitPin.ts')
  const assignments = (pinSrc.match(/latched = /g) ?? []).length
  t('H3 every latch assignment lives in sessionKitPin.ts (the one home)', assignments >= 5 && !read('src/cli/print.ts').includes('latched ='))
}

// ── §C the daemon forward (the record write and the live apply are ONE) ─────
section('§C the seat dial: idle forwards whole, busy parks honest, the beat drains')
{
  const seat = await import('../../src/daemon/sessionSeat.ts')
  const { readSessionWorkers, updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
  const { readSessionReceipts } = await import('../../src/services/switchboard/sessionReceipts.ts')
  const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
  const DAEMON_DIR = process.env.MERCURY_DAEMON_DIR!
  const SID = '22222222-3333-4444-8555-777777777777'
  updateConcourseWorkers(workers => {
    workers['w-dial'] = {
      schema: 1,
      runnerId: 'w-dial',
      sessionId: SID,
      workspaceId: PROJECT,
      isolation: 'shared',
      modelKey: 'test-model',
      effort: 'high',
      spawnedAt: Date.now(),
      lastLiveAt: Date.now(),
      kit: { schema: 1, mcp: ['alpha', 'beta'], skills: ['ns:deploy'], invocable: [] },
    } as never
  }, DAEMON_DIR)
  let busy = false
  let channelUp = true
  const frames: Array<{ short: string; frame: unknown }> = []
  const roster = {
    control: (short: string, frame: string): boolean => {
      if (!channelUp) return false
      frames.push({ short, frame: JSON.parse(frame) })
      return true
    },
    list: () => [{ short: 'w-dial', busy }],
    patchSeatModel: () => true,
    patchSeatEffort: () => true,
  }
  const kitFrames = (): Array<{ kit: unknown }> =>
    frames
      .map(f => (f.frame as { request?: { subtype?: string; kit?: unknown } }).request)
      .filter((r): r is { subtype: string; kit: unknown } => r?.subtype === 'kit_edit')
  const recOf = (): { kit?: { mcp: string[]; resolved?: false; deltas?: { mcpOff: string[] } }; pendingKitEdits?: unknown[] } =>
    readSessionWorkers(DAEMON_DIR)['w-dial'] as never

  // C1 idle: applied + ONE kit_edit frame carrying the record's EXACT
  // post-edit kit (record and wire speak one truth).
  const c1 = seat.setSessionKitDial(SID, { mcp: [{ name: 'beta', on: false }] }, 'operator', roster as never, DAEMON_DIR)
  t('C1a idle dial applies through the one writer', c1.outcome === 'applied' && deepEq(recOf().kit?.mcp, ['alpha']))
  t('C1b ONE kit_edit forward, byte-equal to the record kit', kitFrames().length === 1 && deepEq(kitFrames()[0]!.kit, recOf().kit))
  // C2 noop forwards nothing.
  const framesBefore = kitFrames().length
  const c2 = seat.setSessionKitDial(SID, { mcp: [{ name: 'beta', on: false }] }, 'operator', roster as never, DAEMON_DIR)
  t('C2 an identity dial answers noop and forwards nothing', c2.outcome === 'noop' && kitFrames().length === framesBefore)
  // C3 busy parks: the RECORD does not move either — the record write and
  // the live apply are ONE operation (poison: a record that says off over
  // a process that still holds the child).
  busy = true
  const c3 = seat.setSessionKitDial(SID, { mcp: [{ name: 'alpha', on: false }] }, 'agent-a', roster as never, DAEMON_DIR)
  t('C3a a mid-turn dial queues with the honest line', c3.outcome === 'queued' && c3.detail === seat.KIT_DIAL_QUEUED_DETAIL)
  t('C3b the park is whole: record kit unmoved, the edit parked with its asker, no forward', deepEq(recOf().kit?.mcp, ['alpha']) && recOf().pendingKitEdits?.length === 1 && deepEq((recOf().pendingKitEdits![0] as { by: string }).by, 'agent-a') && kitFrames().length === framesBefore)
  // C4 the idle edge drains: apply in order through the writer, ONE forward
  // of the final kit, the park cleared.
  busy = false
  seat.onSeatIdle('w-dial', roster as never, DAEMON_DIR)
  t('C4 the idle edge applies the parked dial and forwards once', deepEq(recOf().kit?.mcp, []) && recOf().pendingKitEdits === undefined && kitFrames().length === framesBefore + 1 && deepEq(kitFrames().at(-1)!.kit, recOf().kit))
  // C5 the respawn is a lawful beat too (the child died mid-turn; its
  // spec carried the pre-edit kit).
  busy = true
  seat.setSessionKitDial(SID, { skills: [{ name: 'ns:deploy', state: 'invocable' }] }, 'operator', roster as never, DAEMON_DIR)
  busy = false
  const beforeSpawnFrames = kitFrames().length
  seat.onSeatSpawned('w-dial', roster as never, DAEMON_DIR)
  const recAfterSpawn = readSessionWorkers(DAEMON_DIR)['w-dial'] as { kit?: { invocable: string[] } ; pendingKitEdits?: unknown[] }
  t('C5 the seat respawn drains the parked dials and forwards', deepEq(recAfterSpawn.kit?.invocable, ['ns:deploy']) && recAfterSpawn.pendingKitEdits === undefined && kitFrames().length === beforeSpawnFrames + 1)
  // C6 unknown session refuses typed.
  const c6 = seat.setSessionKitDial('00000000-0000-4000-8000-000000000000', { mcp: [{ name: 'x', on: true }] }, 'operator', roster as never, DAEMON_DIR)
  t('C6 unknown session refuses typed', c6.outcome === 'refused' && /unknown-session/.test(c6.detail ?? ''))
  // C7 a dead channel: the record still moves (the durable truth the next
  // boot carries) and the detail says the live half honestly.
  channelUp = false
  const c7 = seat.setSessionKitDial(SID, { mcp: [{ name: 'alpha', on: true }] }, 'operator', roster as never, DAEMON_DIR)
  t('C7 no live channel: applied on the record, the detail names the deferred live half', c7.outcome === 'applied' && /no live control channel/.test(c7.detail ?? '') && deepEq(recOf().kit?.mcp, ['alpha']))
  channelUp = true
  // C8 the dial receipts durably (kind kit-dial, the asker on by).
  const rows = readSessionReceipts(getProjectDir(PROJECT), SID).filter(r => r.kind === 'kit-dial')
  t('C8 the sidecar carries the kit-dial rows with the asker and the dial words', rows.length >= 3 && rows.some(r => r.by === 'agent-a') && rows.every(r => typeof (r.details as { dials?: unknown } | undefined)?.dials === 'string'))
  // C9 the pre-kit record's first dial materializes-then-edits — and the
  // materialization carries the workspace's STANDING off-record (D3, the
  // lead-ruled defect fix; the empty-deltas spelling was honest
  // only while nothing forwarded it: with a live forward, empty deltas
  // WIDEN the session — the record-disabled server becomes a member
  // because the unresolved arm never consults the record again).
  const { setMcpServerEnabledForWorkspace } = await import('../../src/services/mcp/kitStore.ts')
  setMcpServerEnabledForWorkspace(PROJECT, 'menuoff', false)
  const SID2 = '22222222-3333-4444-8555-888888888888'
  updateConcourseWorkers(workers => {
    workers['w-pre'] = {
      schema: 1,
      runnerId: 'w-pre',
      sessionId: SID2,
      workspaceId: PROJECT,
      isolation: 'shared',
      modelKey: 'test-model',
      effort: 'high',
      spawnedAt: Date.now(),
      lastLiveAt: Date.now(),
    } as never
  }, DAEMON_DIR)
  const preRoster = { ...roster, list: () => [{ short: 'w-pre', busy: false }] }
  const c9 = seat.setSessionKitDial(SID2, { mcp: [{ name: 'ygg', on: false }] }, 'operator', preRoster as never, DAEMON_DIR)
  const pre = readSessionWorkers(DAEMON_DIR)['w-pre'] as { kit?: { resolved?: false; deltas?: { mcpOff: string[] } } }
  t('C9 a pre-kit record materializes-then-edits and says so', c9.outcome === 'applied' && /materialized/.test(c9.detail ?? '') && pre.kit?.resolved === false && pre.kit.deltas?.mcpOff.includes('ygg') === true)
  t('C9b the materialization carries the workspace STANDING off-record (the widening poison, dead record-side)', pre.kit?.deltas?.mcpOff.includes('menuoff') === true)
  // C10 the main arm routes queued around the exactly-once ledger
  // (structural: the ledger's outcome union has no queued row).
  const mainSrc = read('src/daemon/main.ts')
  t('C10 the set-kit arm rides the seat and settles only the adjudicated outcomes', /setSessionKitDial\(sessionId, kitEdit, by, roster\)/.test(mainSrc) && /dialed\.outcome === 'queued'\s*\?\s*dialed\s*:\s*settle\(/.test(mainSrc))
}

// ── §G the connector verb (the setPermissionMode family) ────────────────────
section('§G setKit rides the connector, honest end to end')
{
  const typesSrc = read('src/services/engine-connector/types.ts')
  t('G1 the interface speaks the verb with the typed receipt', typesSrc.includes('setKit(edit: SessionKitEditV1): Promise<KitDialReceiptV1>') && /KitDialReceiptV1 = \{\s*\n\s*outcome: 'applied' \| 'queued' \| 'noop' \| 'refused'/.test(typesSrc))
  const dcSrc = read('src/services/engine-connector/daemonConnector.ts')
  const body = dcSrc.slice(dcSrc.indexOf('async setKit('), dcSrc.indexOf('workRoster(): WorkRosterV1'))
  t('G2 the daemon connector rides sessionControl set-kit with a minted op id', body.includes("action: 'set-kit'") && body.includes('kitEdit: edit') && body.includes('clientOpId:'))
  t('G3 no optimistic roster mutation (the daemon adjudication is the truth; queued must not paint a lie)', !body.includes('this.facts ='))
  const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
  const refused = await noSessionConnector().setKit({ mcp: [{ name: 'x', on: false }] } as never)
  t('G4 the resting slot refuses with the one no-chat sentence', refused.outcome === 'refused' && /no chat is open/.test(refused.detail ?? ''))
}

// ── §F skillsOff — the record-schema widening (the lead's Q4 ruling) ────────
section('§F skillsOff: the lying dial is dead (born-later off is expressible)')
{
  const govern = await import('../../src/skills/kitGovernance.ts')
  const completion = await import('../../src/services/mcp/kitCompletion.ts')
  // F1 validator round-trip; empty stays absent (absent ≠ empty).
  const v1 = kit.validateSessionKit({ schema: 1, mcp: [], skills: ['a'], invocable: [], skillsOff: ['b'] })
  t('F1a the validator accepts and preserves skillsOff', v1.ok === true && deepEq((v1 as { kit: { skillsOff?: string[] } }).kit.skillsOff, ['b']))
  const v2 = kit.validateSessionKit({ schema: 1, mcp: [], skills: [], invocable: [], skillsOff: [] })
  t('F1b an empty skillsOff is dropped, not kept (absent ≠ empty)', v2.ok === true && (v2 as { kit: { skillsOff?: string[] } }).kit.skillsOff === undefined)
  // F2 disjointness refuses typed (one state per skill).
  const v3 = kit.validateSessionKit({ schema: 1, mcp: [], skills: ['x'], invocable: [], skillsOff: ['x'] })
  const v4 = kit.validateSessionKit({ schema: 1, mcp: [], skills: [], invocable: ['y'], skillsOff: ['y'] })
  t('F2 off∩on and off∩invocable refuse typed', v3.ok === false && /one state/.test((v3 as { reason: string }).reason) && v4.ok === false && /one state/.test((v4 as { reason: string }).reason))
  // F3 the resolved edit arm: an off-dial on an ABSENT name is a CHANGE
  // (the old noop was the LYING DIAL — the record could not say off for a
  // born-later name and the skill stayed ambient).
  const resolved = { schema: 1, mcp: [], skills: ['s1'], invocable: [], } as unknown as Parameters<typeof kit.applyKitEdit>[0]
  const offed = kit.applyKitEdit(resolved, { skills: [{ name: 'ghost', state: 'off' }] })
  t('F3a an off-dial on an absent name APPLIES and records the explicit off', offed !== resolved && deepEq((offed as { skillsOff?: string[] }).skillsOff, ['ghost']))
  const noop = kit.applyKitEdit(offed, { skills: [{ name: 'ghost', state: 'off' }] })
  t('F3b the re-dial answers by identity (noop)', noop === offed)
  const backOn = kit.applyKitEdit(offed, { skills: [{ name: 'ghost', state: 'on' }] })
  t('F3c an on-dial lifts the row and drops the empty field', deepEq((backOn as { skills: string[] }).skills.slice().sort(), ['ghost', 's1']) && (backOn as { skillsOff?: string[] }).skillsOff === undefined)
  // F4 the overlay: skillsOff outranks — a BORN-LATER skill drops when
  // explicitly offed (the poison: plain absence leaves it ungoverned/on).
  govern._resetKitGovernanceForTesting()
  govern.noteBootSkillRoster(['seen'])
  const cmd = { type: 'prompt', name: 'late:skill', loadedFrom: 'skills' } as never
  const kitPlain = { schema: 1, mcp: [], skills: [], invocable: [] } as never
  const kitOff = { schema: 1, mcp: [], skills: [], invocable: [], skillsOff: ['late:skill'] } as never
  t('F4a POISON armed: plain absence leaves a born-later skill on (author frontmatter)', govern.kitDropsCommand(kitPlain, cmd) === false)
  t('F4b the explicit off drops it — the dial speaks for born-later names too', govern.kitDropsCommand(kitOff, cmd) === true)
  // F5 the completion's off-carry: a deltas-off name missing from the
  // post-overlay roster survives resolution as an explicit off, and the
  // composed kit still passes the wire's narrowing.
  const unresolved = { schema: 1, mcp: [], skills: [], invocable: [], resolved: false, deltas: { mcpOff: [], skillStates: { 'late:skill': 'off' }, extensionsOff: [] } } as never
  const composed = completion.completeSessionKitFromRoster(unresolved, { mcpNames: [], commands: [], extensions: [] })
  t('F5 the re-completion carries the explicit off and validates', deepEq((composed as { skillsOff?: string[] }).skillsOff, ['late:skill']) && kit.validateSessionKit(composed).ok === true)
  // F6 the one materialization spelling grammar-filters (a store spelling
  // the wire would refuse never poisons the kit).
  const mat = kit.materializedWholeConfigKit(['ok', 'sp ace'])
  t('F6 materialization grammar-filters the standing off-record', deepEq(mat.deltas?.mcpOff, ['ok']))
  govern._resetKitGovernanceForTesting()
}

// ── §A the /mcp write re-point (screen side) ────────────────────────────────
section('§A the screen dial rides the connector; the panel estate dials its own latch')
{
  const cmdSrc = read('src/commands/mcp/mcp.tsx')
  t('A1 the composer walks no client set and writes no store: the toggle rides connector.setKit over the SESSION roster', !cmdSrc.includes('useMcpToggleEnabled') && cmdSrc.includes('connector.setKit({ mcp: dials })') && cmdSrc.includes('connector.mcpRoster()'))
  t('A1b organs are named, never dialed (ide owned by /ide)', cmdSrc.includes('isMcpOrgan(target)') && read('src/commands/mcp/route.ts').includes('owned by /ide'))
  // A2 THE TWO-LINE SEAM, DRIVEN END TO END on the real ports object: the
  // screen estate's toggle edits the PROCESS KIT — no config file moves,
  // and the registry's own disk consult answers the new truth at once.
  pin._resetSessionKitPinForTesting()
  const { liveMcpRegistryPorts } = await import('../../src/services/mcp/registry/livePorts.ts')
  const ports = liveMcpRegistryPorts()
  const beforeShot = homeSnapshot()
  ports.setEnabledOnDisk('panelsrv', false)
  t('A2a the panel dial writes NOTHING under the config home', deepEq(homeSnapshot(), beforeShot))
  t('A2b the owner reads the latch: isDisabledOnDisk flips at once', ports.isDisabledOnDisk('panelsrv') === true && ports.isDisabledOnDisk('othersrv') === false)
  ports.setEnabledOnDisk('panelsrv', true)
  t('A2c the on-direction lifts it (session-scope, both directions)', ports.isDisabledOnDisk('panelsrv') === false && deepEq(homeSnapshot(), beforeShot))
  pin._resetSessionKitPinForTesting()
  // A3 the words: SESSION scope + the menu pointer, spoken from route.ts
  // (the one sentence owner), all four receipt arms.
  const route = await import('../../src/commands/mcp/route.ts')
  t('A3a the roster line says SESSION and points at the boot menu', route.mcpRosterLine({ clients: [{ name: 'a', type: 'connected' }] } as never).includes('this session only, the boot menu sets the next session\'s'))
  t('A3b the empty line points at the boot menu', route.MCP_EMPTY_ROSTER_LINE.includes("boot menu's MCPs & Skills"))
  t('A3c the receipt lines: applied says session-only; queued speaks the turn\'s end; noop and refused carry the detail', route.kitDialLine({ outcome: 'applied' }, 'X').includes('this session only') && route.kitDialLine({ outcome: 'queued', detail: 'the dials apply when this turn ends' }, 'X').includes("turn ends") && route.kitDialLine({ outcome: 'noop', detail: 'd' }, 'X').includes('No change — d') && route.kitDialLine({ outcome: 'refused', detail: 'r' }, 'X').includes('refused — r'))
  t('A4 the panel names its estate honestly', read('src/components/mcp/MCPSettings.tsx').includes("this screen's servers — sessions carry their own; the boot menu sets the next session's"))
}

// ── §S /skills — the session dial, both directions ──────────────────────────
section('§S the skills dial: session rows, off rows listed, tri-state words')
{
  const govern = await import('../../src/skills/kitGovernance.ts')
  const terms = await import('../../src/services/engine-connector/rosterTerms.ts')
  govern._resetKitGovernanceForTesting()
  govern.noteBootSkillRoster(['ns:seen', 'ns:offed'])
  const resolved = { schema: 1, mcp: [], skills: ['ns:seen'], invocable: [], skillsOff: ['late:born'] } as never
  // S1 the off-name derivation: a boot-visible name the kit dropped + the
  // explicit born-later off; never a table-present name; un-kitted = none.
  const off = govern.offSkillNamesOf(resolved, ['ns:seen'])
  t('S1a off rows = dropped boot names + explicit offs', deepEq(off.slice().sort(), ['late:born', 'ns:offed']))
  t('S1b a table-present name is never claimed off', !govern.offSkillNamesOf(resolved, ['ns:seen', 'ns:offed']).includes('ns:offed'))
  t('S1c an un-kitted process has nothing off', deepEq(govern.offSkillNamesOf(undefined, []), []))
  const invocableKit = { schema: 1, mcp: [], skills: [], invocable: ['ns:seen', 'ns:offed'], } as never
  t('S1d an invocable name is not an off row', deepEq(govern.offSkillNamesOf(invocableKit, []), []))
  // S2 the roster projection: off rows appended with the state word; the
  // table row wins a collision; invocable still projected.
  const cmds = [
    { type: 'prompt', name: 'ns:seen', description: 'd', loadedFrom: 'skills', source: 'projectSettings' },
    { type: 'prompt', name: 'ns:inv', description: 'd2', loadedFrom: 'skills', source: 'projectSettings', disableModelInvocation: true },
  ] as never[]
  const roster = terms.skillsRosterOf(cmds, ['ns:offed', 'ns:seen'])
  t('S2a the off row rides the projection with the state word and no description', deepEq(roster.find(r => r.name === 'ns:offed'), { name: 'ns:offed', description: '', state: 'off' }))
  t('S2b the table row wins a collision (the table is the process truth)', roster.filter(r => r.name === 'ns:seen').length === 1 && roster.find(r => r.name === 'ns:seen')?.state === undefined)
  t('S2c the invocable word still projects', roster.find(r => r.name === 'ns:inv')?.state === 'invocable')
  // S3 the command's arm table + the screen's needles.
  const cmdSrc = read('src/commands/skills/skills.tsx')
  t('S3 /skills rides the SESSION dial when a chat is focused; the screen table only for the resting slot', cmdSrc.includes('hasFocusedSession()') && cmdSrc.includes('SessionSkillsDial') && cmdSrc.includes('SkillsMenu'))
  const dialSrc = read('src/components/skills/SessionSkillsDial.tsx')
  t('S4a the dial rides the one connector verb and paints the honest receipt arms', dialSrc.includes(".setKit({ skills: [{ name: row.name, state: next }] })") && dialSrc.includes('kitDialLine'))
  t('S4b the words say SESSION and point at the boot menu (empty line included)', dialSrc.includes("this session's skills — the boot menu sets the next session's") && dialSrc.includes("No skills in this session. The boot menu's MCPs & Skills sets the next session's."))
  t('S4c no optimistic paint: the roster reads the session facts, never a local mutation', !dialSrc.includes('useState<SkillsRosterEntryV1') && dialSrc.includes('useSyncExternalStore'))
  // S5 the facts projection wiring (the child's off rows).
  const printSrc = read('src/cli/print.ts')
  t('S5 the child projects off rows beside the table roster', printSrc.includes('skillsRosterOf(activeCommands, offSkillNamesOf(sessionKitOf()'))
  govern._resetKitGovernanceForTesting()
}

// ── §D isolation, BOTH directions (the operator's law, pinned at the doors) ─
section('§D a dial never writes config/menu/sibling; a menu edit never reaches a live session')
{
  const seat = await import('../../src/daemon/sessionSeat.ts')
  const { readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
  const { setMcpServerEnabledForWorkspace, kitDeltasForWorkspace } = await import('../../src/services/mcp/kitStore.ts')
  const DAEMON_DIR = process.env.MERCURY_DAEMON_DIR!
  const SID = '22222222-3333-4444-8555-777777777777'
  // The CONFIG estate = every home file OUTSIDE the session-storage tree
  // (the dial's receipt sidecar is the session's own and lawful).
  const configShot = (): Record<string, string> => {
    const all = homeSnapshot()
    return Object.fromEntries(Object.entries(all).filter(([p]) => !p.includes('projects')))
  }
  const roster = { control: () => true, list: () => [{ short: 'w-dial', busy: false }], patchSeatModel: () => true, patchSeatEffort: () => true }
  // D1 the daemon-arm dial: the config estate byte-stable, the SIBLING
  // record byte-stable (two records, dial A, census B).
  const sibBefore = JSON.stringify((readSessionWorkers(DAEMON_DIR)['w-pre'] as { kit?: unknown }).kit)
  const cfgBefore = configShot()
  const d1 = seat.setSessionKitDial(SID, { mcp: [{ name: 'isoprobe', on: true }] }, 'operator', roster as never, DAEMON_DIR)
  t('D1a the dial applied', d1.outcome === 'applied')
  t('D1b the CONFIG estate is byte-stable across a daemon-arm dial (menu store included)', deepEq(configShot(), cfgBefore))
  t('D1c the SIBLING record is byte-stable (dial A, census B)', JSON.stringify((readSessionWorkers(DAEMON_DIR)['w-pre'] as { kit?: unknown }).kit) === sibBefore)
  // D2 the REVERSE direction: a MENU edit moves the store and NOTHING else —
  // the live record keeps its kit, and a latched process's membership never
  // re-reads the record (the L24(3) "a live session keeps its set" half).
  const recBefore = JSON.stringify((readSessionWorkers(DAEMON_DIR)['w-dial'] as { kit?: unknown }).kit)
  pin._resetSessionKitPinForTesting()
  pin.setProcessSessionKit({ schema: 1, mcp: ['keepme'], skills: [], invocable: [] } as never)
  setMcpServerEnabledForWorkspace(PROJECT, 'keepme', false)
  t('D2a the menu store took the edit (the fixture is real)', kitDeltasForWorkspace(PROJECT).mcpOff.includes('keepme'))
  t('D2b the live record never moves on a menu edit', JSON.stringify((readSessionWorkers(DAEMON_DIR)['w-dial'] as { kit?: unknown }).kit) === recBefore)
  t('D2c a latched process\'s membership never re-reads the record (the live session keeps its set)', membership.isMcpCatalogueMember('keepme') === true)
  pin._resetSessionKitPinForTesting()
  // D3 the menu write road never touches the dial doors (call census).
  const menuStoreSrc = read('src/services/kitMenu/menuStore.ts')
  t('D3 the menu store speaks its workspace writers only — no sessionControl, no latch, no writer', !menuStoreSrc.includes('setKit(') && !menuStoreSrc.includes('applyConcourseKitOp') && !menuStoreSrc.includes('setProcessSessionKit') && !menuStoreSrc.includes('applyProcessSessionKitEdit'))
}

console.log(failures === 0 ? '\nPASS prove-kit-dials' : `\nFAIL prove-kit-dials (${failures})`)
process.exit(failures === 0 ? 0 : 1)
