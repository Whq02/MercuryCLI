#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'birth-landing-words-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SKIP_PERMISSIONS
delete process.env.MERCURY_DAEMON_PERMISSION_MODE

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const facts = await import('../../src/services/switchboard/bootBirthFacts.js')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const slot = await import('../../src/services/engine-connector/focusedConnector.js')
const { permissionModeOf } = await import('../../src/services/engine-connector/daemonConnector.js')
const { getMainLoopModel } = await import('../../src/utils/model/model.js')
const { bornEffortValueOf, focusedEffortLabelOf } = await import('../../src/components/mercury-ui/EffortChip.js')

console.log('R1 the record: the landing words are armed by a door and settled when the landing ends')
{
  facts._resetBootBirthFactsForTesting()
  check('a fresh record carries no landing', facts.bootBirthFacts().landing === null)
  facts.armLandingWords({ model: 'claude-sonnet-5', effort: 'max', permissionMode: 'sovereign' })
  const landing = facts.bootBirthFacts().landing
  check('the armed words are the model, the effort and the posture the door sent', landing !== null && landing.model === 'claude-sonnet-5' && landing.effort === 'max' && landing.permissionMode === 'sovereign', JSON.stringify(landing))
  facts.settleLandingWords()
  check('the settle clears them', facts.bootBirthFacts().landing === null)
  facts.settleLandingWords()
  check('a second settle is a no-op', facts.bootBirthFacts().landing === null)
  facts.armLandingWords({ model: null, effort: null, permissionMode: 'default' })
  const sticky = facts.bootBirthFacts()
  check('arming the landing leaves the sticky fields alone (the menu model, the launch effort, the boot posture)', sticky.model === null && sticky.effort === null && sticky.permissionMode === null && sticky.landing !== null)
  facts._resetBootBirthFactsForTesting()
  check('the reset clears the landing too', facts.bootBirthFacts().landing === null)
}

console.log('R2 the pure read: a birth without a word stays blank; a landing reads its words verbatim')
{
  const none = facts.landingWordsOf({ landing: null })
  check('no landing: three nulls', none.model === null && none.effort === null && none.permissionMode === null)
  const blank = facts.landingWordsOf({ landing: { model: null, effort: null, permissionMode: null } })
  check('a landing that resolved no word: three nulls (the surface keeps its blank)', blank.model === null && blank.effort === null && blank.permissionMode === null)
  const sovereign = facts.landingWordsOf({ landing: { model: 'claude-sonnet-5', effort: 'max', permissionMode: 'sovereign' } })
  check('a born-sovereign landing reads sovereign, the model and the effort verbatim', sovereign.model === 'claude-sonnet-5' && sovereign.effort === 'max' && sovereign.permissionMode === 'sovereign', JSON.stringify(sovereign))
  const dflt = facts.landingWordsOf({ landing: { model: 'claude-opus-5', effort: null, permissionMode: 'default' } })
  check('a default posture reads default (the chip owner paints nothing for it)', dflt.permissionMode === 'default' && dflt.effort === null && dflt.model === 'claude-opus-5', JSON.stringify(dflt))
  const seam = (await import('node:fs')).readFileSync(new URL('../../src/services/switchboard/bootBirthFacts.ts', import.meta.url), 'utf8').replace(/^import type .*$/gm, '')
  check('the record stays a plain record: no daemon, no connector, no RPC on its runtime lines (the resting connector maps the posture)', !seam.includes('daemon/') && !seam.includes('engine-connector') && !seam.includes('daemonControlRpc'))
}

