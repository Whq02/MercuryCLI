import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const whereToLook = (name: string): string => {
  if (name.startsWith('KR')) return 'src/integrations/mcp/sessionKitPin.ts (noteRefusedKitOnSessionReceipt)'
  if (/^K(8|9|10)$/.test(name)) return 'src/daemon/concourse-workers/concourseWorkers.ts (buildConcourseWorkerSpec)'
  if (name === 'K11') return 'src/daemon/session-seat/sessionKit.ts (validateSessionKit)'
  if (name === 'K17') return 'the flag registry (FLAG_REGISTRY) (the MERCURY_SESSION_KIT row)'
  if (name.startsWith('K')) return 'src/integrations/mcp/sessionKitPin.ts (consumeSessionKitPin, sessionKitOf)'
  if (/^S/.test(name)) return 'src/integrations/mcp/membership.ts (isMcpCatalogueMember, isMcpOrgan, partitionMcpConfigsByMembership)'
  if (/^C(9|10|11)$/.test(name)) return 'src/daemon/session-seat/sessionKit.ts (resolveSessionKitOnRecord)'
  if (/^C1[23]$/.test(name)) return 'src/daemon/session-seat/sessionSeat.ts (onFactsAnswer)'
  if (/^C[5-8]$/.test(name)) return 'src/integrations/mcp/sessionKitPin.ts (completeProcessSessionKit) and src/integrations/mcp/membership.ts'
  if (name.startsWith('C')) return 'src/integrations/mcp/kitCompletion.ts (completeSessionKitFromRoster)'
  if (name.startsWith('E')) return 'src/integrations/extensions/active.ts (activeFor) and src/integrations/mcp/sessionKitPin.ts'
  if (name.startsWith('I')) return 'src/tools/crewmate/runCrewmate.ts (connectAgentMcpServers)'
  if (name.startsWith('N')) return 'src/daemon/runner-link/headlessRun.ts (buildRunnerInvocation) and src/daemon/concourse-workers/concourseWorkers.ts (buildConcourseWorkerSpec)'
  return 'src/integrations/mcp/sessionKitPin.ts'
}
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok ? ` — ${detail ? `${detail} — ` : ''}change the code, not the check: ${whereToLook(name)}` : ''}`)
  if (!ok) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const deepEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — kit-runner prover exceeded 120s: an awaited call never returned; run the file alone and see which section printed last, then look in the module that section names (src/tools/crewmate/runCrewmate.ts connectAgentMcpServers for §I, src/daemon/session-seat/sessionSeat.ts onFactsAnswer for §C)')
  process.exit(1)
}, 120_000)
watchdog.unref?.()


console.log('============================================================')
console.log(' KIT-RUNNER — sessions obey their kit')
console.log('============================================================')

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()

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

section('§K the carry (poison-first: a dropped or malformed kit must never mean whole-config)')
{
  const pin = await import('../../src/integrations/mcp/sessionKitPin.ts')

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
  const { buildConcourseWorkerSpec } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
  const base = { runnerId: 'w-kit', sessionId: '11111111-2222-4333-8444-555555555555', workspaceId: PROJECT, modelKey: 'test-model' }
  const withKit = buildConcourseWorkerSpec({ ...base, kit: K_RESOLVED as never })
  const parsed = JSON.parse((withKit.extraEnv as Record<string, string>).MERCURY_SESSION_KIT ?? 'null') as unknown
  t('K8 a kit on the spec rides extraEnv as its exact JSON (beside the home pin, respawn-carried by the spec law)', deepEq(parsed, K_RESOLVED) && typeof (withKit.extraEnv as Record<string, string>).MERCURY_SESSION_HOME === 'string')
  const noKit = buildConcourseWorkerSpec({ ...base })
  t("K9 no kit ⇒ the key is ABSENT from extraEnv (absent, never the string 'undefined' — absence IS the whole-config law)", !('MERCURY_SESSION_KIT' in (noKit.extraEnv as Record<string, string>)))
  const warm = buildConcourseWorkerSpec({ runnerId: 'w-warm', workspaceId: PROJECT, modelKey: 'test-model', warm: true })
  t('K10 the builder stamps NO kit env on a kit-less spec, warm included (absence is the law; the warm ensure hands its own kit — prove-kit-birth §G)', !('MERCURY_SESSION_KIT' in (warm.extraEnv as Record<string, string>)))
  const round = await import('../../src/daemon/session-seat/sessionKit.ts')
  const validated = round.validateSessionKit(parsed)
  t("K11 the carried JSON round-trips the wire's own narrowing (the runner re-validates the daemon's bytes)", validated.ok && deepEq(validated.ok ? validated.kit : null, K_RESOLVED))
}

section('§K3 call-site census (source-shape: every non-warm road passes the kit; one env owner)')
{
  const { FLAG_REGISTRY } = await import('../../src/platform/substrate/flagRegistry.ts')
  const row = (FLAG_REGISTRY as ReadonlyArray<{ env: string; kind: string }>).find(r => r.env === 'MERCURY_SESSION_KIT')
  t("K17 the flagRegistry row exists, kind 'value' (prove-flag-registry enforces the read pattern mechanically)", row !== undefined && row.kind === 'value')
}

section('§S the swap: every membership road answers the process kit through the one owner')
{
  const pin = await import('../../src/integrations/mcp/sessionKitPin.ts')
  const membership = await import('../../src/integrations/mcp/membership.ts')
  const { setMcpServerEnabled } = await import('../../src/integrations/mcp/serverConfigs.ts')
  const latch = (kit: unknown): void => {
    pin._resetSessionKitPinForTesting()
    process.env.MERCURY_SESSION_KIT = JSON.stringify(kit)
    pin.consumeSessionKitPin()
  }

  setMcpServerEnabled('srv-off', false)
  pin._resetSessionKitPinForTesting()
  t("S1 no latch ⇒ today's record predicate, byte-true (the screen, a plain boot, a warm runner)", membership.isMcpCatalogueMember('alpha') === true && membership.isMcpCatalogueMember('srv-off') === false)

  latch({ schema: 1, mcp: ['alpha', 'srv-off'], skills: [], invocable: [] })
  t("S2 POISON armed (the live-session law, driven through the OWNER): the kit lists 'srv-off' — the record's disable is NEVER consulted for a kitted process", membership.isMcpCatalogueMember('srv-off') === true && membership.isMcpCatalogueMember('alpha') === true)
  t("S3 POISON armed (the other direction): 'beta' is ON in the record but OUTSIDE the resolved kit ⇒ not a member (resolved lists ARE the membership)", membership.isMcpCatalogueMember('beta') === false)

  latch({ schema: 1, mcp: [], skills: [], invocable: [] })
  t('S4 the EMPTY resolved kit admits NOTHING configured (empty ≠ absent — L24(1) "absent from that session\'s process")', membership.isMcpCatalogueMember('alpha') === false && membership.isMcpCatalogueMember('beta') === false)
  t("S5 ORGANS OUTSIDE (Q1): the EMPTY kit still mounts the enabled in-process server ('mercury')", membership.isMcpCatalogueMember('mercury') === true && membership.isMcpOrgan('mercury'))
  process.env.MERCURY_COORDINATION_MCP = '0'
  t("S6 with the in-process server OFF, 'mercury' is an ordinary name — the kit governs it (no organ hole for a user server that borrowed the name)", membership.isMcpCatalogueMember('mercury') === false && !membership.isMcpOrgan('mercury'))
  delete process.env.MERCURY_COORDINATION_MCP

  latch({ schema: 1, mcp: ['ghost-list'], skills: [], invocable: [], resolved: false, deltas: { mcpOff: ['beta'], skillStates: {}, extensionsOff: [] } })
  t("S7 an UNRESOLVED latch is deltas-only at the owner: 'beta' (delta-off) out; 'alpha' in; 'srv-off' in (the record ignored); its provisional list is NEVER membership ('ghost-list' grants nothing beyond delta absence)", membership.isMcpCatalogueMember('beta') === false && membership.isMcpCatalogueMember('alpha') === true && membership.isMcpCatalogueMember('srv-off') === true)

  latch({ schema: 1, mcp: ['alpha'], skills: [], invocable: [] })
  const split = membership.partitionMcpConfigsByMembership({
    alpha: { type: 'stdio', command: 'a', scope: 'local' } as never,
    beta: { type: 'stdio', command: 'b', scope: 'local' } as never,
  })
  t("S8 the runner batch partition follows the owner (excluded entries become truthful 'disabled' rows and are never dialed — the landed semantics under the kit)", split.members.length === 1 && split.members[0]?.[0] === 'alpha' && split.excluded.length === 1 && split.excluded[0]?.[0] === 'beta')

  pin._resetSessionKitPinForTesting()
  delete process.env.MERCURY_SESSION_KIT
}

section('§C the completion (poison: a second road to resolved; a resolved record overwritten)')
{
  const pin = await import('../../src/integrations/mcp/sessionKitPin.ts')
  const g = await import('../../src/integrations/skills/kitGovernance.ts')
  const { completeSessionKitFromRoster } = await import('../../src/integrations/mcp/kitCompletion.ts')
  const membership = await import('../../src/integrations/mcp/membership.ts')

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
    'C1 the composer applies the DELTAS to the runner\'s own roster: delta-off and off-master servers out, wire-illegal spellings out; the provisional list grants NOTHING',
    deepEq(R.mcp, ['alpha', 'ext:loud-ext:tool']) && !R.mcp.includes('ghost') && !R.mcp.includes('mercury'),
    JSON.stringify(R.mcp),
  )
  t("C2 the skills halves follow the overlay's own product (kit-on unmarked; kit-invocable marked; an off-master extension skill contributes nothing; builtins never)", deepEq(R.skills, ['s:on']) && deepEq(R.invocable, ['s:inv']))
  t("C3 the masters land on the snapshot ('off' survives even for a master the active set still lists)", deepEq(R.extensions, { 'quiet-ext': 'off', 'loud-ext': 'on' }))
  const revalidated = (await import('../../src/daemon/session-seat/sessionKit.ts')).validateSessionKit(R)
  t('C4 the composed kit is RESOLVED and wire-legal (the daemon will stamp these exact bytes)', revalidated.ok && R.resolved === undefined)

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

  const { resolveSessionKitOnRecord } = await import('../../src/daemon/session-seat/sessionKit.ts')
  const recUnresolved = { kit: JSON.parse(JSON.stringify(UNRESOLVED)) } as never as { kit?: typeof R }
  t('C9 the pen completes an UNRESOLVED record once (a deep copy, never an alias)', resolveSessionKitOnRecord(recUnresolved as never, R) === true && deepEq(recUnresolved.kit, R) && recUnresolved.kit !== R)
  const before = JSON.stringify(recUnresolved.kit)
  t('C10 POISON armed (the second road): a resolved record NEVER moves again on this seam — a later answer is a no-op', resolveSessionKitOnRecord(recUnresolved as never, { schema: 1, mcp: ['smuggled'], skills: [], invocable: [] } as never) === false && JSON.stringify(recUnresolved.kit) === before)
  const recPrekit = {} as { kit?: typeof R }
  const recResolved = { kit: { schema: 1, mcp: ['x'], skills: [], invocable: [] } } as never as { kit?: typeof R }
  t('C11 a pre-kit record is never stamped from a facts answer; an answer still unresolved stamps nothing', resolveSessionKitOnRecord(recPrekit as never, R) === false && recPrekit.kit === undefined && resolveSessionKitOnRecord(recResolved as never, UNRESOLVED as never) === false && deepEq(recResolved.kit?.mcp, ['x']))

  const seat = await import('../../src/daemon/session-seat/sessionSeat.ts')
  const { readSessionWorkers, updateConcourseWorkers } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
  const { sessionKitToWire } = await import('../../src/engine/connector/seatWire.ts')
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
  const fakeRoster = { door: () => undefined, list: () => [], patchSeatModel: () => true, patchSeatEffort: () => true }
  const answerOf = (kit: unknown): Record<string, unknown> => ({
    model: { effective: 'test-model', setting: null },
    usage: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, total_input_tokens: 0, total_output_tokens: 0, total_cache_read_input_tokens: 0, total_cache_creation_input_tokens: 0, has_unknown_model_cost: false },
    identity: { first_party_api: false, console_billing: false, claude_ai_billing: false, account_email: null },
    skills: [],
    mcp: [],
    permission_mode: 'flow',
    workspace: { cwd: PROJECT, original_cwd: PROJECT, project_root: PROJECT, instruction_roots: [] },
    queue: [],
    ...(kit !== undefined ? { kit: sessionKitToWire(kit as never) } : {}),
  })
  seat.onFactsAnswer('w-kit', answerOf(R), fakeRoster as never, DAEMON_DIR)
  const stamped = readSessionWorkers(DAEMON_DIR)['w-kit'] as { kit?: typeof R } | undefined
  t('C12 THE REAL SEAM: the child\'s session/facts answer completes the durable record — unresolved in, RESOLVED out, through the one pen', deepEq(stamped?.kit, R))
  seat.onFactsAnswer('w-kit', answerOf({ schema: 1, mcp: ['smuggled'], skills: [], invocable: [] }), fakeRoster as never, DAEMON_DIR)
  const after = readSessionWorkers(DAEMON_DIR)['w-kit'] as { kit?: typeof R } | undefined
  t('C13 POISON armed at the real seam: a later answer never re-stamps a resolved record (once means once)', deepEq(after?.kit, R))
}

section('§E the extension AND: off in EITHER store contributes NOTHING, every kind')
{
  const pin = await import('../../src/integrations/mcp/sessionKitPin.ts')
  const active = await import('../../src/integrations/extensions/active.ts')
  const extOf = (name: string, switches: Record<string, boolean>): unknown => ({
    entry: { id: `test:${name}` },
    manifest: { name },
    root: `/x/${name}`,
    health: { outcome: 'ok' },
    resolution: { skills: [], commands: [], servers: [], hooks: [], agents: [], keybindings: [], language: [] },
    switches: { skills: true, servers: true, commands: true, hooks: true, agents: true, keybindings: true, language: true, ...switches },
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

  active.publishActiveSet(null)
  pin._resetSessionKitPinForTesting()
  delete process.env.MERCURY_SESSION_KIT
}

section('§I the inline agent-def door (poison: the byte-identical cache-hit teardown — Q2(b))')
{
  const { connectCrewmateMcpServers } = await import('../../src/tools/crewmate/runCrewmate.ts')
  const { connectToServer, getServerCacheKey } = await import('../../src/integrations/mcp/client.ts')
  const memo = (connectToServer as unknown as { cache: Map<string, unknown> }).cache
  const definition = { agentType: 'prover-agent', source: 'built-in' } as never

  const parentCfg = { type: 'stdio', command: 'definitely-not-a-command-kit-prover', scope: 'local' } as never
  const disabledCfg = { type: 'stdio', command: 'blocked-cmd', scope: 'local' } as never
  const catalogue = [
    { name: 'shared-server', type: 'connected', config: parentCfg },
    { name: 'off-server', type: 'disabled', config: disabledCfg },
  ] as never[]

  let outcome = await connectCrewmateMcpServers([{ 'sdk-inline': { type: 'host', name: 'x' } }] as never, definition, catalogue as never)
  t('I1 an INLINE spec of a kind the one validator does not accept refuses before any gate and never dials', outcome.clients.length === 0 && !memo.has(getServerCacheKey('sdk-inline', { type: 'host', name: 'x', scope: 'dynamic' } as never)))
  outcome = await connectCrewmateMcpServers([{ 'off-server': { type: 'stdio', command: 'smuggle' } }] as never, definition, catalogue as never)
  t("I2 POISON armed (parent-∩-grant at the inline door): an inline RE-SPELLING of a kit/record-excluded name refuses — an agent definition cannot re-enable what the session excluded", outcome.clients.length === 0 && !memo.has(getServerCacheKey('off-server', { type: 'stdio', command: 'smuggle', scope: 'dynamic' } as never)))

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
  outcome = await connectCrewmateMcpServers([{ 'shared-server': { type: 'stdio', command: 'definitely-not-a-command-kit-prover' } }] as never, definition, catalogue as never)
  const handedParent = outcome.clients.some(c => c === (fakeParent as never))
  await outcome.cleanup()
  t("I3 POISON armed (Q2(b), closed): a byte-identical inline config NEVER receives the parent's handle — the per-dispatch nonce keys it apart and its own dial fails on the bogus command", !handedParent, outcome.clients.map(c => (c as { type?: string }).type).join(','))
  t("I4 the parent's memo entry survives the inline dial AND the grant's cleanup — the parent's connection is never torn down", memo.has(parentKey) && parentTornDown === false)
  memo.delete(parentKey)

  const depth1InlineCfg = { type: 'stdio', command: 'depth1-cmd', scope: 'dynamic', inlineDispatchId: 'nonce-depth1' } as never
  const appStateCfg = { type: 'stdio', command: 'appstate-cmd', scope: 'local' } as never
  const depth2Catalogue = [
    { name: 'twin', type: 'connected', config: depth1InlineCfg },
    { name: 'twin', type: 'connected', config: appStateCfg },
  ] as never[]
  const depth1Key = getServerCacheKey('twin', depth1InlineCfg)
  const fakeDepth1 = { type: 'connected', name: 'twin', client: {}, capabilities: {}, config: depth1InlineCfg, cleanup: async () => {} }
  memo.set(depth1Key, Promise.resolve(fakeDepth1))
  outcome = await connectCrewmateMcpServers(['twin'] as never, definition, depth2Catalogue as never)
  t("I5 depth-2 ∩: a name-ref resolves the OPTIONS row first (the depth-1 agent's own grant), cache-hits ITS connection, and never dials the appState twin", outcome.clients.length === 1 && outcome.clients[0] === (fakeDepth1 as never) && !memo.has(getServerCacheKey('twin', appStateCfg)))
  memo.delete(depth1Key)

}

section('§N non-session insulation (poison: a kit env appearing on a warm/utility spec)')
{
  const { buildConcourseWorkerSpec } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
  const { buildRunnerInvocation } = await import('../../src/daemon/runner-link/headlessRun.ts')
  const base = { runnerId: 'w-ins', sessionId: '33333333-4444-4555-8666-777777777777', workspaceId: PROJECT, modelKey: 'test-model' }

  process.env.MERCURY_SESSION_KIT = JSON.stringify({ schema: 1, mcp: ['stray'], skills: [], invocable: [] })
  const workerEnv = buildRunnerInvocation(buildConcourseWorkerSpec({ ...base, kit: K_RESOLVED as never })).env
  t("N1 a SESSION worker's child env carries ITS SPEC's stamp — never the spawning process's stray (the strip runs before the overlay; the deliberate stamp lands)", workerEnv.MERCURY_SESSION_KIT === JSON.stringify(K_RESOLVED))
  const warmEnv = buildRunnerInvocation(buildConcourseWorkerSpec({ runnerId: 'w-ins-warm', workspaceId: PROJECT, modelKey: 'test-model', warm: true, kit: K_RESOLVED as never })).env
  t("N2 POISON armed: a WARM child env carries ITS SPEC's kit and never the stray beside it (the ensure's stamp is the only speaker; a spec-less warm build still stamps nothing — K10)", warmEnv.MERCURY_SESSION_KIT === JSON.stringify(K_RESOLVED))
  delete process.env.MERCURY_SESSION_KIT

}

section('§KR a refused pin lands on the session receipt too — once, the same typed sentence')
{
  const pin = await import('../../src/integrations/mcp/sessionKitPin.ts')
  const { readSessionReceipts } = await import('../../src/daemon/switchboard/sessionReceipts.ts')
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

}

console.log(`\n${failures === 0 ? '✅ KIT-RUNNER PINS GREEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
