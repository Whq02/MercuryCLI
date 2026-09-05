#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'surface-truth-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_TABULA_DIR = join(SCRATCH, 'tabula')
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.MERCURY_TABULA_DIR, { recursive: true })
process.env.ANTHROPIC_MODEL = 'claude-fable-5[1m]'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
for (const pin of ['ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_DISABLE_1M_CONTEXT']) {
  delete process.env[pin]
}

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { builtinCommands } = await import('../../src/commands.js')
const model = await import('../../src/utils/model/model.js')
const configs = await import('../../src/utils/model/configs.js')
const { getModelStrings } = await import('../../src/utils/model/modelStrings.js')
const frontier = await import('../../src/utils/model/frontierPolicy.js')
const { getModelOptions } = await import('../../src/utils/model/modelOptions.js')
const { MODEL_COSTS } = await import('../../src/utils/modelCost.js')
const { getContextWindowForModel } = await import('../../src/utils/model/capabilities.js')
const { CREW_MODEL_CHOICES } = await import('../../src/daemon/crewSpawn.js')
const { resolveAnthropicModel } = await import('../../src/utils/router/providers/anthropic.js')
const { gptDisplayName, GPT_DISPLAY_PINS } = await import('../../src/services/providers/openai/gptPins.js')
const focusedSlot = await import('../../src/services/engine-connector/focusedConnector.js')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { resolveStampedEffortTruth } = await import('../../src/utils/effort.js')
const { permissionModeTitle } = await import('../../src/utils/permissions/PermissionMode.js')

const src = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
const codeOnly = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
function walkSrc(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'node_modules') continue
    if (statSync(p).isDirectory()) walkSrc(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}
const SRC_FILES = walkSrc(join(REPO, 'src')).map(p => relative(REPO, p))

section('§1 A DESCRIPTION IS A LABEL')
const all = [...builtinCommands()]
const byName = (n: string) => all.find(c => c.name === n)
const modelCmd = byName('model')
check("/model's description is the static label", modelCmd?.description === 'Choose the AI model', String(modelCmd?.description))
const liveGetters = all
  .filter(c => {
    const d = Object.getOwnPropertyDescriptor(c, 'description')
    return d !== undefined && typeof d.get === 'function'
  })
  .map(c => c.name)
  .sort()
const JUDGED_GETTERS = ['concourse', 'init', 'logins']
check(
  'the live description getters are the judged set (concourse: the boot shape · init: a constant · logins: which sentence, no account word)',
  liveGetters.every(n => JUDGED_GETTERS.includes(n)),
  liveGetters.join(','),
)
const displayWords = [
  ...configs.CANONICAL_MODEL_IDS.map(id => model.renderModelName(id)).filter(w => !w.startsWith('claude-')),
  ...GPT_DISPLAY_PINS.map(p => p.displayName),
]
const describedLive = all.filter(c => {
  const d = String(c.description)
  return d.includes('(currently') || d.includes('(1M context)') || displayWords.some(w => d.includes(w)) || /\S+@\S+\.\S+/.test(d)
})
check('no built-in description carries a live model, window, or account word', describedLive.length === 0, describedLive.map(c => `${c.name}: ${c.description}`).join(' | '))
const sandboxCmd = byName('sandbox')
check("/sandbox's live state moved to the value column (a static description, a currentValue)", sandboxCmd?.description === 'Sandboxing — Enter opens the configuration' && typeof sandboxCmd?.currentValue === 'function')

section("§2 THE VALUE COLUMN READS THE ONE OWNER (the focused session's facts)")
type Facts = ReturnType<typeof focusedSlot.getFocusedSessionConnector>['modelFacts'] extends () => infer F ? F : never
function seatStub(facts: Facts, mode = 'strategy'): ReturnType<typeof focusedSlot.getFocusedSessionConnector> {
  const base = noSessionConnector()
  return Object.assign(Object.create(base), { modelFacts: () => facts, permissionMode: () => mode })
}
const value = (name: string): string | undefined => byName(name)?.currentValue?.()
const screenLabel = model.renderModelName(model.getMainLoopModel())
check('the screen\'s own default is the Fable row (the poison word)', screenLabel === 'Fable 5 (1M context)', screenLabel)

