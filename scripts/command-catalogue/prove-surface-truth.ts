#!/usr/bin/env bun
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'surface-truth-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_MODEL = 'claude-fable-5[1m]'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
for (const pin of ['MERCURY_DEFAULT_FABLE_MODEL', 'MERCURY_DEFAULT_OPUS_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL', 'MERCURY_DEFAULT_HAIKU_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_DISABLE_1M_CONTEXT']) {
  delete process.env[pin]
}

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { builtinCommands } = await import('../../src/commands/catalogue/commands.js')
const model = await import('../../src/models/catalogue/engineModel.js')
const configs = await import('../../src/models/facts/builtInModelTable.js')
const { getModelStrings } = await import('../../src/models/facts/pinnedModelIds.js')
const frontier = await import('../../src/models/catalogue/frontierPolicy.js')
const { getModelOptions } = await import('../../src/models/catalogue/modelOptions.js')
const { MODEL_COSTS } = await import('../../src/models/usage/modelCost.js')
const { getContextWindowForModel } = await import('../../src/models/facts/capabilities.js')
const { foldLegacyWorkerModelKey } = await import('../../src/screen/concourse-model/workerModels.js')
const { resolveAnthropicModel } = await import('../../src/models/roads/anthropic/anthropicAdapter.js')
const { gptDisplayName, GPT_DISPLAY_PINS } = await import('../../src/models/facts/pins/gptPins.js')
const focusedSlot = await import('../../src/engine/connector/focusedConnector.js')
const { noSessionConnector } = await import('../../src/engine/connector/noSessionConnector.js')
const { resolveStampedEffortTruth } = await import('../../src/models/effort/effort.js')
const { permissionModeTitle } = await import('../../src/permissions/rules/permissionMode.js')


section('§1 A DESCRIPTION IS A LABEL')
const all = [...builtinCommands()]
const byName = (n: string) => all.find(c => c.name === n)
const modelCmd = byName('model')
check("/model's description is the static label", modelCmd?.description === 'Choose the AI model', String(modelCmd?.description), 'restore the static description string in src/commands/model/index.ts')
const liveGetters = all
  .filter(c => {
    const d = Object.getOwnPropertyDescriptor(c, 'description')
    return d !== undefined && typeof d.get === 'function'
  })
  .map(c => c.name)
  .sort()
const JUDGED_GETTERS = ['concourse', 'orient', 'logins']
check(
  'the live description getters are the judged set (concourse: the boot shape · orient: a constant · logins: which sentence, no account word)',
  liveGetters.every(n => JUDGED_GETTERS.includes(n)),
  liveGetters.join(','),
  'a built-in command other than the judged ones defines description as a getter; make it a plain string in its src/commands/<name>/index.ts',
)
const displayWords = [
  ...configs.CANONICAL_MODEL_IDS.map(id => model.renderModelName(id)).filter(w => !w.startsWith('claude-')),
  ...GPT_DISPLAY_PINS.map(p => p.displayName),
]
const describedLive = all.filter(c => {
  const d = String(c.description)
  return d.includes('(currently') || d.includes('(1M context)') || displayWords.some(w => d.includes(w)) || /\S+@\S+\.\S+/.test(d)
})
check('no built-in description carries a live model, window, or account word', describedLive.length === 0, describedLive.map(c => `${c.name}: ${c.description}`).join(' | '), 'move the live model, window or account word out of that command description in src/commands/<name>/index.ts and into its currentValue')

section("§2 THE VALUE COLUMN READS THE ONE OWNER (the focused session's facts)")
type Facts = ReturnType<typeof focusedSlot.getFocusedSessionConnector>['modelFacts'] extends () => infer F ? F : never
function seatStub(facts: Facts, mode = 'implement'): ReturnType<typeof focusedSlot.getFocusedSessionConnector> {
  const base = noSessionConnector()
  return Object.assign(Object.create(base), { modelFacts: () => facts, permissionMode: () => mode })
}
const value = (name: string): string | undefined => byName(name)?.currentValue?.()
const screenLabel = model.renderModelName(model.getEngineModel())
check('the screen\'s own default is the Fable row (the poison word)', screenLabel === 'Fable 5 (1M context)', screenLabel, 'renderModelName or getEngineModel in src/models/catalogue/engineModel.ts no longer yields the Fable row for the pinned MERCURY_MODEL')