console.log('R3 the resting connector: the landing words while a birth lands, the screen\'s own words otherwise')
{
  facts._resetBootBirthFactsForTesting()
  const resting = new NoSessionConnector()
  const own = resting.modelFacts()
  check('at rest the model is the screen\'s main model, no effort word, no mode', own.main === getMainLoopModel() && own.effort === undefined && resting.permissionMode() === null, JSON.stringify({ main: own.main, effort: own.effort, mode: resting.permissionMode() }))
  check('at rest the facts answer a stable snapshot', resting.modelFacts() === own)
  facts.armLandingWords({ model: 'claude-sonnet-5', effort: 'max', permissionMode: 'sovereign' })
  const landing = resting.modelFacts()
  check('while a born-sovereign birth lands: the born model, the born effort and the born posture through the seat\'s own mapping', landing.main === 'claude-sonnet-5' && landing.effective === 'claude-sonnet-5' && landing.effort === 'max' && resting.permissionMode() === 'sovereign', JSON.stringify({ main: landing.main, effort: landing.effort, mode: resting.permissionMode() }))
  check('the landing facts answer a stable snapshot too', resting.modelFacts() === landing)
  check('the resting connector still owns no session and refuses a send', resting.sessionId() === '' && (await resting.sendWords('x' as never)).state === 'refused')
  facts.armLandingWords({ model: null, effort: null, permissionMode: null })
  const unresolved = resting.modelFacts()
  check('a landing without words: the screen\'s main model, no effort word, no mode', unresolved.main === getMainLoopModel() && unresolved.effort === undefined && resting.permissionMode() === null)
  facts.armLandingWords({ model: 'claude-sonnet-5', effort: 'max', permissionMode: 'sovereign' })
  slot._resetFocusedSessionConnectorForTesting()
  slot.setFocusedSessionConnector(resting)
  check('the slot\'s re-point settles the landing words', facts.bootBirthFacts().landing === null && resting.permissionMode() === null && resting.modelFacts().main === getMainLoopModel())
  slot._resetFocusedSessionConnectorForTesting()
  facts._resetBootBirthFactsForTesting()
}

console.log('R4 the precedence: the runner\'s own facts outrank the birth; a birth without a word stays blank')
{
  check('spoken default over a sovereign birth reads default', permissionModeOf({ permissionMode: 'default' }, { permissionMode: 'sovereign' }) === 'default')
  check('spoken sovereign over a default birth reads sovereign', permissionModeOf({ permissionMode: 'sovereign' }, { permissionMode: 'default' }) === 'sovereign')
  check('unspoken: the birth\'s posture', permissionModeOf(null, { permissionMode: 'sovereign' }) === 'sovereign')
  check('unspoken and a birth without a posture: null', permissionModeOf(null, { permissionMode: null }) === null)
}

console.log('R5 the effort chip: the born word stands plain while no seat holds the slot; a seat\'s word outranks it')
{
  const model = 'claude-opus-5'
  check('born max, no seat word: max', bornEffortValueOf(null, 'max') === 'max' && focusedEffortLabelOf(model, null, undefined, undefined, 'max') === 'max')
  check('a seat word beside a born word: the seat\'s word, asked until its runner says', bornEffortValueOf('high', 'max') === undefined && focusedEffortLabelOf(model, 'high', undefined, undefined, 'max') === 'high (asked)')
  check('a seat word and the runner\'s sent word: the sent word', focusedEffortLabelOf(model, 'high', 'medium', undefined, 'max') === 'medium')
  check('no born word and no seat word: the born rung is silent', bornEffortValueOf(null, null) === undefined)
}