focusedSlot._resetFocusedSessionConnectorForTesting()
check('no session holds the slot ⇒ the /model column is blank (never the process default)', value('model') === undefined, String(value('model')))
check('no session ⇒ the /effort column is blank', value('effort') === undefined, String(value('effort')))
check('no session ⇒ the /authority and /permissions columns are blank', value('authority') === undefined && value('permissions') === undefined)

const opusFacts: Facts = { effective: 'claude-opus-5', effectiveSource: 'live', main: 'claude-opus-5', setting: 'claude-opus-5', sessionPin: 'claude-opus-5', effort: 'xhigh', pendingSwitch: null }
focusedSlot.setFocusedSessionConnector(seatStub(opusFacts))
check("a seat on Opus 5 at xhigh ⇒ the /model column is the seat's row", value('model') === model.renderModelName('claude-opus-5') && value('model') !== screenLabel, String(value('model')))
check("⇒ the /effort column says the seat's word is ASKED while its runner has not said what it sends", value('effort') === 'xhigh (asked)', String(value('effort')))
focusedSlot.setFocusedSessionConnector(seatStub({ ...opusFacts, effortSent: 'xhigh' }))
check("⇒ with the runner's sent word on the facts the column is that word", value('effort') === 'xhigh', String(value('effort')))
focusedSlot.setFocusedSessionConnector(seatStub({ ...opusFacts, effortSent: null }))
check("⇒ with the runner's no-key word the column is the seat's word resolved without this process's env pin", value('effort') === resolveStampedEffortTruth('claude-opus-5', 'xhigh').label && value('effort') === 'xhigh', String(value('effort')))
focusedSlot.setFocusedSessionConnector(seatStub(opusFacts))
check("⇒ the mode columns read the seat's own mode door", value('authority') === permissionModeTitle('strategy') && value('permissions') === permissionModeTitle('strategy'), String(value('authority')))

const gptFacts: Facts = { effective: 'gpt-5.5', effectiveSource: 'record', main: 'gpt-5.5', setting: 'gpt-5.5', sessionPin: 'gpt-5.5', effort: null, pendingSwitch: null }
focusedSlot.setFocusedSessionConnector(seatStub(gptFacts))
check("a seat born on the OpenAI row (the record, facts not yet read) ⇒ the /model column names it", value('model') === 'GPT-5.5', String(value('model')))
check('a seat whose record carries no effort word ⇒ the /effort column is blank, never a guess', value('effort') === undefined, String(value('effort')))

const ambientFacts: Facts = { ...opusFacts, effectiveSource: 'ambient' }
focusedSlot.setFocusedSessionConnector(seatStub(ambientFacts))
check("a seat whose facts are still this process's ambient state ⇒ every column is blank", value('model') === undefined && value('effort') === undefined, `${String(value('model'))} / ${String(value('effort'))}`)
check('focusedSessionModelFacts() is null on the ambient source (the one gate every reader shares)', focusedSlot.focusedSessionModelFacts() === null)
focusedSlot._resetFocusedSessionConnectorForTesting()