focusedSlot._resetFocusedSessionConnectorForTesting()
check('no session holds the slot ⇒ the /model column is blank (never the process default)', value('model') === undefined, String(value('model')), 'currentValue in src/commands/model/index.ts must return undefined when no session holds the focused slot')
check('no session ⇒ the /effort column is blank', value('effort') === undefined, String(value('effort')))
check('no session ⇒ the /permissions column is blank', value('permissions') === undefined)

const opusFacts: Facts = { effective: 'claude-opus-5', effectiveSource: 'live', main: 'claude-opus-5', setting: 'claude-opus-5', sessionPin: 'claude-opus-5', effort: 'xhigh', pendingSwitch: null }
focusedSlot.setFocusedSessionConnector(seatStub(opusFacts))
check("a seat on Opus 5 at xhigh ⇒ the /model column is the seat's row", value('model') === model.renderModelName('claude-opus-5') && value('model') !== screenLabel, String(value('model')))
check("⇒ the /effort column says the seat's word is ASKED while its runner has not said what it sends", value('effort') === 'xhigh (asked)', String(value('effort')), 'currentValue in src/commands/effort/index.ts must add (asked) while the facts carry no effortSent')
focusedSlot.setFocusedSessionConnector(seatStub({ ...opusFacts, effortSent: 'xhigh' }))
check("⇒ with the runner's sent word on the facts the column is that word", value('effort') === 'xhigh', String(value('effort')))
focusedSlot.setFocusedSessionConnector(seatStub({ ...opusFacts, effortSent: null }))
check("⇒ with the runner's no-key word the column is the seat's word resolved without this process's env pin", value('effort') === resolveStampedEffortTruth('claude-opus-5', 'xhigh').label && value('effort') === 'xhigh', String(value('effort')))
focusedSlot.setFocusedSessionConnector(seatStub(opusFacts))
check("⇒ the mode column reads the seat's own mode door", value('permissions') === permissionModeTitle('implement'), String(value('permissions')), 'currentValue in src/commands/permissions/index.ts must read the seat mode through permissionModeTitle')

const gptFacts: Facts = { effective: 'gpt-5.5', effectiveSource: 'record', main: 'gpt-5.5', setting: 'gpt-5.5', sessionPin: 'gpt-5.5', effort: null, pendingSwitch: null }
focusedSlot.setFocusedSessionConnector(seatStub(gptFacts))
check("a seat born on the OpenAI row (the record, facts not yet read) ⇒ the /model column names it", value('model') === 'GPT-5.5', String(value('model')))
check('a seat whose record carries no effort word ⇒ the /effort column is blank, never a guess', value('effort') === undefined, String(value('effort')))

const ambientFacts: Facts = { ...opusFacts, effectiveSource: 'ambient' }
focusedSlot.setFocusedSessionConnector(seatStub(ambientFacts))
check("a seat whose facts are still this process's ambient state ⇒ every column is blank", value('model') === undefined && value('effort') === undefined, `${String(value('model'))} / ${String(value('effort'))}`)
check('focusedSessionModelFacts() is null on the ambient source (the one gate every reader shares)', focusedSlot.focusedSessionModelFacts() === null, '', 'focusedSessionModelFacts in src/engine/connector/focusedConnector.ts must return null when effectiveSource is ambient')
focusedSlot._resetFocusedSessionConnectorForTesting()