console.log('R6 the birth falls back to a signed-in family when the saved default cannot run; the saved default is untouched')
{
  const provider = (f: string): string => (f === 'anthropic' ? 'Anthropic' : f)
  const fallback = { setting: 'claude-fable-5-1', family: 'anthropic', row: 'Fable 5.1' }
  const absent = facts.birthFallbackModel('gemini', { family: 'gemini', familyWord: 'gemini', hasCredential: false, familyUsable: false, familyReason: null, fallback, providerName: provider })
  check('a saved default whose family holds no sign-in falls back with the no-sign-in receipt', absent !== undefined && absent.setting === 'claude-fable-5-1' && absent.receipt === '▲ the saved default gemini has no sign-in here — this chat runs on Fable 5.1 (Anthropic, the most recent sign-in); /logins gemini connects it, /model changes the default', absent?.receipt)
  const refused = facts.birthFallbackModel('gemini', { family: 'gemini', familyWord: 'gemini', hasCredential: true, familyUsable: false, familyReason: "the Google account's token was refused (HTTP 403) — /logins re-connects", fallback, providerName: provider })
  check('a present-but-refused credential falls back and carries the catalogue reason', refused !== undefined && refused.setting === 'claude-fable-5-1' && refused.receipt === "▲ the saved default gemini has no usable row: the Google account's token was refused (HTTP 403) — /logins re-connects. This chat runs on Fable 5.1 (Anthropic, the most recent sign-in); /model changes the default", refused?.receipt)
  check('a usable family is not swapped (no receipt)', facts.birthFallbackModel('claude-opus-5', { family: 'anthropic', familyWord: 'anthropic', hasCredential: true, familyUsable: true, familyReason: null, fallback, providerName: provider }) === undefined)
  check('a family that already IS the fallback is not swapped', facts.birthFallbackModel('claude-opus-5', { family: 'anthropic', familyWord: 'anthropic', hasCredential: true, familyUsable: false, familyReason: null, fallback, providerName: provider }) === undefined)
  check('no signed-in family: no fallback, the daemon refuses honestly', facts.birthFallbackModel('gemini', { family: 'gemini', familyWord: 'gemini', hasCredential: false, familyUsable: false, familyReason: null, fallback: null, providerName: provider }) === undefined)
  const readSrc = (rel: string): string => (require('node:fs') as typeof import('node:fs')).readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
  const door = readSrc('src/services/switchboard/bornSession.ts')
  check('the birth door drops the model on a keyless home, then wraps the resolved model in the signed-in fallback', door.includes('const resolved = screen === undefined ? undefined : birthModelOf(facts, req.model ?? null, screen)') && door.includes('const born = birthModelForSignedInFamily(resolved, facts.model === null && (req.model ?? null) === null)') && door.includes('const model = born.setting'))
  check("the fallback rides the saved-default road only (an explicit --model, MERCURY_MODEL or a door's inheritance keeps the daemon's own answer)", door.includes('if (getMainLoopModelOverride() !== undefined) return false') && door.includes('parseUserSpecifiedModel(saved) === resolved'))
  const mintAt = door.indexOf("if (fallbackNote !== null && fallbackNote !== '') mintOnBornChat(sessionId, fallbackNote)")
  const hopAt = door.indexOf('const hop = await hopIntoBoardSession(sessionId')
  check('the receipt is minted after the hop, on the born chat itself (a display row the chat keeps, never a notification on the resting slot)', mintAt !== -1 && hopAt !== -1 && mintAt > hopAt && door.includes('if (focused.sessionId() !== sessionId) return false'))
  check('the fallback never writes the saved default', !door.includes('persistModelChoice') && !door.includes('setBootBirthFacts') && !door.includes('updateSettingsForSource'))
}

console.log('R7 the one road from a /model pick to the next birth: the pick saves the default and sets the override the screen birth model reads (no chat open: the resting slot refuses, so the door is a chat)')
{
  const readSrc = (rel: string): string => (require('node:fs') as typeof import('node:fs')).readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
  const door = readSrc('src/services/switchboard/bornSession.ts')
  check("the resting slot's model door refuses (no chat open, nothing to switch)", (await new NoSessionConnector().setModel()).state === 'refused')
  const picker = readSrc('src/commands/model/mercuryModel.tsx')
  check("a pick on a chat's seat saves the default after the daemon's receipt (the road the fallback chat opens)", picker.includes('const saved = persistModelChoice(value)') && picker.includes("void focused.setModel(value).then(receipt => {"))
  const { settleModelSelection } = await import('../../src/utils/model/modelTransition.js')
  const settled = settleModelSelection({ mainLoopModel: 'gemini', mainLoopModelForSession: null, pendingModelSwitch: null, lastModelTransition: null } as never, 'claude-fable-5-1', { turnActive: false })
  check('the settle road applies the pick to the main-loop model at once when no turn runs', settled.kind === 'applied' && settled.patch !== null && (settled.patch as { mainLoopModel?: string }).mainLoopModel === 'claude-fable-5-1', JSON.stringify(settled))
  check('the screen birth model follows the main-loop override the pick sets', door.includes('screenBirthModel()') && readSrc('src/services/switchboard/bootBirthFacts.ts').includes('if (getMainLoopModelOverride() !== undefined) return getMainLoopModel()'))
}

console.log(failures === 0 ? '\nprove-birth-landing-words: ALL LAWS HOLD' : `\nprove-birth-landing-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