section('§3 THE CENSUS — each re-pointed surface reads the owner in source')
const has = (rel: string, needle: string | RegExp): boolean => (typeof needle === 'string' ? src(rel).includes(needle) : needle.test(src(rel)))
const censusRows: Array<[string, string, boolean]> = [
  ['src/commands/model/index.ts', 'the value column reads focusedSessionModelFacts; no process-default or screen-slice read', has('src/commands/model/index.ts', 'focusedSessionModelFacts()') && !has('src/commands/model/index.ts', 'getMainLoopModel') && !has('src/commands/model/index.ts', 'mainLoopModelForSession')],
  ['src/commands/effort/index.ts', "the seat's word through the stamped resolve (no env pin)", has('src/commands/effort/index.ts', 'resolveStampedEffortTruth(facts.effective') && !has('src/commands/effort/index.ts', 'getMainLoopModel')],
  ['src/commands/authority/index.ts', "the seat's mode door", has('src/commands/authority/index.ts', 'getFocusedSessionConnector().permissionMode()')],
  ['src/commands/permissions/index.ts', "the seat's mode door", has('src/commands/permissions/index.ts', 'getFocusedSessionConnector().permissionMode()')],
  ['src/types/command.ts', 'the screen-scoped menu slice is gone; currentValue takes no argument', !has('src/types/command.ts', 'MenuLiveState') && has('src/types/command.ts', 'currentValue?: () => string | undefined')],
  ['src/hooks/useTypeahead.tsx', 'the palette hands no app-state snapshot to the rows', !has('src/hooks/useTypeahead.tsx', 'mainLoopModelForSession') && has('src/hooks/useTypeahead.tsx', 'generateCommandSuggestions(input, commands)')],
  ['src/commands/status/mercuryStatus.tsx', "the session's served model (the command context) and the focused chat's id and title", has('src/commands/status/mercuryStatus.tsx', 'context.options.mainLoopModel') && has('src/commands/status/mercuryStatus.tsx', 'conversationIdHere()') && !has('src/commands/status/mercuryStatus.tsx', 'getMainLoopModel()')],
  ['src/commands/model/mercuryModel.tsx', 'the effort ladder, the window and the kept-model lines read the served model; the dead pin read is gone', has('src/commands/model/mercuryModel.tsx', 'const servedModel = focusedSeat !== null ? focusedSeat.effective') && has('src/commands/model/mercuryModel.tsx', 'contextFillView(messages, servedModel)') && !has('src/commands/model/mercuryModel.tsx', 'sessionPin ??')],
  ['src/components/mercury-ui/EffortChip.tsx', "the standing chip reads the seat's word first", has('src/components/mercury-ui/EffortChip.tsx', 'useFocusedServedEffort()')],
  ['src/components/DeckPane.tsx', "the deck's effort chip is fed the served model", has('src/components/DeckPane.tsx', 'useFocusedServedModel()')],
  ['src/components/Settings/Config.tsx', 'the main-loop rows read the served model first', has('src/components/Settings/Config.tsx', 'useFocusedServedModel()')],
  ['src/components/mercury-ui/parity/AccountView.tsx', 'the main-loop line reads the served model first', has('src/components/mercury-ui/parity/AccountView.tsx', 'useFocusedServedModel()')],
  ['src/components/SubModelPicker.tsx', 'the main model beside the sub-model rows is the served one', has('src/components/SubModelPicker.tsx', 'focusedSessionModelFacts()?.effective')],
  ['src/components/Feedback.tsx', "the report names the session's model", has('src/components/Feedback.tsx', 'focusedSessionModelFacts()?.effective')],
  ['src/services/engine-connector/daemonConnector.ts', 'the seat facts carry the pin and the effort word; the effort move pulses the model feed', !has('src/services/engine-connector/daemonConnector.ts', 'sessionPin: null') && has('src/services/engine-connector/daemonConnector.ts', 'effort: this.facts?.effort ?? this.record.effort ?? null') && has('src/services/engine-connector/daemonConnector.ts', 'prev.effort !== next.effort')],
  ['src/daemon/sessionSeat.ts', "the daemon publishes the record's effort word", has('src/daemon/sessionSeat.ts', "rec.effort !== undefined ? { effort: rec.effort }")],
]
for (const [file, what, ok] of censusRows) check(`${file}: ${what}`, ok)

section('§4 ONE SPELLING — the 1M suffix is the display owner\'s alone')
const suffixSpellers = SRC_FILES.filter(f => codeOnly(src(f)).includes('(1M context)'))
check('the only file spelling "(1M context)" in code is the display owner (model.ts)', suffixSpellers.length === 1 && suffixSpellers[0] === 'src/utils/model/model.ts', suffixSpellers.join(','))
check('the dead suffixed-row builders are gone from the picker rows', !has('src/utils/model/modelOptions.ts', 'suffixedOption(') && !has('src/utils/model/modelOptions.ts', 'getOpus48_1MOption'))