{
  const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.js')
  const { publishSessionFacts } = await import('../../src/engine/connector/seatProjections.js')
  const sessionId = 'surface-truth-seat'
  let factsFeedReads: () => void = () => {}
  const hosted = new DaemonSessionConnector({ sessionId, runnerId: 'runner-1', title: 'surface truth', projectLabel: 'proof', workspaceId: SCRATCH, home: SCRATCH, modelKey: 'claude-sonnet-5', effort: 'medium' }, {
    rpc: async () => ({ ok: true }),
    factsRead: (read: () => void) => {
      factsFeedReads = read
    },
  })
  const says = (atMs: number, setting: string | null, extra: Record<string, unknown>): void => {
    publishSessionFacts({ schema: 1, sessionId, atMs, pendingModel: null, busy: false, model: { effective: 'claude-opus-5', setting }, usage: noSessionConnector().usage(), identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null }, skills: [], mcp: [], workspace: { cwd: SCRATCH, originalCwd: SCRATCH, projectRoot: SCRATCH }, queue: [], ...extra } as never)
    factsFeedReads()
  }
  const recorded = hosted.modelFacts()
  says(1, 'claude-opus-5', { permissionMode: 'default' })
  const pinned = hosted.modelFacts()
  says(2, 'claude-opus-5', { permissionMode: 'default', effort: 'xhigh' })
  const worded = hosted.modelFacts()
  const woken: string[] = []
  hosted.subscribeModel(() => woken.push('model'))
  hosted.subscribePermissionMode(() => woken.push('permission'))
  says(3, 'claude-opus-5', { permissionMode: 'implement', effort: 'low' })
  const effortAndMode = woken.splice(0).join(' ')
  says(4, 'claude-opus-5', { permissionMode: 'default', effort: 'low' })
  const modeAlone = woken.splice(0).join(' ')
  says(5, null, { permissionMode: 'default', effort: 'low' })
  const unpinned = hosted.modelFacts()
  check(
    'src/engine/connector/daemonConnector.ts: the seat facts carry the pin and the effort word; the effort move pulses the model feed',
    recorded.sessionPin === 'claude-sonnet-5' && recorded.effort === 'medium' && pinned.sessionPin === 'claude-opus-5' && pinned.effort === 'medium' && worded.effort === 'xhigh' && unpinned.sessionPin === 'claude-sonnet-5' && effortAndMode === 'model permission' && modeAlone === 'permission model',
    `before any facts the pin and the word are the record's (${String(recorded.sessionPin)}, ${String(recorded.effort)}); facts that name a setting and no effort read ${String(pinned.sessionPin)} and ${String(pinned.effort)}; facts with a word read ${String(worded.effort)}; facts whose setting is null read the pin ${String(unpinned.sessionPin)}; a read where the effort and the mode moved woke "${effortAndMode}" and one where the mode moved alone woke "${modeAlone}" (the model feed first only when the model's facts moved)`,
  )
}


section('§5 THE GENERATION TABLE — one table per family, every reader derives')
const strings = getModelStrings()
const families = Object.keys(configs.FAMILY_GENERATIONS) as Array<keyof typeof configs.FAMILY_GENERATIONS>
check('the table names the four first-party families', families.sort().join(',') === 'fable,haiku,opus,sonnet', families.join(','), 'FAMILY_GENERATIONS in src/models/facts/builtInModelTable.ts must hold exactly the four families fable, haiku, opus, sonnet')
for (const family of families) {
  const keys = configs.FAMILY_GENERATIONS[family]
  check(`${family}: every row is a catalogue key, newest first`, keys.length > 0 && keys.every(k => k in configs.ALL_MODEL_CONFIGS), '', 'every FAMILY_GENERATIONS row in src/models/facts/builtInModelTable.ts must be a key of ALL_MODEL_CONFIGS, newest first')
  for (const key of keys) {
    const id = strings[key]
    check(`${family}/${key}: a display name, a cost tier and a window`, model.renderModelName(id) !== id && MODEL_COSTS[model.getCanonicalName(id)] !== undefined && getContextWindowForModel(id) > 0, `${id}: name=${model.renderModelName(id)} cost=${String(MODEL_COSTS[model.getCanonicalName(id)] !== undefined)} window=${getContextWindowForModel(id)}`, 'add the missing display name, MODEL_COSTS row (src/models/usage/modelCost.ts) or context window (src/models/facts/capabilities.ts) for that model')
  }
}
const head = (family: keyof typeof configs.FAMILY_GENERATIONS): string => strings[configs.newestGenerationKey(family)]
check('the family defaults derive from the table heads (no env pins set)',
  model.getDefaultFableModel() === head('fable') && model.getDefaultOpusModel() === head('opus') && model.getDefaultSonnetModel() === head('sonnet') && model.getDefaultHaikuModel() === head('haiku'),
  [model.getDefaultFableModel(), model.getDefaultOpusModel(), model.getDefaultSonnetModel(), model.getDefaultHaikuModel()].join(','), 'the getDefault*Model functions in src/models/facts/modelNames.ts must derive from newestGenerationKey in src/models/facts/builtInModelTable.ts')
