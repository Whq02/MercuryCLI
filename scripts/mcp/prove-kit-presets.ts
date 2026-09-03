import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRATCH = mkdtempSync(join(tmpdir(), 'kit-presets-'))
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
  console.log('\nTIMEOUT — kit-presets prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
const wireKeys = (src: string, name: string): string => (src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const`)) ?? [])[1] ?? ''

console.log('============================================================')
console.log(' KIT-PRESETS — named kit snapshots at both doors')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getGlobalMercuryFile } = await import('../../src/utils/env.ts')
const { saveGlobalConfig } = await import('../../src/utils/config.ts')
const store = await import('../../src/services/mcp/presetStore.ts')
const { KIT_LIST_CAP } = await import('../../src/daemon/sessionKit.ts')
const kitStore = await import('../../src/services/mcp/kitStore.ts')

const configBytes = (): string => {
  try {
    return readFileSync(getGlobalMercuryFile(), 'utf8')
  } catch {
    return ''
  }
}

const D_WRITING = {
  mcpOff: ['postgres', 'ext:orchard-tools:db'],
  skillStates: { deploy: 'invocable' as const, notes: 'off' as const },
  extensionsOff: ['orchard-tools'],
}
const D_SMALL = { mcpOff: ['github'], skillStates: {}, extensionsOff: [] }
const D_EMPTY = { mcpOff: [], skillStates: {}, extensionsOff: [] }

section('§P1 — THE STORE: named KitDeltasV1 snapshots in the global config')
{
  t('P1-1 a fresh store lists nothing and the config file carries NO kitPresets field', deepEq(store.listKitPresets(), []) && !configBytes().includes('kitPresets'))
  const empty = store.kitPresetDeltas('writing')
  t("P1-2 an unknown preset on the empty store refuses typed ('unknown preset' + the none-saved words)", !empty.ok && empty.reason.startsWith("unknown preset 'writing'") && empty.reason.includes('none saved yet'), JSON.stringify(empty))
  const hook = await import('../../src/services/kitMenu/presetHook.ts')
  t('P1-3 the name grammar has ONE owner: presetHook re-exports presetStore’s presetNameProblem by identity', hook.presetNameProblem === store.presetNameProblem && hook.PRESET_NAME_PATTERN === store.PRESET_NAME_PATTERN && hook.PRESET_NAME_MAX === store.PRESET_NAME_MAX)
  const badName = store.saveKitPreset('review/kit', D_SMALL)
  t('P1-4 a save under a bad name refuses in the grammar’s own words', !badName.ok && badName.reason.includes('letters, digits, hyphens and spaces'))
  const saved = store.saveKitPreset('writing', D_WRITING)
  t("P1-5 the save lands with the counted receipt: preset 'writing' saved (5 deltas)", saved.ok && saved.receipt === "preset 'writing' saved (5 deltas)", JSON.stringify(saved))
  const back = store.kitPresetDeltas('writing')
  t('P1-6 the resolve answers the deltas byte-equal', back.ok && deepEq(back.deltas, D_WRITING))
  if (back.ok) back.deltas.mcpOff.push('poisoned')
  const again = store.kitPresetDeltas('writing')
  t('P1-7 the answer is a COPY: mutating it never reaches the store', again.ok && deepEq(again.deltas, D_WRITING))
  const before = configBytes()
  const idem = store.saveKitPreset('writing', JSON.parse(JSON.stringify(D_WRITING)) as typeof D_WRITING)
  t("P1-8 a byte-identical save writes nothing and says so ('already saved — unchanged')", idem.ok && idem.receipt.includes('already saved — unchanged') && configBytes() === before)
  const upd = store.saveKitPreset('writing', D_SMALL)
  t("P1-9 an update names itself: 'updated (was 5 deltas, now 1 delta)'", upd.ok && upd.receipt === "preset 'writing' updated (was 5 deltas, now 1 delta)", JSON.stringify(upd))
  const updBack = store.kitPresetDeltas('writing')
  t('P1-10 the update resolves to the new deltas', updBack.ok && deepEq(updBack.deltas, D_SMALL))
  const allOn = store.saveKitPreset('all-on', D_EMPTY)
  const allOnBack = store.kitPresetDeltas('all-on')
  t("P1-11 an all-on preset is lawful: saved (0 deltas) and resolves the EMPTY deltas", allOn.ok && allOn.receipt === "preset 'all-on' saved (0 deltas)" && allOnBack.ok && deepEq(allOnBack.deltas, D_EMPTY))
  t('P1-12 the roster lists both, sorted', deepEq(store.listKitPresets(), ['all-on', 'writing']))
  const delUnknown = store.deleteKitPreset('ghost')
  t("P1-13 deleting an unknown preset refuses typed naming the roster", !delUnknown.ok && delUnknown.reason.includes("unknown preset 'ghost'") && delUnknown.reason.includes("'all-on'") && delUnknown.reason.includes("'writing'"))
  const del1 = store.deleteKitPreset('writing')
  const del2 = store.deleteKitPreset('all-on')
  t('P1-14 deletes land with receipts and the LAST delete drops the field whole (absent, never {})', del1.ok && del2.ok && deepEq(store.listKitPresets(), []) && !configBytes().includes('kitPresets'))
  saveGlobalConfig(current => ({ ...current, kitPresets: { damaged: { mcpOff: 'nope' } } }) as never)
  const damagedList = store.listKitPresets()
  const damaged = store.kitPresetDeltas('damaged')
  t("P1-15 a damaged entry lists (visible) and resolves typed: 'damaged in the config (mcpOff is not an array)'", deepEq(damagedList, ['damaged']) && !damaged.ok && damaged.reason.includes("preset 'damaged' is damaged in the config") && damaged.reason.includes('mcpOff is not an array'), JSON.stringify(damaged))
  saveGlobalConfig(current => {
    const { kitPresets: _all, ...bare } = current
    void _all
    return bare as typeof current
  })
  saveGlobalConfig(current => ({
    ...current,
    kitPresets: Object.fromEntries(Array.from({ length: store.KIT_PRESET_CAP }, (_, i) => [`preset-${String(i).padStart(3, '0')}`, D_EMPTY])),
  }) as never)
  const overCap = store.saveKitPreset('one-more', D_SMALL)
  const capUpdate = store.saveKitPreset('preset-000', D_SMALL)
  t('P1-16 the cap: a new name past 200 refuses typed; updating an existing name still lands', !overCap.ok && overCap.reason.includes(`cap ${store.KIT_PRESET_CAP}`) && capUpdate.ok && capUpdate.receipt.startsWith("preset 'preset-000' updated"))
  saveGlobalConfig(current => {
    const { kitPresets: _all, ...bare } = current
    void _all
    return bare as typeof current
  })
  const oversized = store.saveKitPreset('too-big', { mcpOff: Array.from({ length: store.PRESET_LIST_CAP + 1 }, (_, i) => `s${i}`), skillStates: {}, extensionsOff: [] })
  t('P1-17 oversized deltas refuse typed at the save, and PRESET_LIST_CAP === the wire’s KIT_LIST_CAP', !oversized.ok && oversized.reason.includes(`cap ${store.PRESET_LIST_CAP}`) && store.PRESET_LIST_CAP === KIT_LIST_CAP)
}

section('§P1-ISO — the store touches NOTHING else: menu record · facts · layering')
{
  kitStore.setSkillStateForWorkspace(PROJECT, 'deploy', 'invocable')
  const menuBefore = JSON.stringify(kitStore.kitDeltasForWorkspace(PROJECT))
  const facts = await import('../../src/services/switchboard/bootBirthFacts.ts')
  facts._resetBootBirthFactsForTesting()
  store.saveKitPreset('iso', D_WRITING)
  store.saveKitPreset('iso', D_SMALL)
  store.deleteKitPreset('iso')
  t('P1-18 save/update/delete leave the MENU record untouched (the workspace’s deltas byte-identical)', JSON.stringify(kitStore.kitDeltasForWorkspace(PROJECT)) === menuBefore)
  t('P1-19 store pens never arm the next-session facts (kit stays null; nothing else set)', facts.bootBirthFacts().kit === null && facts.bootBirthFacts().title === null)
  kitStore.setSkillStateForWorkspace(PROJECT, 'deploy', 'on')
  const src = read('src/services/mcp/presetStore.ts')
  t('P1-20 the store imports nothing from the daemon (the derivation imports the store, never the reverse)', !src.includes("from '../../daemon"))
  const { readdirSync } = await import('node:fs')
  const writers = (readdirSync(join(REPO, 'src'), { recursive: true }) as string[])
    .filter(f => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.includes('node_modules'))
    .map(f => join('src', f))
    .filter(f => read(f).includes('kitPresets'))
    .sort()
  t('P1-21 the one-writer census: kitPresets appears in src/ only at the schema and the store', deepEq(writers, ['src/services/mcp/presetStore.ts', 'src/utils/config/schema.ts']), writers.join(','))
  const laneNew = ['src/services/mcp/presetStore.ts']
  const packHits = laneNew.filter(f => /\bpacks?\b/i.test(read(f).replace(/"pack" is reserved for extensions|"pack" is the extensions estate's word|"pack" is RESERVED for extensions/g, '')))
  t("P1-22 the vocabulary law: no 'pack' in the kit sources", packHits.length === 0, packHits.join(','))
}

section('§P2 — THE MENU DOOR: the default hook IS the store (the typed-refusal placeholder is dead)')
{
  const hook = await import('../../src/services/kitMenu/presetHook.ts')
  hook._resetKitPresetHookForTesting()
  t('P2-1 the default binding is the store door itself (reset lands on STORE_PRESET_HOOK, never a refusal placeholder)', hook.kitPresetHook() === hook.STORE_PRESET_HOOK)
  const snapshot = {
    workspaceDir: PROJECT,
    deltas: { mcpOff: ['postgres'], skillStates: { deploy: 'invocable' as const }, extensionsOff: [] },
    members: { mcp: ['THIS-IS-NOT-A-DELTA'], skills: ['NOR-THIS'], extensions: [] },
  }
  const saved = hook.kitPresetHook().save('door', snapshot)
  const back = store.kitPresetDeltas('door')
  t("P2-2 a save through the hook lands the DELTAS in the store with the counted receipt", saved.ok && saved.receipt === "preset 'door' saved (2 deltas)" && back.ok && deepEq(back.deltas, snapshot.deltas), JSON.stringify(saved))
  t('P2-3 the members roster never leaks into the stored preset (deltas-only, the ruled shape)', back.ok && !JSON.stringify(back.deltas).includes('THIS-IS-NOT-A-DELTA'))
  const badName = hook.kitPresetHook().save('a/b', snapshot)
  t('P2-4 the store’s refusals reach the prompt through the hook (bad name → the grammar’s words)', !badName.ok && badName.reason.includes('letters, digits, hyphens and spaces'))
  let recorded = 0
  hook.bindKitPresetHook({ save: () => { recorded++; return { ok: true, receipt: 'recorded' } } })
  const rec = hook.kitPresetHook().save('door', snapshot)
  hook._resetKitPresetHookForTesting()
  t('P2-5 bindKitPresetHook still intercepts for proofs and reset restores the store door', rec.ok && rec.receipt === 'recorded' && recorded === 1 && hook.kitPresetHook() === hook.STORE_PRESET_HOOK)
  store.deleteKitPreset('door')
  const hookSrc = read('src/services/kitMenu/presetHook.ts')
  t('P2-6 the typed-refusal placeholder is dead in the source (no UNWIRED hook, no not-wired sentence)', !hookSrc.includes('UNWIRED_PRESET_HOOK') && !hookSrc.includes('not wired in this build'))
}

section('§P3 — THE ONE-SHOT WEAR: armed for exactly one session; the menu default resumes; a live hop never consumes')
{
  const facts = await import('../../src/services/switchboard/bootBirthFacts.ts')
  const wearMod = await import('../../src/services/kitMenu/presetWear.ts')
  const KIT_MENU = { schema: 1 as const, mcp: ['github', 'postgres'], skills: ['deploy'], invocable: [] }
  const KIT_WORN = { schema: 1 as const, mcp: ['github'], skills: [], invocable: [] }
  facts._resetBootBirthFactsForTesting()
  facts.setNextSessionFacts({ kit: KIT_MENU })
  facts.setNextSessionFacts({ presetKit: { name: 'writing', kit: KIT_WORN } })
  t('P3-1 peek reads the armed wear without spending it (two peeks, one answer)', facts.peekWornPresetKit()?.name === 'writing' && facts.peekWornPresetKit()?.name === 'writing')
  t('P3-2 the sticky menu carry stands UNTOUCHED beside the armed wear', deepEq(facts.bootBirthFacts().kit, KIT_MENU))
  const taken = facts.takeWornPresetKit()
  t('P3-3 take spends the wear ONCE (at-most-once: the second take answers null)', taken?.name === 'writing' && deepEq(taken?.kit, KIT_WORN) && facts.takeWornPresetKit() === null && facts.peekWornPresetKit() === null)
  t('P3-4 after the spend the menu default RESUMES: carriedKitOf answers the sticky kit exactly', deepEq(facts.carriedKitOf(facts.bootBirthFacts()), { kit: KIT_MENU }))
  facts.setNextSessionFacts({ presetKit: { name: 'writing', kit: KIT_WORN } })
  facts.takeBootTitle()
  t('P3-5 the one-shot title and the one-shot wear are SEPARATE spends (taking the title leaves the wear armed)', facts.peekWornPresetKit()?.name === 'writing')
  const disarmed = wearMod.disarmWornPreset()
  t("P3-6 disarm is one gesture and says so; disarming nothing answers honestly", disarmed.ok && disarmed.receipt === "preset 'writing' disarmed — the menu's default stands" && !wearMod.disarmWornPreset().ok)
  facts._resetBootBirthFactsForTesting()

  const kitTypes = await import('../../src/services/kitMenu/kitTypes.ts')
  const rows: import('../../src/services/kitMenu/kitTypes.ts').KitRow[] = [
    { kind: 'mcp', section: 'mcp', name: 'github', scope: 'user', extension: null },
    { kind: 'mcp', section: 'mcp', name: 'postgres', scope: 'user', extension: null },
    { kind: 'extension', section: 'mcp', name: 'orchard-tools', contributes: '1 server' },
    { kind: 'mcp', section: 'mcp', name: 'ext:orchard-tools:db', scope: 'dynamic', extension: 'orchard-tools' },
    { kind: 'skill', section: 'skill', name: 'deploy', source: 'project settings', extension: null },
    { kind: 'skill', section: 'skill', name: 'review', source: 'project settings', extension: null },
  ]
  void kitTypes
  const biting = wearMod.resolvePresetWear(rows, { mcpOff: ['postgres'], skillStates: { deploy: 'invocable' }, extensionsOff: [] })
  t('P3-7 a biting delta shapes the worn kit (postgres off; deploy invocable) with nothing unmatched', biting.ok && deepEq(biting.kit, { schema: 1, mcp: ['github', 'ext:orchard-tools:db'], skills: ['review'], invocable: ['deploy'], extensions: { 'orchard-tools': 'on' } }) && biting.unmatched.length === 0, JSON.stringify(biting))
  const foreign = wearMod.resolvePresetWear(rows, { mcpOff: ['postgres', 'no-such-server'], skillStates: { 'ghost-skill': 'off' }, extensionsOff: ['no-such-ext'] })
  const plainOff = wearMod.resolvePresetWear(rows, { mcpOff: ['postgres'], skillStates: {}, extensionsOff: [] })
  t("P3-8 foreign OFF deltas are kept off by name; foreign MCP names don't bite; membership lists stay identical; all NAMED", foreign.ok && plainOff.ok && deepEq(foreign.kit.mcp, plainOff.kit.mcp) && deepEq(foreign.kit.skills, plainOff.kit.skills) && deepEq(foreign.kit.invocable, plainOff.kit.invocable) && deepEq(foreign.kit.skillsOff, ['ghost-skill']) && foreign.kit.extensions?.['no-such-ext'] === 'off' && plainOff.kit.skillsOff === undefined && deepEq(foreign.unmatched, ['no-such-server (MCP)']) && deepEq(foreign.keptOff, ['ghost-skill (skill)', 'no-such-ext (extension)']), JSON.stringify(foreign))

  const unknownWear = wearMod.wearPresetForNextSession('ghost', rows)
  t('P3-9 wearing an unknown preset refuses typed (the store’s closed-roster words) and arms nothing', !unknownWear.ok && unknownWear.reason.includes("unknown preset 'ghost'") && facts.peekWornPresetKit() === null)
  store.saveKitPreset('writing', { mcpOff: ['postgres', 'no-such-server'], skillStates: { deploy: 'invocable' }, extensionsOff: [] })
  const worn = wearMod.wearPresetForNextSession('writing', rows)
  t("P3-10 the wear arms the one-shot with the one-shot receipt and the doesn't-bite census", worn.ok && worn.receipt === "next session wears preset 'writing' — one-shot: the menu's default resumes after · 1 of its 3 deltas names members this repo lacks (no-such-server (MCP)) — they don't bite", JSON.stringify(worn))
  t('P3-11 the armed wear is the RESOLVED kit under the preset (closed membership, wire-valid)', deepEq(facts.peekWornPresetKit()?.kit, { schema: 1, mcp: ['github', 'ext:orchard-tools:db'], skills: ['review'], invocable: ['deploy'], extensions: { 'orchard-tools': 'on' } }))
  t('P3-12 wearing NEVER mutates the store or the menu record (the preset resolves byte-equal after the wear)', (() => { const back = store.kitPresetDeltas('writing'); return back.ok && deepEq(back.deltas, { mcpOff: ['postgres', 'no-such-server'], skillStates: { deploy: 'invocable' }, extensionsOff: [] }) })())
  facts._resetBootBirthFactsForTesting()
  store.deleteKitPreset('writing')

  const sup = await import('../../src/daemon/concourseSupervisor.ts')
  const REC_KIT = { schema: 1 as const, mcp: ['postgres'], skills: [], invocable: [] }
  const liveRec = {
    schema: 1,
    runnerId: 'w-live-proof',
    sessionId: 'sess-live-proof',
    workspaceId: PROJECT,
    modelKey: 'x',
    effort: 'high',
    spawnedAt: Date.now(),
    lastLiveAt: Date.now(),
    pid: process.pid,
    kit: JSON.parse(JSON.stringify(REC_KIT)),
  } as unknown as import('../../src/daemon/concourseSupervisor.ts').ConcourseWorkerRecordV1
  const hopped = await sup.reactivateConcourseSession(
    liveRec,
    { modelKey: 'x', by: 'proof', kit: KIT_WORN },
    [],
    { roster: () => ({ list: () => [] }), dir: process.env.MERCURY_DAEMON_DIR } as never,
  )
  t('P3-13 THE LIVE HOP: ok + liveHop:true on the answer — the carried kit deliberately ignored, nothing spawned', hopped.ok === true && (hopped as { liveHop?: true }).liveHop === true, JSON.stringify(hopped))
  t('P3-14 the live record’s kit did not move a byte (no re-stamp ran)', deepEq(liveRec.kit, REC_KIT))
  const born = read('src/services/switchboard/bornSession.ts')
  const hopSrc = read('src/services/switchboard/hopIntoSession.ts')
  t('P3-15 the birth door consumes at entry and spreads worn-else-carried', born.includes('const worn = takeWornPresetKit()') && born.includes('...(worn !== null ? { kit: worn.kit } : carriedKitOf(facts)),'))
  t('P3-16 the resume door PEEKS, spreads worn-else-carried, and spends only when applied (liveHop gates the take)', hopSrc.includes('const worn = peekWornPresetKit()') && hopSrc.includes('worn !== null ? { kit: worn.kit } : carriedKitOf(bootBirthFacts())') && hopSrc.includes('if (worn !== null && reply.liveHop !== true) takeWornPresetKit()'))
  t('P3-17 the wire carries the pure-hop fact end to end (supervisor answer → protocol row → controlServer pass-through)', read('src/daemon/concourseSupervisor.ts').includes('liveHop: true,') && read('src/daemon/protocol.ts').includes('liveHop?: true') && /'liveHop'/.test(wireKeys(read('src/daemon/controlServer.ts'), 'ADMIT_WIRE_KEYS')) && read('src/daemon/controlServer.ts').includes('...pickDefined(r, ADMIT_WIRE_KEYS)'))
}

section('§P4 — THE COORDINATOR DOOR: the preset derivation, the closed-roster refusals, the held replay, the receipt line')
{
  const sk = await import('../../src/daemon/sessionKit.ts')
  const facts = await import('../../src/services/switchboard/bootBirthFacts.ts')
  facts._resetBootBirthFactsForTesting()
  const unknown = sk.deriveSessionKitForPreset('ghost', PROJECT)
  t('P4-1 an unknown preset refuses typed at the derivation (the closed-roster law — never the menu default)', !unknown.ok && unknown.reason.includes("unknown preset 'ghost'"), JSON.stringify(unknown))
  kitStore.setSkillStateForWorkspace(PROJECT, 'menu-only-skill', 'off')
  saveGlobalConfig(current => ({ ...current, mcpServers: { 'srv-on': { command: 'x' }, 'srv-off': { command: 'x' } } }) as never)
  store.saveKitPreset('coord', { mcpOff: ['srv-off', 'foreign-srv'], skillStates: { deploy: 'invocable' }, extensionsOff: [] })
  const derived = sk.deriveSessionKitForPreset('coord', PROJECT)
  t("P4-2 the preset derivation is RECORD E's shape from the PRESET's deltas (never the menu's): resolved:false, provisional mcp = known minus the preset's off", derived.ok && derived.kit.resolved === false && deepEq(derived.kit.deltas, { mcpOff: ['srv-off', 'foreign-srv'], skillStates: { deploy: 'invocable' }, extensionsOff: [] }) && deepEq(derived.kit.mcp, ['srv-on']) && !JSON.stringify(derived.kit.deltas).includes('menu-only-skill'), JSON.stringify(derived))
  t("P4-3 the honesty note names the unbiting MCP delta and the first-boot sentence for the skill deltas", derived.ok && derived.note === "preset 'coord': 1 MCP delta names servers this repo lacks (foreign-srv) — they don't bite; skill and extension deltas resolve at the session's first boot", derived.ok ? derived.note : '')
  store.saveKitPreset('clean', { mcpOff: ['srv-off'], skillStates: {}, extensionsOff: [] })
  const clean = sk.deriveSessionKitForPreset('clean', PROJECT)
  t('P4-4 a fully-biting MCP-only preset derives with NO note (nothing to confess)', clean.ok && clean.note === undefined)
  saveGlobalConfig(current => ({ ...current, kitPresets: { ...(current.kitPresets ?? {}), mangled: { mcpOff: [42] }, 'bad-grammar': { mcpOff: ['no spaces allowed!'], skillStates: {}, extensionsOff: [] } } }) as never)
  const mangled = sk.deriveSessionKitForPreset('mangled', PROJECT)
  const badGrammar = sk.deriveSessionKitForPreset('bad-grammar', PROJECT)
  t("P4-5 a damaged entry refuses typed at the store's narrowing; a grammar-breaking name refuses typed at the wire's own law (validateKitDeltas)", !mangled.ok && mangled.reason.includes('damaged in the config') && !badGrammar.ok && badGrammar.reason.includes("preset 'bad-grammar' refused —"), JSON.stringify({ mangled, badGrammar }))
  const KIT_A = { schema: 1 as const, mcp: ['srv-on'], skills: [], invocable: [] }
  const KIT_B = { schema: 1 as const, mcp: [], skills: [], invocable: [], resolved: false as const, deltas: { mcpOff: ['srv-on'], skillStates: {}, extensionsOff: [] } }
  const { canonicalWorkspaceId } = await import('../../src/daemon/concourseSupervisor.ts')
  const wsId = canonicalWorkspaceId(PROJECT)
  const rec = { schema: 1, runnerId: 'w-restamp', sessionId: 'sess-restamp-proof', workspaceId: wsId, spawnedAt: Date.now(), lastLiveAt: Date.now(), kit: KIT_A } as unknown as import('../../src/daemon/concourseSupervisor.ts').ConcourseWorkerRecordV1
  sk.restampSessionKit(rec, KIT_B, 'preset', 'proof')
  const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
  const { readSessionReceipts } = await import('../../src/services/switchboard/sessionReceipts.ts')
  const restampRow = JSON.stringify(readSessionReceipts(getProjectDir(wsId), 'sess-restamp-proof'))
  t("P4-6 a preset re-stamp's receipt says the preset truth (never 'from the current menu') with source 'preset' in details", deepEq(rec.kit, KIT_B) && restampRow.includes('kit re-stamped from the named preset (preset)') && restampRow.includes('"source":"preset"') && !restampRow.includes('from the current menu'), restampRow.slice(0, 200))
  const sup = read('src/daemon/concourseSupervisor.ts')
  const admitBody = sup.slice(sup.indexOf('export function makeConcourseAdmitHandler'))
  const presetDoorAt = admitBody.indexOf('if (req.kitPreset !== undefined) {')
  t('P4-7 the preset door sits ABOVE the reactivate branch, the warm claim and the cold mint (one resolution, every road consumes it)', presetDoorAt !== -1 && presetDoorAt < admitBody.indexOf('if (req.resumeSessionId !== undefined) {') && presetDoorAt < admitBody.indexOf('deps.claimWarm !== undefined') && admitBody.includes('kit and kitPreset are one door — send one'))
  t('P4-8 the hoist folds the preset arm and BOTH mints speak the widened source + the preset name/note on their answers', sup.includes('const kit = req.kit ?? preset?.kit ?? deriveSessionKitForWorkspace(workspaceId)') && (sup.match(/kitSource: req\.kit !== undefined \? 'carried' : preset !== undefined \? 'preset' : 'derived',/g) ?? []).length === 2 && (sup.match(/presetName: preset\.name/g) ?? []).length === 2)
  t('P4-9 the reactivate takes the resolved preset whole (args.preset), re-stamps from it (source ternary) and answers the name on both applied roads', sup.includes('const kit = args.kit ?? args.preset?.kit ?? deriveSessionKitForWorkspace(rec.workspaceId)') && sup.includes("args.kit !== undefined ? 'carried' : args.preset !== undefined ? 'preset' : 'derived'") && (sup.match(/presetName: args\.preset\.name/g) ?? []).length === 2)
  t("P4-10 the union widened at its owner: KitStampSource carries 'preset' and the un-stamped live hop still answers liveHop (the twins' one truth)", read('src/daemon/sessionKit.ts').includes("export type KitStampSource = 'carried' | 'derived' | 'preset'") && sup.includes('liveHop: true,'))
  const proto = read('src/daemon/protocol.ts')
  const server = read('src/daemon/controlServer.ts')
  t('P4-11 both wire verbs carry kitPreset and the replies carry the widened source + preset fields', proto.split('kitPreset?: string').length === 3 && proto.split("kitSource?: 'carried' | 'derived' | 'preset'").length === 3 && proto.split('presetName?: string').length === 3)
  const admitKeys = wireKeys(server, 'ADMIT_WIRE_KEYS')
  const dispatchKeys = wireKeys(server, 'DISPATCH_WIRE_KEYS')
  t('P4-12 the server refuses a malformed kitPreset typed on BOTH verbs and forwards the narrowed name on both; the answers pass presetName/presetNote', (server.match(/kitPreset must be a saved preset name \(a non-empty string\)/g) ?? []).length === 2 && (server.match(/\? \{ kitPreset: raw\.kitPreset \} : \{\}/g) ?? []).length === 2 && /'presetName'/.test(admitKeys) && /'presetNote'/.test(admitKeys) && /'presetName'/.test(dispatchKeys) && /'presetNote'/.test(dispatchKeys) && server.includes('...pickDefined(r, ADMIT_WIRE_KEYS)') && server.includes('...pickDefined(r, DISPATCH_WIRE_KEYS)'))
  const dispatchMod = await import('../../src/daemon/concourseDispatch.ts')
  void dispatchMod
  const disp = read('src/daemon/concourseDispatch.ts')
  t('P4-13 the held envelope banks kitPreset and the daemon-side replay re-supplies it (type + bank + replay spreads)', disp.includes('kitPreset?: string') && disp.includes('...(req.kitPreset !== undefined ? { kitPreset: req.kitPreset } : {})') && disp.includes('...(op.kitPreset !== undefined ? { kitPreset: op.kitPreset } : {})'))
  const tools = read('src/services/concourse/coordinatorTools.ts')
  t('P4-14 launch_session carries the preset input with the closed-roster sentence and forwards it on BOTH roads (dispatch kitPreset · admit kitPreset)', tools.includes('A SAVED KIT PRESET the session is born wearing') && tools.includes('...(str(p.preset) !== undefined ? { kitPreset: str(p.preset) } : {})') && tools.includes('...(args.preset !== undefined ? { kitPreset: args.preset } : {})'))
  t("P4-15 both launch receipts name the worn preset ahead of the kit-source word and carry the honesty note", (tools.match(/wearing preset '\$\{presetWorn\}'/g) ?? []).length === 2 && (tools.match(/presetNote,/g) ?? []).length === 2)
  store.deleteKitPreset('coord')
  store.deleteKitPreset('clean')
  saveGlobalConfig(current => {
    const { kitPresets: _all, ...bare } = current
    void _all
    return { ...bare, mcpServers: {} } as typeof current
  })
  kitStore.setSkillStateForWorkspace(PROJECT, 'menu-only-skill', 'on')
}

section('§P5 — THE SWEEP: vocabulary lane-wide · both-directions isolation · one grammar at both doors · no world checks')
{
  const LAW_SENTENCES = /"pack" is reserved for extensions|"pack" is the extensions estate's word|"pack" is RESERVED for extensions/g
  const PREEXISTING = /no wrapper\n?\s*(\/\/ )?pack, no teammate contract/g
  const SWEEP_FILES = [
    'src/services/mcp/presetStore.ts',
    'src/services/kitMenu/presetWear.ts',
    'src/services/kitMenu/presetHook.ts',
    'src/components/KitMenuScreen.tsx',
    'src/components/BootSplashScreen.tsx',
    'src/services/switchboard/bootBirthFacts.ts',
    'src/services/switchboard/bornSession.ts',
    'src/services/switchboard/hopIntoSession.ts',
    'src/daemon/sessionKit.ts',
    'src/daemon/concourseSupervisor.ts',
    'src/daemon/controlServer.ts',
    'src/daemon/protocol.ts',
    'src/daemon/concourseDispatch.ts',
    'src/services/concourse/coordinatorTools.ts',
    'assets/splash/splash-core.mjs',
    'src/services/kitMenu/resolvedKit.ts',
    'src/services/kitMenu/menuStore.ts',
    'src/services/kitMenu/kitTypes.ts',
  ]
  const packHits = SWEEP_FILES.filter(f => /\bpacks?\b/i.test(read(f).replace(LAW_SENTENCES, '').replace(PREEXISTING, '')))
  t("P5-1 the vocabulary law lane-wide: 'pack' spelled nowhere across every touched file (two quoted standing exceptions only)", packHits.length === 0, packHits.join(','))

  const wearMod = await import('../../src/services/kitMenu/presetWear.ts')
  const sk = await import('../../src/daemon/sessionKit.ts')
  const wearUnknown = wearMod.wearPresetForNextSession('nobody', [])
  const deriveUnknown = sk.deriveSessionKitForPreset('nobody', PROJECT)
  t("P5-2 both doors refuse an unknown preset through the store's ONE sentence ('unknown preset …' + the roster words)", !wearUnknown.ok && !deriveUnknown.ok && wearUnknown.reason.startsWith("unknown preset 'nobody'") && deriveUnknown.reason.startsWith("unknown preset 'nobody'"))

  store.saveKitPreset('iso-sweep', { mcpOff: ['github'], skillStates: {}, extensionsOff: [] })
  const presetBytesBefore = JSON.stringify(store.kitPresetDeltas('iso-sweep'))
  kitStore.setSkillStateForWorkspace(PROJECT, 'sweep-skill', 'off')
  kitStore.setMcpServerEnabledForWorkspace(PROJECT, 'sweep-srv', false)
  kitStore.setExtensionStateForWorkspace(PROJECT, 'sweep-ext', false)
  t('P5-3 the OTHER direction: menu-store writes leave every saved preset byte-identical', JSON.stringify(store.kitPresetDeltas('iso-sweep')) === presetBytesBefore)
  kitStore.setSkillStateForWorkspace(PROJECT, 'sweep-skill', 'on')
  kitStore.setMcpServerEnabledForWorkspace(PROJECT, 'sweep-srv', true)
  kitStore.setExtensionStateForWorkspace(PROJECT, 'sweep-ext', true)
  store.deleteKitPreset('iso-sweep')

  const WORLD_TOKENS = ['chatOnlyBoot', 'chatBoot(', 'MERCURY_SPLASH_CHAT']
  const LANE_KIT_PATH = ['src/services/mcp/presetStore.ts', 'src/services/kitMenu/presetWear.ts', 'src/services/kitMenu/presetHook.ts', 'src/daemon/sessionKit.ts']
  const worldHits = LANE_KIT_PATH.filter(f => WORLD_TOKENS.some(tok => read(f).includes(tok)))
  t('P5-4 no world token in the kit path (identical worlds — the preset roads never ask which boot this is)', worldHits.length === 0, worldHits.join(','))

  const wearSrc = read('src/services/kitMenu/presetWear.ts')
  t('P5-5 the wear composes membership through resolvedKitOf alone (one composer; statesFromDeltas is the one rendering)', wearSrc.includes("import { resolvedKitOf } from './resolvedKit.js'") && wearSrc.includes('resolvedKitOf(rows, states)') && !wearSrc.includes('for (const row of rows) {\n    if (row.kind ==='))

  const facts = await import('../../src/services/switchboard/bootBirthFacts.ts')
  facts._resetBootBirthFactsForTesting()
  const MENU_KIT = { schema: 1 as const, mcp: ['github'], skills: [], invocable: [] }
  facts.setNextSessionFacts({ kit: MENU_KIT })
  store.saveKitPreset('cycle', { mcpOff: [], skillStates: {}, extensionsOff: [] })
  const rows: import('../../src/services/kitMenu/kitTypes.ts').KitRow[] = [{ kind: 'mcp', section: 'mcp', name: 'github', scope: 'user', extension: null }]
  wearMod.wearPresetForNextSession('cycle', rows)
  facts.takeWornPresetKit()
  wearMod.wearPresetForNextSession('cycle', rows)
  wearMod.disarmWornPreset()
  const cycleBack = store.kitPresetDeltas('cycle')
  t('P5-6 a full save→wear→spend→re-wear→disarm cycle leaves the sticky menu carry AND the stored preset byte-identical', deepEq(facts.bootBirthFacts().kit, MENU_KIT) && facts.peekWornPresetKit() === null && cycleBack.ok && deepEq(cycleBack.deltas, { mcpOff: [], skillStates: {}, extensionsOff: [] }))
  store.deleteKitPreset('cycle')
  facts._resetBootBirthFactsForTesting()
}

section('§P6 — ONE LAW AT BOTH DOORS (the lead\'s ruling): a preset\'s OFF stays off wherever it is worn')
{
  const wearMod = await import('../../src/services/kitMenu/presetWear.ts')
  const sk = await import('../../src/daemon/sessionKit.ts')
  const { completeSessionKitFromRoster } = await import('../../src/services/mcp/kitCompletion.ts')
  const LATE = { mcpOff: ['late-srv'], skillStates: { 'late-skill': 'off' as const, 'late-inv': 'invocable' as const }, extensionsOff: ['late-ext'] }
  const rows: import('../../src/services/kitMenu/kitTypes.ts').KitRow[] = [
    { kind: 'mcp', section: 'mcp', name: 'github', scope: 'user', extension: null },
    { kind: 'skill', section: 'skill', name: 'deploy', source: 'project settings', extension: null },
  ]
  const worn = wearMod.resolvePresetWear(rows, LATE)
  const completed = completeSessionKitFromRoster(
    { schema: 1, mcp: [], skills: [], invocable: [], resolved: false, deltas: LATE },
    { mcpNames: [], commands: [], extensions: [] },
  )
  const verdictOf = (kit: import('../../src/daemon/sessionKit.ts').SessionKitV1): Record<string, string> => ({
    'late-skill': (kit.skillsOff ?? []).includes('late-skill') ? 'off-by-name' : 'unnamed',
    'late-ext': kit.extensions?.['late-ext'] === 'off' ? 'off-by-name' : 'unnamed',
    'late-srv': kit.mcp.includes('late-srv') ? 'member' : 'excluded-by-absence',
    'late-inv': kit.invocable.includes('late-inv') ? 'invocable' : (kit.skillsOff ?? []).includes('late-inv') ? 'off-by-name' : 'unnamed',
  })
  t('P6-1 BOTH DOORS, ONE VERDICT on every later-born member (the asymmetry is the poison — off skills and extensions off-by-name; the server excluded by closed membership; the invocable delta not carried at either door)', worn.ok && deepEq(verdictOf(worn.kit), verdictOf(completed)) && verdictOf(completed)['late-skill'] === 'off-by-name' && verdictOf(completed)['late-ext'] === 'off-by-name' && verdictOf(completed)['late-srv'] === 'excluded-by-absence' && verdictOf(completed)['late-inv'] === 'unnamed', worn.ok ? JSON.stringify({ worn: verdictOf(worn.kit), completed: verdictOf(completed) }) : JSON.stringify(worn))
  t('P6-2 the worn carry is wire-legal (validateSessionKit accepts the skillsOff-carrying kit — DIALS widened the schema) and the roster-resolved members ride beside it', worn.ok && sk.validateSessionKit(worn.kit).ok && deepEq(worn.kit.mcp, ['github']) && deepEq(worn.kit.skills, ['deploy']))
  t("P6-3 the receipt splits the truth: kept-off named as biting, the MCP and invocable rows still as doesn't-bite", worn.ok && deepEq(worn.keptOff, ['late-skill (skill)', 'late-ext (extension)']) && deepEq(worn.unmatched, ['late-srv (MCP)', 'late-inv (skill)']))
  const illGrammar = wearMod.resolvePresetWear(rows, { mcpOff: [], skillStates: { 'bad name': 'off' as const }, extensionsOff: ['NOT-LOWER'] })
  t('P6-4 ill-grammared off names are filtered exactly like the completion filters them (doesn\'t-bite rows; the wear still lands lawful)', illGrammar.ok && illGrammar.kit.skillsOff === undefined && illGrammar.kit.extensions === undefined && deepEq(illGrammar.unmatched, ['bad name (skill)', 'NOT-LOWER (extension)']) && illGrammar.keptOff.length === 0, JSON.stringify(illGrammar))
  store.saveKitPreset('travel', LATE)
  const receipt = wearMod.wearPresetForNextSession('travel', rows)
  t("P6-5 the wear receipt names the kept-off members as biting ('kept off by name') beside the doesn't-bite census", receipt.ok && receipt.receipt.includes('2 off deltas name members this repo lacks (late-skill (skill), late-ext (extension)) — kept off by name') && receipt.receipt.includes("don't bite"), JSON.stringify(receipt))
  const factsMod = await import('../../src/services/switchboard/bootBirthFacts.ts')
  t('P6-6 the armed one-shot carries the off-by-name kit (the birth wears it verbatim)', deepEq(factsMod.peekWornPresetKit()?.kit.skillsOff, ['late-skill']) && factsMod.peekWornPresetKit()?.kit.extensions?.['late-ext'] === 'off')
  factsMod._resetBootBirthFactsForTesting()
  store.deleteKitPreset('travel')
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE${failures === 1 ? '' : 'S'}`}`)
process.exit(failures === 0 ? 0 : 1)