section('§5 THE GENERATION TABLE — one table per family, every reader derives')
const strings = getModelStrings()
const families = Object.keys(configs.FAMILY_GENERATIONS) as Array<keyof typeof configs.FAMILY_GENERATIONS>
check('the table names the four first-party families', families.sort().join(',') === 'fable,haiku,opus,sonnet', families.join(','))
for (const family of families) {
  const keys = configs.FAMILY_GENERATIONS[family]
  check(`${family}: every row is a catalogue key, newest first`, keys.length > 0 && keys.every(k => k in configs.ALL_MODEL_CONFIGS))
  for (const key of keys) {
    const id = strings[key]
    check(`${family}/${key}: a display name, a cost tier and a window`, model.renderModelName(id) !== id && MODEL_COSTS[model.getCanonicalName(id)] !== undefined && getContextWindowForModel(id) > 0, `${id}: name=${model.renderModelName(id)} cost=${String(MODEL_COSTS[model.getCanonicalName(id)] !== undefined)} window=${getContextWindowForModel(id)}`)
  }
}
const head = (family: keyof typeof configs.FAMILY_GENERATIONS): string => strings[configs.newestGenerationKey(family)]
check('the family defaults derive from the table heads (no env pins set)',
  model.getDefaultFableModel() === head('fable') && model.getDefaultOpusModel() === head('opus') && model.getDefaultSonnetModel() === head('sonnet') && model.getDefaultHaikuModel() === head('haiku'),
  [model.getDefaultFableModel(), model.getDefaultOpusModel(), model.getDefaultSonnetModel(), model.getDefaultHaikuModel()].join(','))