check('the family words resolve to the table heads', model.parseUserSpecifiedModel('fable') === head('fable') && model.parseUserSpecifiedModel('opus') === head('opus') && model.parseUserSpecifiedModel('sonnet') === head('sonnet') && model.parseUserSpecifiedModel('haiku') === head('haiku'), '', 'parseUserSpecifiedModel in src/models/catalogue/engineModel.ts must resolve each family word to its table head')
check('the frontier family\'s newest is the 5.2 row (the catalogue names the newest: the vendor released it on 2026-11-09)', head('fable') === strings.fable52, head('fable'), 'FAMILY_GENERATIONS.fable in src/models/facts/builtInModelTable.ts must lead with the fable52 row')
const facts = frontier.gatherFrontierFacts()
check('the frontier candidate is the table head', facts.fableId === head('fable'), facts.fableId, 'gatherFrontierFacts in src/models/catalogue/frontierPolicy.ts must take fableId from the table head')
const eligible = { ...facts, fableEnvPin: false, allowlistPresent: false, allowlistNamesFable: false, claudeAiSubscriber: true, maxSubscriber: true, rateLimitTier: frontier.FRONTIER_MAX_20X_TIER, oneMDisabled: false }
const decision = frontier.evaluateFrontierDecision(eligible)
check("a natively-1M frontier head wins as its bare id (no '[1m]' rider)", decision.source === 'frontier' && decision.setting === head('fable') && facts.fableNatively1M === true, `${decision.setting} natively1M=${String(facts.fableNatively1M)}`, 'evaluateFrontierDecision in src/models/catalogue/frontierPolicy.ts must return the bare head id when the head is natively 1M')
const suffixRow = frontier.evaluateFrontierDecision({ ...eligible, fableNatively1M: false })
check("a suffix-1M row would keep its '[1m]' rider (parity for the older shape)", suffixRow.setting === `${head('fable')}[1m]`, suffixRow.setting, 'evaluateFrontierDecision in src/models/catalogue/frontierPolicy.ts must append [1m] when fableNatively1M is false')
check("a crew record's legacy keys fold: the family word to the head; the exact-generation key stays on its own generation once a newer row leads", foldLegacyWorkerModelKey('fable') === head('fable') && foldLegacyWorkerModelKey('opus') === head('opus') && foldLegacyWorkerModelKey('sonnet') === head('sonnet') && foldLegacyWorkerModelKey('fable51') === strings.fable51 && foldLegacyWorkerModelKey('fable51') !== foldLegacyWorkerModelKey('fable'), `${foldLegacyWorkerModelKey('fable51')} / ${foldLegacyWorkerModelKey('fable')}`, 'foldLegacyWorkerModelKey in src/screen/concourse-model/workerModels.ts must fold a family word to the head and keep an exact-generation key')
const routed = resolveAnthropicModel('fable')
check("the router's fable class runs the head in its seat form (bare when natively 1M)", routed !== null && routed.model === (getContextWindowForModel(head('fable')) >= 1_000_000 ? head('fable') : `${head('fable')}[1m]`), String(routed?.model), 'resolveAnthropicModel in src/models/roads/anthropic/anthropicAdapter.ts must return the head, with [1m] only when its window is under 1M')
const options = getModelOptions()
check("the picker carries the family full-id row labelled with the head's display name", options.some(o => o.value === head('fable') && o.label === model.renderModelName(head('fable'))), options.filter(o => o.value === head('fable')).map(o => o.label).join(','), 'getModelOptions in src/models/catalogue/modelOptions.ts must list the head full id labelled with renderModelName')
check('the picker carries a literal row per previous frontier generation', configs.previousGenerationKeys('fable').every(k => options.some(o => o.value === strings[k])), configs.previousGenerationKeys('fable').map(k => strings[k]).join(','), 'getModelOptions in src/models/catalogue/modelOptions.ts must add a row for each previousGenerationKeys fable entry')
check('the picker carries the previous large generations from the table', configs.previousGenerationKeys('opus').every(k => options.some(o => o.value === strings[k])), '', 'getModelOptions in src/models/catalogue/modelOptions.ts must add a row for each previousGenerationKeys opus entry')
check("the OpenAI family's display names come from the pins table", gptDisplayName('gpt-5.5') === 'GPT-5.5' && gptDisplayName('gpt-5.6-sol') === 'GPT-5.6 Sol', '', 'GPT_DISPLAY_PINS in src/models/facts/pins/gptPins.ts must carry the display names GPT-5.5 and GPT-5.6 Sol')


console.log(failures === 0 ? '\nprove-surface-truth: ALL LAWS HOLD' : `\nprove-surface-truth: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
