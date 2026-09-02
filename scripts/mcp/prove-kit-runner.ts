// ============================================================================
// prove-kit-runner — the pins: sessions OBEY their kit.
//
//  THE LAWS UNDER PROOF (ledger L24(1)–(5) + L24(6-SUPERSEDED); the
//  kit brief outranks earlier kit documents):
//    §K  the carry — record.kit → spawn spec (extraEnv MERCURY_SESSION_KIT,
//        respawn-carried) → the runner's consumed-once latch. POISON: a kit
//        dropped silently ⇒ whole-config (the scope leak); a malformed pin
//        falling to whole-config instead of the EMPTY kit.
//    (later commits append their sections: the swap at the one owner ·
//    organs outside · the completion through session_facts · the extension
//    stores' AND · the inline side door · subagent ∩.)
//
//  Hermetic: scratch config home + scratch daemon dir + scratch non-git
//  project cwd; no network; NOTHING spawns (cpu-pure — record fixtures and
//  the exported seams only; the real spawned-runner drill is a
//  NEEDS-REAL-BOX leg).
//  Run:  ~/.bun/bin/bun run scripts/mcp/prove-kit-runner.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRATCH = mkdtempSync(join(tmpdir(), 'kit-runner-'))
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
  console.log('\nTIMEOUT — kit-runner prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

console.log('============================================================')
console.log(' KIT-RUNNER — sessions obey their kit')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

// The wire-legal fixtures (every name passes the sessionKit grammars).
const K_RESOLVED = {
  schema: 1,
  mcp: ['alpha', 'ext:tools-ext:probe'],
  skills: ['ns:deploy'],
  invocable: ['notes'],
} as const
const K_UNRESOLVED = {
  schema: 1,
  mcp: ['alpha'],
  skills: [],
  invocable: [],
  resolved: false,
  deltas: { mcpOff: ['beta'], skillStates: { notes: 'off' }, extensionsOff: [] },
} as const

// ── §K the carry: record.kit → spec → the consumed-once latch ───────────────
section('§K the carry (poison-first: a dropped or malformed kit must never mean whole-config)')
{
  const pin = await import('../../src/services/mcp/sessionKitPin.ts')

  // POISON 1 — the malformed pin. Whole-config here would be the exact
  // scope leak the wire's refusal law names; the latch must be the EMPTY
  // kit (loads nothing) and the env must be scrubbed either way.
  pin._resetSessionKitPinForTesting()
  process.env.MERCURY_SESSION_KIT = '{not json'
  let receipt = pin.consumeSessionKitPin()
  t(
    'K1 POISON armed: a non-JSON pin latches the EMPTY kit (never undefined = never whole-config), outcome refused',
    receipt.outcome === 'refused' && deepEq(pin.sessionKitOf(), { schema: 1, mcp: [], skills: [], invocable: [] }),
    JSON.stringify(receipt),
  )
  t('K2 the malformed pin is scrubbed from process.env all the same', process.env.MERCURY_SESSION_KIT === undefined)
  pin._resetSessionKitPinForTesting()
  process.env.MERCURY_SESSION_KIT = JSON.stringify({ schema: 1, mcp: ['bad name!'], skills: [], invocable: [] })
  receipt = pin.consumeSessionKitPin()
  t(
    'K3 POISON armed: a wire-invalid pin (bad MCP grammar) refuses the same way — EMPTY kit, typed reason',
    receipt.outcome === 'refused' && receipt.reason.length > 0 && deepEq(pin.sessionKitOf(), { schema: 1, mcp: [], skills: [], invocable: [] }),
  )

  // The lawful arms.
  pin._resetSessionKitPinForTesting()
  process.env.MERCURY_SESSION_KIT = JSON.stringify(K_RESOLVED)
  receipt = pin.consumeSessionKitPin()
  t(
    'K4 a valid resolved pin latches byte-true and scrubs the env (grandchildren never inherit)',
    receipt.outcome === 'pinned' && deepEq(pin.sessionKitOf(), K_RESOLVED) && process.env.MERCURY_SESSION_KIT === undefined,
  )
  process.env.MERCURY_SESSION_KIT = JSON.stringify(K_UNRESOLVED)
  receipt = pin.consumeSessionKitPin()
  t(
    'K5 the latch is once-per-process: a second consume with a DIFFERENT env answers the first latch and re-scrubs',
    receipt.outcome === 'pinned' && deepEq(pin.sessionKitOf(), K_RESOLVED) && process.env.MERCURY_SESSION_KIT === undefined,
  )
  pin._resetSessionKitPinForTesting()
  process.env.MERCURY_SESSION_KIT = JSON.stringify(K_UNRESOLVED)
  receipt = pin.consumeSessionKitPin()
  t('K6 an unresolved pin latches with its deltas intact (the completion reads them; nothing reads its lists as membership)', receipt.outcome === 'pinned' && deepEq(pin.sessionKitOf(), K_UNRESOLVED))
  pin._resetSessionKitPinForTesting()
  receipt = pin.consumeSessionKitPin()
  t("K7 no pin ⇒ outcome 'none' and an undefined process kit (whole-config membership — a plain boot, a warm runner before its claim)", receipt.outcome === 'none' && pin.sessionKitOf() === undefined)
  pin._resetSessionKitPinForTesting()
}

section('§K2 the spec composes the carry (the daemon half)')
{
  const { buildConcourseWorkerSpec } = await import('../../src/daemon/concourseSupervisor.ts')
  const base = { runnerId: 'w-kit', sessionId: '11111111-2222-4333-8444-555555555555', workspaceId: PROJECT, modelKey: 'test-model' }
  const withKit = buildConcourseWorkerSpec({ ...base, kit: K_RESOLVED as never })
  const parsed = JSON.parse((withKit.extraEnv as Record<string, string>).MERCURY_SESSION_KIT ?? 'null') as unknown
  t('K8 a kit on the spec rides extraEnv as its exact JSON (beside the home pin, respawn-carried by the spec law)', deepEq(parsed, K_RESOLVED) && typeof (withKit.extraEnv as Record<string, string>).MERCURY_SESSION_HOME === 'string')
  const noKit = buildConcourseWorkerSpec({ ...base })
  t("K9 no kit ⇒ the key is ABSENT from extraEnv (absent, never the string 'undefined' — absence IS the whole-config law)", !('MERCURY_SESSION_KIT' in (noKit.extraEnv as Record<string, string>)))
  // AMENDED: the warm ENSURE now hands every warm spec its own
  // kit (the next birth's — the claim lands on byte-equality only,
  // prove-kit-birth §G). The BUILDER's law is unchanged and is what this
  // pin holds: a kit-less spec stamps no env key, warm or not.
  const warm = buildConcourseWorkerSpec({ runnerId: 'w-warm', workspaceId: PROJECT, modelKey: 'test-model', warm: true })
  t('K10 the builder stamps NO kit env on a kit-less spec, warm included (absence is the law; the warm ensure hands its own kit — prove-kit-birth §G)', !('MERCURY_SESSION_KIT' in (warm.extraEnv as Record<string, string>)))
  const round = await import('../../src/daemon/sessionKit.ts')
  const validated = round.validateSessionKit(parsed)
  t("K11 the carried JSON round-trips the wire's own narrowing (the runner re-validates the daemon's bytes)", validated.ok && deepEq(validated.ok ? validated.kit : null, K_RESOLVED))
}

section('§K3 call-site census (source-shape: every non-warm road passes the kit; one env owner)')
{
  const supervisor = readFileSync(join(REPO, 'src', 'daemon', 'concourseSupervisor.ts'), 'utf8')
  // K12's hoist needle AMENDED (the spelling, not the
  // law): the ONE hoisted value folds the preset arm (carried ?? preset ??
  // derived) — spec and stamp still share exactly one value.
  t('K12 the cold mint HOISTS one kit for spec and stamp (record and process can never disagree)', supervisor.includes('const kit = req.kit ?? preset?.kit ?? deriveSessionKitForWorkspace(workspaceId)') && supervisor.includes('...kitStampOf(kit),'))
  t("K13 the reactivate cold road hands the revive its restamp kit (the spec is built BEFORE the restamp writes)", supervisor.includes('kitOverride: kit }'))
  t("K14 the revive's default is the record's standing kit; the hand-back road carries rec.kit", supervisor.includes('const reviveKit = opts?.kitOverride ?? rec.kit') && supervisor.includes('...(rec.kit !== undefined ? { kit: rec.kit } : {})'))
  const spawnEnvWrites = supervisor.split('MERCURY_SESSION_KIT: JSON.stringify').length - 1
  t('K15 the spec builder is the ONE env writer in the daemon (a single key-write site; comments free to name the spelling)', spawnEnvWrites === 1, `${spawnEnvWrites} sites`)
  const main = readFileSync(join(REPO, 'src', 'main.tsx'), 'utf8')
  t('K16 the runner consumes the pin ONCE, before MCP resolution and the command load (the shared prep)', main.includes('consumeSessionKitPin()') && main.indexOf('consumeSessionKitPin()') < main.indexOf('parseDynamicMcpConfigs('))
  const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')
  const row = (FLAG_REGISTRY as ReadonlyArray<{ env: string; kind: string }>).find(r => r.env === 'MERCURY_SESSION_KIT')
  t("K17 the flagRegistry row exists, kind 'value' (prove-flag-registry enforces the read pattern mechanically)", row !== undefined && row.kind === 'value')
}

// ── §S the swap at the ONE owner (driven: the latch + the real record) ──────
section('§S the swap: every membership road answers the process kit through the one owner')
{
  const pin = await import('../../src/services/mcp/sessionKitPin.ts')
  const membership = await import('../../src/services/mcp/membership.ts')
  const { setMcpServerEnabled } = await import('../../src/services/mcp/config.ts')
  const latch = (kit: unknown): void => {
    pin._resetSessionKitPinForTesting()
    process.env.MERCURY_SESSION_KIT = JSON.stringify(kit)
    pin.consumeSessionKitPin()
  }

  // The record under the scratch home: 'srv-off' disabled, everything else on.
  setMcpServerEnabled('srv-off', false)
  pin._resetSessionKitPinForTesting()
  t("S1 no latch ⇒ today's record predicate, byte-true (the screen, a plain boot, a warm runner)", membership.isMcpCatalogueMember('alpha') === true && membership.isMcpCatalogueMember('srv-off') === false)

  latch({ schema: 1, mcp: ['alpha', 'srv-off'], skills: [], invocable: [] })
  t("S2 POISON armed (the live-session law, driven through the OWNER): the kit lists 'srv-off' — the record's disable is NEVER consulted for a kitted process", membership.isMcpCatalogueMember('srv-off') === true && membership.isMcpCatalogueMember('alpha') === true)
  t("S3 POISON armed (the other direction): 'beta' is ON in the record but OUTSIDE the resolved kit ⇒ not a member (resolved lists ARE the membership)", membership.isMcpCatalogueMember('beta') === false)

  latch({ schema: 1, mcp: [], skills: [], invocable: [] })
  t('S4 the EMPTY resolved kit admits NOTHING configured (empty ≠ absent — L24(1) "absent from that session\'s process")', membership.isMcpCatalogueMember('alpha') === false && membership.isMcpCatalogueMember('beta') === false)
  t("S5 ORGANS OUTSIDE (Q1): the EMPTY kit still mounts the ide bridge and the enabled coordination server ('mercury')", membership.isMcpCatalogueMember('ide') === true && membership.isMcpCatalogueMember('mercury') === true && membership.isMcpOrgan('ide') && membership.isMcpOrgan('mercury'))
  process.env.MERCURY_COORDINATION_MCP = '0'
  t("S6 with the coordination server OFF, 'mercury' is an ordinary name — the kit governs it (no organ hole for a user server that borrowed the name)", membership.isMcpCatalogueMember('mercury') === false && !membership.isMcpOrgan('mercury'))
  delete process.env.MERCURY_COORDINATION_MCP

  latch({ schema: 1, mcp: ['ghost-list'], skills: [], invocable: [], resolved: false, deltas: { mcpOff: ['beta'], skillStates: {}, extensionsOff: [] } })
  t("S7 an UNRESOLVED latch is deltas-only at the owner: 'beta' (delta-off) out; 'alpha' in; 'srv-off' in (the record ignored); its provisional list is NEVER membership ('ghost-list' grants nothing beyond delta absence)", membership.isMcpCatalogueMember('beta') === false && membership.isMcpCatalogueMember('alpha') === true && membership.isMcpCatalogueMember('srv-off') === true)

  latch({ schema: 1, mcp: ['alpha'], skills: [], invocable: [] })
  const split = membership.partitionMcpConfigsByMembership({
    alpha: { type: 'stdio', command: 'a', scope: 'local' } as never,
    beta: { type: 'stdio', command: 'b', scope: 'local' } as never,
  })
  t("S8 the runner batch partition follows the owner (excluded entries become truthful 'disabled' rows and are never dialed — the landed semantics under the kit)", split.members.length === 1 && split.members[0]?.[0] === 'alpha' && split.excluded.length === 1 && split.excluded[0]?.[0] === 'beta')

  // Parity needles: the organ spellings equal their owners' (the M15
  // spelled-beside-it precedent — membership.ts must not import the
  // coordination graph).
  const owner = readFileSync(join(REPO, 'src', 'services', 'mcp', 'membership.ts'), 'utf8')
  const coord = readFileSync(join(REPO, 'src', 'services', 'mcp', 'coordinationServer.ts'), 'utf8')
  const catalogue = readFileSync(join(REPO, 'src', 'services', 'kitMenu', 'kitCatalogue.ts'), 'utf8')
  t('S9 the organ spellings are pinned equal to their owners (coordination name + env + the =0-only off-switch; the ide client name)', owner.includes("COORDINATION_ORGAN_NAME = 'mercury'") && coord.includes("COORDINATION_SERVER_NAME = 'mercury'") && coord.includes("'MERCURY_COORDINATION_MCP'") && coord.includes("=== '0'") && owner.includes("flagEnv('MERCURY_COORDINATION_MCP') !== '0'") && owner.includes("IDE_ORGAN_NAME = 'ide'") && catalogue.includes("IDE_CLIENT_NAME = 'ide'"))
  const kitFiles = ['src/services/mcp/sessionKitPin.ts', 'src/services/mcp/membership.ts', 'src/skills/kitGovernance.ts']
  const worldDirty = kitFiles.filter(f => /chatOnlyBoot|chatBoot\(|MERCURY_SPLASH_CHAT/.test(readFileSync(join(REPO, f), 'utf8')))
  t('S10 no world check anywhere in the kit path (the L24(6-SUPERSEDED) law): the kit modules read no world predicate', worldDirty.length === 0, worldDirty.join(','))
  pin._resetSessionKitPinForTesting()
  delete process.env.MERCURY_SESSION_KIT
}

// ── §C the completion: provisional → resolved, through session_facts, once ──
section('§C the completion (poison: a second road to resolved; a resolved record overwritten)')
{
  const pin = await import('../../src/services/mcp/sessionKitPin.ts')
  const g = await import('../../src/skills/kitGovernance.ts')
  const { completeSessionKitFromRoster } = await import('../../src/services/mcp/kitCompletion.ts')
  const membership = await import('../../src/services/mcp/membership.ts')

  const UNRESOLVED = {
    schema: 1,
    mcp: ['ghost'],
    skills: [],
    invocable: [],
    resolved: false,
    deltas: { mcpOff: ['beta'], skillStates: { 's:inv': 'invocable', 's:off': 'off' }, extensionsOff: ['quiet-ext'] },
  }
  const ROSTER = {
    mcpNames: ['alpha', 'beta', 'mercury', 'ext:quiet-ext:helper', 'ext:loud-ext:tool', 'bad name!'],
    commands: [
      { type: 'prompt', name: 's:on', description: '', loadedFrom: 'skills', source: 'projectSettings' },
      { type: 'prompt', name: 's:inv', description: '', loadedFrom: 'skills', source: 'projectSettings', disableModelInvocation: true, kitSkillState: 'invocable' },
      { type: 'prompt', name: 'quiet-ext:sk', description: '', loadedFrom: 'extension', source: 'extension', skillRoot: '/x', extensionInfo: { manifest: { name: 'quiet-ext' } } },
      { type: 'prompt', name: 'help', description: '', source: 'builtin' },
    ] as never[],
    extensions: ['quiet-ext', 'loud-ext'],
  }
  const R = completeSessionKitFromRoster(UNRESOLVED as never, ROSTER as never)
  t(
    'C1 the composer applies the DELTAS to the runner\'s own roster: delta-off and off-master servers out, organs out, wire-illegal spellings out; the provisional list grants NOTHING',
    deepEq(R.mcp, ['alpha', 'ext:loud-ext:tool']) && !R.mcp.includes('ghost') && !R.mcp.includes('mercury'),
    JSON.stringify(R.mcp),
  )
  t("C2 the skills halves follow the overlay's own product (kit-on unmarked; kit-invocable marked; an off-master extension skill contributes nothing; builtins never)", deepEq(R.skills, ['s:on']) && deepEq(R.invocable, ['s:inv']))
  t("C3 the masters land on the snapshot ('off' survives even for a master the active set still lists)", deepEq(R.extensions, { 'quiet-ext': 'off', 'loud-ext': 'on' }))
  const revalidated = (await import('../../src/daemon/sessionKit.ts')).validateSessionKit(R)
  t('C4 the composed kit is RESOLVED and wire-legal (the daemon will stamp these exact bytes)', revalidated.ok && R.resolved === undefined)

  // The flip: provisional membership visibly NARROWS to the closed lists.
  g._resetKitGovernanceForTesting()
  pin._resetSessionKitPinForTesting()
  process.env.MERCURY_SESSION_KIT = JSON.stringify(UNRESOLVED)
  pin.consumeSessionKitPin()
  const beforeFlip = membership.isMcpCatalogueMember('gamma-not-configured')
  const flipped = pin.completeProcessSessionKit(R)
  t('C5 the latch flips unresolved → resolved and membership closes (a name the deltas would admit is now out — the lists ARE the membership)', flipped && beforeFlip === true && membership.isMcpCatalogueMember('gamma-not-configured') === false && membership.isMcpCatalogueMember('alpha') === true)
  t('C6 POISON armed (the process seam): a resolved latch never flips again; nothing re-opens', pin.completeProcessSessionKit({ schema: 1, mcp: ['smuggled'], skills: [], invocable: [] } as never) === false && membership.isMcpCatalogueMember('smuggled') === false)
  pin._resetSessionKitPinForTesting()
  t('C7 an un-kitted process has nothing to complete (the flip refuses; the latch stays none)', pin.completeProcessSessionKit(R) === false && pin.sessionKitOf() === undefined)
  pin._resetSessionKitPinForTesting()
  process.env.MERCURY_SESSION_KIT = JSON.stringify(UNRESOLVED)
  pin.consumeSessionKitPin()
  t('C8 a composer bug cannot latch what the wire would refuse: a still-unresolved or malformed flip refuses typed', pin.completeProcessSessionKit(UNRESOLVED as never) === false && pin.completeProcessSessionKit({ schema: 1, mcp: ['bad name!'], skills: [], invocable: [] } as never) === false && pin.sessionKitOf()?.resolved === false)
  pin._resetSessionKitPinForTesting()

  // The daemon pen, pure.
  const { resolveSessionKitOnRecord } = await import('../../src/daemon/sessionKit.ts')
  const recUnresolved = { kit: JSON.parse(JSON.stringify(UNRESOLVED)) } as never as { kit?: typeof R }
  t('C9 the pen completes an UNRESOLVED record once (a deep copy, never an alias)', resolveSessionKitOnRecord(recUnresolved as never, R) === true && deepEq(recUnresolved.kit, R) && recUnresolved.kit !== R)
  const before = JSON.stringify(recUnresolved.kit)
  t('C10 POISON armed (the second road): a resolved record NEVER moves again on this seam — a later answer is a no-op', resolveSessionKitOnRecord(recUnresolved as never, { schema: 1, mcp: ['smuggled'], skills: [], invocable: [] } as never) === false && JSON.stringify(recUnresolved.kit) === before)
  const recPrekit = {} as { kit?: typeof R }
  const recResolved = { kit: { schema: 1, mcp: ['x'], skills: [], invocable: [] } } as never as { kit?: typeof R }
  t('C11 a pre-kit record is never stamped from a facts answer; an answer still unresolved stamps nothing', resolveSessionKitOnRecord(recPrekit as never, R) === false && recPrekit.kit === undefined && resolveSessionKitOnRecord(recResolved as never, UNRESOLVED as never) === false && deepEq(recResolved.kit?.mcp, ['x']))

  // The REAL daemon seam: onSeatLine over a durable record in the scratch
  // daemon dir — the facts answer completes the record on disk, once.
  const seat = await import('../../src/daemon/sessionSeat.ts')
  const { readSessionWorkers, updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
  const DAEMON_DIR = process.env.MERCURY_DAEMON_DIR
  const SID = '22222222-3333-4444-8555-666666666666'
  updateConcourseWorkers(workers => {
    workers['w-kit'] = {
      schema: 1,
      runnerId: 'w-kit',
      sessionId: SID,
      workspaceId: PROJECT,
      isolation: 'shared',
      modelKey: 'test-model',
      effort: 'high',
      spawnedAt: Date.now(),
      lastLiveAt: Date.now(),
      kit: JSON.parse(JSON.stringify(UNRESOLVED)),
    } as never
  }, DAEMON_DIR)
  const fakeRoster = { control: () => true, list: () => [], patchSeatModel: () => true, patchSeatEffort: () => true }
  const answerOf = (kit: unknown): string =>
    JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'mercury-session-facts-w-kit-1',
        response: {
          model: { effective: 'test-model', setting: null },
          usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
          identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
          skills: [],
          mcp: [],
          permissionMode: 'flow',
          workspace: { cwd: PROJECT, originalCwd: PROJECT, projectRoot: PROJECT, instructionRoots: [] },
          queue: [],
          ...(kit !== undefined ? { kit } : {}),
        },
      },
    })
  seat.onSeatLine('w-kit', answerOf(R), fakeRoster as never, DAEMON_DIR)
  const stamped = readSessionWorkers(DAEMON_DIR)['w-kit'] as { kit?: typeof R } | undefined
  t('C12 THE REAL SEAM: the child\'s session_facts answer completes the durable record — unresolved in, RESOLVED out, through the one pen', deepEq(stamped?.kit, R))
  seat.onSeatLine('w-kit', answerOf({ schema: 1, mcp: ['smuggled'], skills: [], invocable: [] }), fakeRoster as never, DAEMON_DIR)
  const after = readSessionWorkers(DAEMON_DIR)['w-kit'] as { kit?: typeof R } | undefined
  t('C13 POISON armed at the real seam: a later answer never re-stamps a resolved record (once means once)', deepEq(after?.kit, R))
  const callers = (await import('node:child_process')).spawnSync('grep', ['-rln', 'resolveSessionKitOnRecord(', join(REPO, 'src')], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort()
  t('C14 the ONLY road census: the pen is defined in sessionKit.ts and called from sessionSeat.ts alone', deepEq(callers.map(p => p.slice(REPO.length + 1)), ['src/daemon/sessionKit.ts', 'src/daemon/sessionSeat.ts']), callers.join(','))
}

// ── §E the two extension stores AND (install switches ∧ the kit's masters) ──
section('§E the extension AND: off in EITHER store contributes NOTHING, every kind')
{
  const pin = await import('../../src/services/mcp/sessionKitPin.ts')
  const active = await import('../../src/extensions/active.ts')
  const extOf = (name: string, switches: Record<string, boolean>): unknown => ({
    entry: { id: `test:${name}` },
    manifest: { name },
    root: `/x/${name}`,
    health: { outcome: 'ok' },
    resolution: { skills: [], commands: [], servers: [], hooks: [], agents: [], channels: [], keybindings: [], language: [] },
    switches: { skills: true, servers: true, commands: true, hooks: true, agents: true, channels: true, keybindings: true, language: true, ...switches },
    options: {},
  })
  const seed = (...exts: unknown[]): void => {
    active.publishActiveSet({ roster: { entries: [] }, healthById: new Map(), active: exts, computedAt: Date.now() } as never)
  }
  const names = (kind: string): string[] => active.activeFor(kind as never).map(e => e.manifest.name)

  pin._resetSessionKitPinForTesting()
  seed(extOf('loud-ext', {}), extOf('half-ext', { skills: false }))
  t('E1 un-kitted: the install switches alone decide (the landed behaviour, byte-true)', deepEq(names('skills'), ['loud-ext']) && deepEq(names('servers'), ['loud-ext', 'half-ext']))

  process.env.MERCURY_SESSION_KIT = JSON.stringify({ schema: 1, mcp: [], skills: [], invocable: [], extensions: { 'loud-ext': 'off' } })
  pin.consumeSessionKitPin()
  t("E2 the kit's master OFF beats an ON install switch — no skills, no servers, no hooks, nothing (the AND's first direction)", deepEq(names('skills'), []) && deepEq(names('servers'), ['half-ext']) && deepEq(names('hooks'), ['half-ext']))
  t("E3 the AND's second direction: the install switch OFF under a kit that says nothing about the extension — still nothing (the kit never widens)", !names('skills').includes('half-ext'))
  t('E4 a kit that never NAMES an extension leaves the install switch to decide (absent = on)', names('servers').includes('half-ext'))

  pin._resetSessionKitPinForTesting()
  process.env.MERCURY_SESSION_KIT = JSON.stringify({ schema: 1, mcp: [], skills: [], invocable: [], resolved: false, deltas: { mcpOff: [], skillStates: {}, extensionsOff: ['half-ext'] } })
  pin.consumeSessionKitPin()
  t('E5 the unresolved arm reads the deltas the same way (extensionsOff bites at the switch door before any completion)', deepEq(names('skills'), ['loud-ext']) && deepEq(names('servers'), ['loud-ext']))

  const door = readFileSync(join(REPO, 'src', 'extensions', 'active.ts'), 'utf8')
  t('E6 the AND lives at the ONE switch door (activeFor) — both conjuncts on the filter line', door.includes('ext.switches[kind] && processKitExtensionOn(ext.manifest.name)'))
  active.publishActiveSet(null)
  pin._resetSessionKitPinForTesting()
  delete process.env.MERCURY_SESSION_KIT
}

// ── §I the inline side door: every house gate, and never the parent's handle ─
section('§I the inline agent-def door (poison: the byte-identical cache-hit teardown — Q2(b))')
{
  const { connectAgentMcpServers } = await import('../../src/tools/AgentTool/runAgent.ts')
  const { connectToServer, getServerCacheKey } = await import('../../src/services/mcp/client.ts')
  const memo = (connectToServer as unknown as { cache: Map<string, unknown> }).cache
  const definition = { agentType: 'prover-agent', source: 'built-in' } as never

  const parentCfg = { type: 'stdio', command: 'definitely-not-a-command-kit-prover', scope: 'local' } as never
  const disabledCfg = { type: 'stdio', command: 'blocked-cmd', scope: 'local' } as never
  const catalogue = [
    { name: 'shared-server', type: 'connected', config: parentCfg },
    { name: 'off-server', type: 'disabled', config: disabledCfg },
  ] as never[]

  // Refusal arms: no dial, no memo touch (lodash's MapCache has no .size —
  // the has() checks below name the exact keys a dial would have latched).
  let outcome = await connectAgentMcpServers([{ 'sdk-inline': { type: 'sdk', name: 'x' } }] as never, definition, catalogue as never)
  t('I1 an sdk-typed INLINE spec refuses typed (parity with the sdk name-ref) and never dials', outcome.clients.length === 0 && !memo.has(getServerCacheKey('sdk-inline', { type: 'sdk', name: 'x', scope: 'dynamic' } as never)))
  outcome = await connectAgentMcpServers([{ 'off-server': { type: 'stdio', command: 'smuggle' } }] as never, definition, catalogue as never)
  t("I2 POISON armed (parent-∩-grant at the inline door): an inline RE-SPELLING of a kit/record-excluded name refuses — an agent definition cannot re-enable what the session excluded", outcome.clients.length === 0 && !memo.has(getServerCacheKey('off-server', { type: 'stdio', command: 'smuggle', scope: 'dynamic' } as never)))

  // THE NO-PARENT-TEARDOWN LAW: pre-seed the memo under EXACTLY the parent
  // row's key; a byte-identical inline config must MISS it (the nonce keys
  // it apart), fail its own dial fast (bogus command — nothing real ever
  // spawns), and leave the parent's entry standing; the grant's cleanup
  // must not reach the parent's client. (The OLD code cache-HIT here and
  // tore the parent's live connection down at agent finish.)
  let parentTornDown = false
  const fakeParent = {
    type: 'connected',
    name: 'shared-server',
    client: {},
    capabilities: {},
    config: parentCfg,
    cleanup: async () => {
      parentTornDown = true
    },
  }
  const parentKey = getServerCacheKey('shared-server', parentCfg)
  memo.set(parentKey, Promise.resolve(fakeParent))
  outcome = await connectAgentMcpServers([{ 'shared-server': { type: 'stdio', command: 'definitely-not-a-command-kit-prover' } }] as never, definition, catalogue as never)
  const handedParent = outcome.clients.some(c => c === (fakeParent as never))
  await outcome.cleanup()
  t("I3 POISON armed (Q2(b), closed): a byte-identical inline config NEVER receives the parent's handle — the per-dispatch nonce keys it apart and its own dial fails on the bogus command", !handedParent, outcome.clients.map(c => (c as { type?: string }).type).join(','))
  t("I4 the parent's memo entry survives the inline dial AND the grant's cleanup — the parent's connection is never torn down", memo.has(parentKey) && parentTornDown === false)
  memo.delete(parentKey)

  // Depth-2 ∩: the dispatch-context rows (options.mcpClients) outrank the
  // appState rows — the FIRST spelling of a name wins the catalogue.
  const depth1InlineCfg = { type: 'stdio', command: 'depth1-cmd', scope: 'dynamic', inlineDispatchId: 'nonce-depth1' } as never
  const appStateCfg = { type: 'stdio', command: 'appstate-cmd', scope: 'local' } as never
  const depth2Catalogue = [
    { name: 'twin', type: 'connected', config: depth1InlineCfg },
    { name: 'twin', type: 'connected', config: appStateCfg },
  ] as never[]
  const depth1Key = getServerCacheKey('twin', depth1InlineCfg)
  const fakeDepth1 = { type: 'connected', name: 'twin', client: {}, capabilities: {}, config: depth1InlineCfg, cleanup: async () => {} }
  memo.set(depth1Key, Promise.resolve(fakeDepth1))
  outcome = await connectAgentMcpServers(['twin'] as never, definition, depth2Catalogue as never)
  t("I5 depth-2 ∩: a name-ref resolves the OPTIONS row first (the depth-1 agent's own grant), cache-hits ITS connection, and never dials the appState twin", outcome.clients.length === 1 && outcome.clients[0] === (fakeDepth1 as never) && !memo.has(getServerCacheKey('twin', appStateCfg)))
  memo.delete(depth1Key)

  const agentSrc = readFileSync(join(REPO, 'src', 'tools', 'AgentTool', 'runAgent.ts'), 'utf8')
  t('I6 the gates stand in source, in order (sdk → managed policy → enterprise exclusivity → the excluded-name refusal), and the nonce is minted ONCE per dispatch and spread into every inline dial', ['sdk-typed servers connect only', 'blocked by managed policy', 'an enterprise MCP configuration exists', "the session's catalogue excludes this name"].every(n => agentSrc.includes(n)) && agentSrc.includes('const dispatchNonce = randomUUID()') && agentSrc.includes('inlineDispatchId: dispatchNonce'))
}

// ── §N the non-session insulation (the lead-named pin, supplement) ──────────
// ONE LAW, both halves: "a kit narrows only the session it was stamped on;
// the manager's tools and every non-session process are untouchable by
// construction" — the ORGAN half is §S5/S6 (the coordination server and the
// ide bridge mount under any kit INSIDE a session); THIS half insulates
// everything that is not a kit-bearing session: only buildConcourseWorkerSpec
// ever stamps the env, non-session specs strip a stray, the daemon process
// never consumes a pin, and an absent kit is byte-identical to today
// (§S1 · T9 · E1 are that law's positive pins).
section('§N non-session insulation (poison: a kit env appearing on a warm/crew/utility spec)')
{
  const { buildConcourseWorkerSpec } = await import('../../src/daemon/concourseSupervisor.ts')
  const { buildStreamJsonInvocation } = await import('../../src/daemon/headlessRun.ts')
  const { buildCrewSpec } = await import('../../src/daemon/crewSpawn.ts')
  const base = { runnerId: 'w-ins', sessionId: '33333333-4444-4555-8666-777777777777', workspaceId: PROJECT, modelKey: 'test-model' }

  // A STRAY spelling in the SPAWNING process's env (an operator export, a
  // pre-scrub inheritance) — the strip must beat it on every road.
  process.env.MERCURY_SESSION_KIT = JSON.stringify({ schema: 1, mcp: ['stray'], skills: [], invocable: [] })
  const workerEnv = buildStreamJsonInvocation(buildConcourseWorkerSpec({ ...base, kit: K_RESOLVED as never })).env
  t("N1 a SESSION worker's child env carries ITS SPEC's stamp — never the spawning process's stray (the strip runs before the overlay; the deliberate stamp lands)", workerEnv.MERCURY_SESSION_KIT === JSON.stringify(K_RESOLVED))
  // AMENDED (the brief's own headline flips this arm's premise):
  // a warm runner now BOOTS WEARING the ensure's kit, so the law here is no
  // longer "no spelling" but the same one N1 pins for sessions — only the
  // SPEC's deliberate stamp ever lands, never the spawning process's stray.
  const warmEnv = buildStreamJsonInvocation(buildConcourseWorkerSpec({ runnerId: 'w-ins-warm', workspaceId: PROJECT, modelKey: 'test-model', warm: true, kit: K_RESOLVED as never })).env
  t("N2 POISON armed: a WARM child env carries ITS SPEC's kit and never the stray beside it (the ensure's stamp is the only speaker; a spec-less warm build still stamps nothing — K10)", warmEnv.MERCURY_SESSION_KIT === JSON.stringify(K_RESOLVED))
  const crewEnv = buildStreamJsonInvocation(buildCrewSpec('helper', 'fable', PROJECT)).env
  t('N3 POISON armed: a CREW teammate (a non-session child) never inherits a kit spelling — the kit narrows only the session it was stamped on', !('MERCURY_SESSION_KIT' in crewEnv))
  delete process.env.MERCURY_SESSION_KIT

  const { spawnSync } = await import('node:child_process')
  const consumers = spawnSync('grep', ['-rln', 'consumeSessionKitPin(', join(REPO, 'src')], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(p => p.slice(REPO.length + 1)).sort()
  t('N4 the pin has exactly TWO speakers and no daemon road: sessionKitPin.ts (the owner) and main.tsx (the one consumption) — the daemon/coordinator kernel can never latch a kit', deepEq(consumers, ['src/main.tsx', 'src/services/mcp/sessionKitPin.ts']), consumers.join(','))
  const supSrc = readFileSync(join(REPO, 'src', 'daemon', 'concourseSupervisor.ts'), 'utf8')
  const crewSrc = readFileSync(join(REPO, 'src', 'daemon', 'crewSpawn.ts'), 'utf8')
  t("N5 the insulation is structural in source: the worker strip list and the crew spec's stripEnv both name the spelling (both cite the one-law sentence beside the §S5 organ half)", supSrc.includes("'MERCURY_SESSION_KIT',") && crewSrc.includes("stripEnv: flagSpellings('MERCURY_SESSION_KIT')") && supSrc.includes('NON-SESSION INSULATION') && crewSrc.includes('NON-SESSION INSULATION'))
}

// ── §KR the refused pin's receipt row (ruling 2's second half, supplement) ──
section('§KR a refused pin lands on the session receipt too — once, the same typed sentence')
{
  const pin = await import('../../src/services/mcp/sessionKitPin.ts')
  const { readSessionReceipts } = await import('../../src/services/switchboard/sessionReceipts.ts')
  const { mkdtempSync } = await import('node:fs')
  const HOME = mkdtempSync(join(SCRATCH, 'receipt-home-'))
  const SID = '44444444-5555-4666-8777-888888888888'

  pin._resetSessionKitPinForTesting()
  process.env.MERCURY_SESSION_KIT = JSON.stringify(K_RESOLVED)
  pin.consumeSessionKitPin()
  t('KR1 a LAWFUL pin writes no refusal row (the row is the refusal arm alone)', pin.noteRefusedKitOnSessionReceipt(HOME, SID) === false && readSessionReceipts(HOME, SID).length === 0)

  pin._resetSessionKitPinForTesting()
  process.env.MERCURY_SESSION_KIT = '{not json'
  pin.consumeSessionKitPin()
  const wrote = pin.noteRefusedKitOnSessionReceipt(HOME, SID)
  const rows = readSessionReceipts(HOME, SID)
  t("KR2 the REFUSED pin's row is durable beside the transcript: kind 'kit-refused', the SAME typed sentence stderr carried, the reason in details", wrote && rows.length === 1 && rows[0]?.kind === 'kit-refused' && rows[0]?.summary === 'kit refused — the pin is not JSON; this session loads no extensions' && (rows[0]?.details as { reason?: string } | undefined)?.reason === 'the pin is not JSON')
  t('KR3 once means once: a second note writes nothing (one boot, one row)', pin.noteRefusedKitOnSessionReceipt(HOME, SID) === false && readSessionReceipts(HOME, SID).length === 1)
  pin._resetSessionKitPinForTesting()
  delete process.env.MERCURY_SESSION_KIT

  const mirror = readFileSync(join(REPO, 'src', 'components', 'concourse', 'SessionMirror.tsx'), 'utf8')
  const mainSrc = readFileSync(join(REPO, 'src', 'main.tsx'), 'utf8')
  t("KR4 the viewer names the row in the kit family and the shared prep wires the note at the identity point", mirror.includes("e.kind === 'kit-restamp' || e.kind === 'kit-refused'") && mainSrc.includes('noteRefusedKitOnSessionReceipt(receiptHome, getSessionId())'))
}

console.log(`\n${failures === 0 ? '✅ KIT-RUNNER PINS GREEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