check('the family words resolve to the table heads', model.parseUserSpecifiedModel('fable') === head('fable') && model.parseUserSpecifiedModel('opus') === head('opus') && model.parseUserSpecifiedModel('sonnet') === head('sonnet') && model.parseUserSpecifiedModel('haiku') === head('haiku'))
check('the frontier family\'s newest is the 5.1 row (the operator\'s word: the catalogue names the newest)', head('fable') === strings.fable51, head('fable'))
const facts = frontier.gatherFrontierFacts()
check('the frontier candidate is the table head', facts.fableId === head('fable'), facts.fableId)
const eligible = { ...facts, fableEnvPin: false, allowlistPresent: false, allowlistNamesFable: false, claudeAiSubscriber: true, maxSubscriber: true, rateLimitTier: frontier.FRONTIER_MAX_20X_TIER, oneMDisabled: false }
const decision = frontier.evaluateFrontierDecision(eligible)
check("a natively-1M frontier head wins as its bare id (no '[1m]' rider)", decision.source === 'frontier' && decision.setting === head('fable') && facts.fableNatively1M === true, `${decision.setting} natively1M=${String(facts.fableNatively1M)}`)
const suffixRow = frontier.evaluateFrontierDecision({ ...eligible, fableNatively1M: false })
check("a suffix-1M row would keep its '[1m]' rider (parity for the older shape)", suffixRow.setting === `${head('fable')}[1m]`, suffixRow.setting)
check('the crew tiers derive: the family word is the head; the exact-generation key is its synonym while newest', CREW_MODEL_CHOICES.fable.model === head('fable') && CREW_MODEL_CHOICES.opus.model === head('opus') && CREW_MODEL_CHOICES.sonnet.model === head('sonnet') && CREW_MODEL_CHOICES.fable51.model === CREW_MODEL_CHOICES.fable.model)
const routed = resolveAnthropicModel('fable', 'adaptive')
check("the router's fable class runs the head in its seat form (bare when natively 1M)", routed !== null && routed.model === (getContextWindowForModel(head('fable')) >= 1_000_000 ? head('fable') : `${head('fable')}[1m]`), String(routed?.model))
const options = getModelOptions()
check("the picker carries the family alias row labelled with the head's display name", options.some(o => o.value === 'fable' && o.label === model.renderModelName(head('fable'))), options.filter(o => o.value === 'fable').map(o => o.label).join(','))
check('the picker carries a literal row per previous frontier generation', configs.previousGenerationKeys('fable').every(k => options.some(o => o.value === strings[k])), configs.previousGenerationKeys('fable').map(k => strings[k]).join(','))
check('the picker carries the previous large generations from the table', configs.previousGenerationKeys('opus').every(k => options.some(o => o.value === strings[k])))
const defaultsBody = src('src/utils/model/model.ts').match(/export function getDefault(Opus|Sonnet|Haiku|Fable)Model\(\)[\s\S]*?\n}/g) ?? []
check('the four family defaults spell no table key (they read the table)', defaultsBody.length === 4 && defaultsBody.every(b => !/firstPartyString\('/.test(b)))
check('the picker rows spell no generation (no literal previous-key list, no literal frontier row)', !has('src/utils/model/modelOptions.ts', 'PREVIOUS_LARGE_KEYS') && !has('src/utils/model/modelOptions.ts', 'getFable51Option') && !has('src/utils/model/modelOptions.ts', "strings.fable51"))
check("the router's class defaults spell no id", !/'claude-[a-z0-9-]+(\[1m\])?'/.test(codeOnly(src('src/utils/router/providers/anthropic.ts')).split('function classDefaultModel')[1]?.split('\n}')[0] ?? "'claude-x'"))
check('the crew tiers spell no id', !/model: 'claude-/.test(codeOnly(src('src/daemon/crewSpawn.ts'))))
check('the frontier policy spells no generation in code', !/Fable 5/.test(codeOnly(src('src/utils/model/frontierPolicy.ts'))))
const DISPLAY_OWNERS = new Set(['src/utils/model/model.ts', 'src/services/providers/openai/gptPins.ts', 'src/substrate/flagRegistry.ts'])
const strayDisplay = SRC_FILES.filter(f => !DISPLAY_OWNERS.has(f)).filter(f => {
  const code = codeOnly(src(f))
  return /['"`]Fable 5(\.1)?['"` (]/.test(code) || GPT_DISPLAY_PINS.some(p => code.includes(`'${p.displayName}'`) || code.includes(`"${p.displayName}"`))
})
check('no other file spells a first-party or GPT display name in code (the display owners and the flag registry\'s summaries excepted)', strayDisplay.length === 0, strayDisplay.join(','))
check("the OpenAI family's display names come from the pins table", gptDisplayName('gpt-5.5') === 'GPT-5.5' && gptDisplayName('gpt-5.6-sol') === 'GPT-5.6 Sol')
check("the OpenAI family's newest derives live (no GPT id literal in the seat roster owner)", !/gpt-5\./.test(codeOnly(src('src/services/concourse/workerModels.ts'))))

section('§6 THE STALE CLAIMS — the frontier row named through the table')
const headName = model.renderModelName(head('fable'))
check('the statusline preview names the frontier row through the catalogue', has('src/components/MercuryStatusline.tsx', "parseUserSpecifiedModel('fable')") && !has('src/components/MercuryStatusline.tsx', "Fable 5"))
check('the agents preview names its tiers through the catalogue', has('src/components/MercuryAgents.tsx', "tier('fable')") && !has('src/components/MercuryAgents.tsx', "'Fable 5'"))
for (const doc of ['src/skills/bundled/provider-apis/references/models.md', 'mercury-skills/provider-apis/references/models.md']) {
  check(`${doc}: the frontier row is the table head (${headName})`, has(doc, `(${headName}, the frontier row)`) && !has(doc, '(Fable 5, the frontier row)'))
}

console.log(failures === 0 ? '\nprove-surface-truth: ALL LAWS HOLD' : `\nprove-surface-truth: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
