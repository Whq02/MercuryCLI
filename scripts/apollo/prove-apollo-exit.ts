#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const src = (...p: string[]) => readFileSync(join(REPO, 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Apollo Mode — the one door and the mode-transition record')
console.log('============================================================')

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const record = (await import('../../src/utils/permissions/modeTransitions.js')) as typeof import('../../src/utils/permissions/modeTransitions.js')
const {
  MODE_TRANSITION_ROADS,
  auditModeChange,
  bootModeTransition,
  clearModeTransitions,
  describeModeRoad,
  holdModeTransition,
  lastModeTransitionFrom,
  modeTransitions,
  recordModeTransition,
} = record

type Ctx = {
  mode: string
  additionalWorkingDirectories: Map<string, unknown>
  alwaysAllowRules: Record<string, string[]>
  alwaysDenyRules: Record<string, string[]>
  alwaysAskRules: Record<string, string[]>
  isBypassPermissionsModeAvailable: boolean
}
const ctx = (mode: string, bypass = false): Ctx => ({
  mode,
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: bypass,
})
const last = () => modeTransitions()[modeTransitions().length - 1]

section('the record: the road vocabulary, the announce/audit mechanics, the boot entry')
{
  const roads = MODE_TRANSITION_ROADS as readonly string[]
  for (const road of ['boot', 'claim', 'control-door', 'carousel', 'screen-mirror', 'review-approval', 'permission-answer', 'plan-entry', 'plan-exit', 'flow-unavailable', 'bypass-disabled', 'crew-lead', 'unnamed']) {
    check(`the vocabulary names the '${road}' road`, roads.includes(road))
  }
  for (const road of roads) {
    const words = describeModeRoad(road as never)
    check(`'${road}' has plain words`, typeof words === 'string' && words.length > 8 && !/\/mode\b/.test(words), words)
  }

  clearModeTransitions()
  check('a fresh record is empty', modeTransitions().length === 0)
  recordModeTransition({ from: null, to: 'flow', road: 'boot' })
  check('the boot entry is the first record (from null)', bootModeTransition()?.to === 'flow' && bootModeTransition()?.from === null)
  recordModeTransition({ from: 'flow', to: 'apollo', road: 'control-door' })
  const audited = auditModeChange('flow', 'apollo')
  check('the relay consumes the announcement that names the observed change', audited.road === 'control-door' && modeTransitions().length === 2)
  const unnamed = auditModeChange('apollo', 'implement')
  check("a change no writer announced lands as 'unnamed'", unnamed.road === 'unnamed' && last()?.road === 'unnamed' && last()?.from === 'apollo' && last()?.to === 'implement')
  recordModeTransition({ from: 'implement', to: 'apollo', road: 'control-door' })
  auditModeChange('implement', 'apollo')
  const held = holdModeTransition({ from: 'apollo', to: 'sovereign', road: 'permission-answer', detail: 'refused' })
  check('a held entry records the attempt and moves nothing', held.held === true && last()?.held === true)
  check('lastModeTransitionFrom skips held entries (the latest APPLIED exit)', lastModeTransitionFrom('apollo')?.road === 'unnamed' && lastModeTransitionFrom('apollo')?.to === 'implement')
  const stale = auditModeChange('apollo', 'default')
  check('a held entry never satisfies the audit (the relay saw a change it did not announce)', stale.road === 'unnamed')
  recordModeTransition({ from: 'default', to: 'flow', road: 'control-door' })
  const mismatch = auditModeChange('default', 'implement')
  check('an announcement that names a DIFFERENT change is not consumed (unnamed, not misattributed)', mismatch.road === 'unnamed')
  clearModeTransitions()
  for (let i = 0; i < 230; i++) holdModeTransition({ from: 'default', to: 'implement', road: 'carousel' })
  check('the record is bounded (the oldest entries roll off)', modeTransitions().length === 200)
  check('the boot entry is absent from a fresh record', bootModeTransition() === undefined)
}

section('every road names itself: the setter, the doors, a consent answer, the plan tools, the gates, the relay')
try {
  const setup = (await import('../../src/utils/permissions/permissionSetup.js')) as typeof import('../../src/utils/permissions/permissionSetup.js')
  const apply = (state: { ctx: Ctx }) => (updater: (c: never) => never) => {
    state.ctx = updater(state.ctx as never) as never
  }

  clearModeTransitions()
  const s1 = { ctx: ctx('apollo') }
  const r1 = setup.setPermissionModeWithGuards('implement' as never, s1.ctx as never, apply(s1) as never, 'review-approval')
  check("the guarded setter records the caller's road (review-approval: apollo → implement)", r1.ok && s1.ctx.mode === 'implement' && last()?.road === 'review-approval' && last()?.from === 'apollo' && last()?.to === 'implement')
  const s2 = { ctx: ctx('default') }
  setup.setPermissionModeWithGuards('implement' as never, s2.ctx as never, apply(s2) as never)
  check("the guarded setter's default road is the carousel", last()?.road === 'carousel')
  const s3 = { ctx: ctx('default') }
  const refused = setup.setPermissionModeWithGuards('sovereign' as never, s3.ctx as never, apply(s3) as never, 'crew-lead')
  check('a refused entry is HELD under its road with the refusal words', !refused.ok && s3.ctx.mode === 'default' && last()?.held === true && last()?.road === 'crew-lead' && /dangerously-skip-permissions/.test(last()?.detail ?? ''))
  const s4 = { ctx: ctx('implement') }
  setup.setPermissionModeWithGuards('implement' as never, s4.ctx as never, apply(s4) as never)
  check('a same-mode set records nothing', last()?.road === 'crew-lead')

  clearModeTransitions()
  const killed = setup.createDisabledBypassPermissionsContext(ctx('sovereign', true) as never) as unknown as Ctx
  check("the bypass kill records 'bypass-disabled' (sovereign → default)", killed.mode === 'default' && last()?.road === 'bypass-disabled')
  const untouched = setup.createDisabledBypassPermissionsContext(ctx('default') as never) as unknown as Ctx
  check('the bypass kill on a non-bypass posture records nothing', untouched.mode === 'default' && modeTransitions().length === 1)

  const control = (await import('../../src/cli/headless/controlHandlers.js')) as typeof import('../../src/cli/headless/controlHandlers.js')
  clearModeTransitions()
  const door = control.resolvePermissionModeTransition('implement' as never, ctx('apollo') as never)
  check("the control door records 'control-door' by default (apollo → implement)", door.ok && last()?.road === 'control-door' && last()?.from === 'apollo')
  const claim = control.resolvePermissionModeTransition('default' as never, ctx('flow') as never, 'claim')
  check("the claim names its road ('claim': flow → default)", claim.ok && last()?.road === 'claim')
  const doorRefused = control.resolvePermissionModeTransition('sovereign' as never, ctx('default') as never)
  check('a refused door entry is HELD with the refusal words', !doorRefused.ok && last()?.held === true && last()?.road === 'control-door' && /dangerously-skip-permissions/.test(last()?.detail ?? ''))
  const same = control.resolvePermissionModeTransition('default' as never, ctx('default') as never)
  check('a same-mode door call records nothing', same.ok && modeTransitions().length === 3)

  const updates = (await import('../../src/utils/permissions/PermissionUpdate.js')) as typeof import('../../src/utils/permissions/PermissionUpdate.js')
  clearModeTransitions()
  const answered = updates.applyPermissionUpdates(ctx('default') as never, [{ type: 'setMode', mode: 'implement', destination: 'session' } as never]) as unknown as Ctx
  check("a consent answer's setMode records 'permission-answer' with its scope", answered.mode === 'implement' && last()?.road === 'permission-answer' && /session scope/.test(last()?.detail ?? ''))
  const planned = updates.applyPermissionUpdate(ctx('default') as never, { type: 'setMode', mode: 'strategy', destination: 'session' } as never, 'plan-entry') as unknown as Ctx
  check("the caller may name the road (/plan: 'plan-entry')", planned.mode === 'strategy' && last()?.road === 'plan-entry')
  const folded = updates.applyPermissionUpdates(ctx('default') as never, [
    { type: 'addDirectories', directories: ['/tmp/x'], destination: 'session' } as never,
    { type: 'setMode', mode: 'implement', destination: 'session' } as never,
  ]) as unknown as Ctx
  check('the fold threads the road (never the reduce index)', folded.mode === 'implement' && last()?.road === 'permission-answer' && folded.additionalWorkingDirectories.size === 1)
} catch (e) {
  check('the road owners are loadable', false, String(e).split('\n')[0])
}
{
  check("EnterPlanMode records 'plan-entry' where it writes strategy", /recordModeTransition\(\{ from: prev\.toolPermissionContext\.mode, to: 'strategy', road: 'plan-entry' \}\)/.test(src('tools', 'EnterPlanModeTool', 'EnterPlanModeTool.ts')))
  check("ExitPlanMode records 'plan-exit' where it restores the stashed mode", /road: 'plan-exit'/.test(src('tools', 'ExitPlanModeTool', 'ExitPlanModeV2Tool.ts')))
  check("/plan names 'plan-entry' through the update applier", /'plan-entry',\n\s*\),/.test(src('commands', 'plan', 'plan.tsx')))
  check("the flow gate's kick-out records 'flow-unavailable'", /recordModeTransition\(\{ from: 'flow', to: 'default', road: 'flow-unavailable' \}\)/.test(src('utils', 'permissions', 'permissionSetup.ts')))
  check("the launch context records the 'boot' entry", /recordModeTransition\(\{ from: null, to: context\.mode, road: 'boot' \}\)/.test(src('utils', 'permissions', 'permissionSetup.ts')))
  check("the warm claim names 'claim'", /resolvePermissionModeTransition\(\n\s*claimedMode as WirePermissionMode,\n\s*getAppState\(\)\.toolPermissionContext,\n\s*'claim',/.test(src('cli', 'print.ts')))
  check("the team lead's two roads name 'crew-lead'", (src('hooks', 'useInboxPoller.ts').match(/'crew-lead',/g) ?? []).length === 2)
  check("the review card names 'review-approval'", /'review-approval',/.test(src('tools', 'ApolloReviewTool', 'ApolloReviewTool.tsx')))
  check('the app-state relay audits every observed mode change', /auditModeChange\(oldMode, newMode\)/.test(src('state', 'onChangeAppState.ts')))
  check("the screen's mirror names 'screen-mirror'", /road: 'screen-mirror'/.test(src('screens', 'REPL.tsx')))
}
try {
  const relay = (await import('../../src/state/onChangeAppState.js')) as typeof import('../../src/state/onChangeAppState.js')
  const base = { mainLoopModel: null, verbose: false, expandedView: false, isUltraplanMode: false, settings: {} }
  clearModeTransitions()
  relay.onChangeAppState({ newState: { ...base, toolPermissionContext: ctx('implement') } as never, oldState: { ...base, toolPermissionContext: ctx('apollo') } as never })
  check("the relay records a change nobody announced as 'unnamed'", last()?.road === 'unnamed' && last()?.from === 'apollo' && last()?.to === 'implement')
  clearModeTransitions()
  recordModeTransition({ from: 'apollo', to: 'implement', road: 'review-approval' })
  relay.onChangeAppState({ newState: { ...base, toolPermissionContext: ctx('implement') } as never, oldState: { ...base, toolPermissionContext: ctx('apollo') } as never })
  check('the relay consumes an announced change (no unnamed entry beside it)', modeTransitions().length === 1 && last()?.road === 'review-approval')
} catch (e) {
  console.log(`  [info] the relay is not loadable under bun-run (${String(e).split('\n')[0]}) — the structural pin above stands`)
}

section('the one door: the ladder admits the spec directory, refuses every other write; no consent tier moves the mode')
const WORLD = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-apollo-door-')))
try {
  const state = (await import('../../src/bootstrap/state.js')) as typeof import('../../src/bootstrap/state.js')
  const fs = (await import('../../src/utils/permissions/filesystem.js')) as typeof import('../../src/utils/permissions/filesystem.js')
  const config = (await import('../../src/utils/projectConfig.js')) as typeof import('../../src/utils/projectConfig.js')
  mkdirSync(join(WORLD, 'docs'), { recursive: true })
  state.setOriginalCwd(WORLD)
  const shim = { name: 'Write', getPath: (i: { file_path: string }) => i.file_path } as unknown as Parameters<typeof fs.checkWritePermissionForTool>[0]
  const specDir = config.apolloSpecDirectory(WORLD)
  const specPath = join(specDir, 'spec.md')
  const strayPath = join(WORLD, 'docs', 'notes.md')
  const decide = (mode: string, path: string) => fs.checkWritePermissionForTool(shim, { file_path: path }, ctx(mode) as never) as unknown as { behavior: string; message?: string; decisionReason?: { type: string; mode?: string }; suggestions?: Array<{ type: string; mode?: string }> }

  const spec = decide('apollo', specPath)
  check("apollo: a spec-directory write is ALLOWED on the mode's consent", spec.behavior === 'allow' && spec.decisionReason?.type === 'mode' && spec.decisionReason.mode === 'apollo', `${spec.behavior} ${JSON.stringify(spec.decisionReason)}`)
  const stray = decide('apollo', strayPath)
  check('apollo: a write outside the spec directory is REFUSED (deny, never ask)', stray.behavior === 'deny', stray.behavior)
  check("the refusal speaks the mode's words: the path, the spec directory, the review tool", /Apollo Mode refused writing/.test(stray.message ?? '') && (stray.message ?? '').includes(strayPath) && (stray.message ?? '').includes(specDir) && /ApolloReview/.test(stray.message ?? ''), stray.message)
  check('the refusal names Apollo Mode as its reason', stray.decisionReason?.type === 'mode' && stray.decisionReason.mode === 'apollo')
  check('the ladder owns the refusal sentence (one owner, exported)', fs.apolloWriteRefusal(strayPath) === stray.message)
  const settingsPath = join(WORLD, '.mercury', 'settings.json')
  check('apollo: a settings write is refused too (outside the spec directory)', decide('apollo', settingsPath).behavior === 'deny')
  const asked = decide('default', strayPath)
  check('default: the same write ASKS and its session tier still offers implement (the ask-posture modes keep it)', asked.behavior === 'ask' && (asked.suggestions ?? []).some(s => s.type === 'setMode' && s.mode === 'implement'), `${asked.behavior} ${JSON.stringify(asked.suggestions)}`)
  const asIs = decide('strategy', strayPath)
  check('strategy: unchanged (asks with the implement tier)', asIs.behavior === 'ask' && (asIs.suggestions ?? []).some(s => s.type === 'setMode'))
  const implementSpec = decide('implement', specPath)
  check("implement: the build posture still rides the spec consent", implementSpec.behavior === 'allow')
  check('the session tier never offers a mode change in Apollo (structural: modeSuggestion lists the two ask-posture modes only)', /if \(context\.mode === 'default' \|\| context\.mode === 'strategy'\) \{\n\s*return \[\{ type: 'setMode', mode: 'implement'/.test(src('utils', 'permissions', 'filesystem.ts')))

  const updates = (await import('../../src/utils/permissions/PermissionUpdate.js')) as typeof import('../../src/utils/permissions/PermissionUpdate.js')
  clearModeTransitions()
  const heldOut = updates.applyPermissionUpdates(ctx('apollo') as never, [{ type: 'setMode', mode: 'implement', destination: 'session' } as never]) as unknown as Ctx
  check("apollo: a consent answer's setMode is HELD — the mode stays apollo", heldOut.mode === 'apollo' && last()?.held === true && last()?.road === 'permission-answer' && /review card/.test(last()?.detail ?? ''))
  const mixed = updates.applyPermissionUpdates(ctx('apollo') as never, [
    { type: 'addDirectories', directories: [join(WORLD, 'docs')], destination: 'session' } as never,
    { type: 'setMode', mode: 'default', destination: 'session' } as never,
  ]) as unknown as Ctx
  check("the rest of the answer still applies (the directory grant lands, the mode holds)", mixed.mode === 'apollo' && mixed.additionalWorkingDirectories.size === 1)
  const toPlan = updates.applyPermissionUpdates(ctx('apollo') as never, [{ type: 'setMode', mode: 'strategy', destination: 'session' } as never]) as unknown as Ctx
  check('strategy is admitted from apollo (plan entry stashes the mode; its exit restores it)', toPlan.mode === 'strategy' && last()?.held !== true && last()?.road === 'permission-answer')
  const byHook = updates.applyPermissionUpdate(ctx('apollo') as never, { type: 'setMode', mode: 'sovereign', destination: 'session' } as never) as unknown as Ctx
  check('a hook or host answer cannot leave apollo either (the hold is at the ONE apply seam)', byHook.mode === 'apollo')
  const stays = updates.applyPermissionUpdates(ctx('implement') as never, [{ type: 'setMode', mode: 'default', destination: 'session' } as never]) as unknown as Ctx
  check('outside apollo a setMode applies as before', stays.mode === 'default')
} catch (e) {
  check('the ladder and the update applier are loadable', false, String(e).split('\n')[0])
} finally {
  rmSync(WORLD, { recursive: true, force: true })
}

section('the words: ApolloReview names what ended the station; the pack exit row and the pack agree')
try {
  const { ApolloReviewTool, apolloReviewRefusal } = (await import('../../src/tools/ApolloReviewTool/ApolloReviewTool.js')) as typeof import('../../src/tools/ApolloReviewTool/ApolloReviewTool.js')
  const mkContext = (mode: string) => {
    let state = { toolPermissionContext: ctx(mode) }
    return {
      agentId: undefined,
      getAppState: () => state as never,
      setAppState: (updater: (prev: typeof state) => typeof state) => {
        state = updater(state)
      },
      options: { tools: [] },
    }
  }
  const input = { summary: 's', blockers: [], specFiles: [] } as never

  clearModeTransitions()
  recordModeTransition({ from: null, to: 'apollo', road: 'boot' })
  recordModeTransition({ from: 'apollo', to: 'implement', road: 'permission-answer', detail: 'setMode at the session scope' })
  const ended = await ApolloReviewTool.validateInput!(input, mkContext('implement') as never)
  const endedMessage = ended.result === false ? ended.message : ''
  check('outside Apollo after a recorded exit: refused', ended.result === false)
  check('…and the refusal names the ROAD that ended the station', /Apollo Mode ended before this review/.test(endedMessage) && /a consent answer's mode change/.test(endedMessage), endedMessage)
  check('…the destination, the detail, and the way back (shift+tab)', /moved the session to Implement Mode/.test(endedMessage) && /session scope/.test(endedMessage) && /shift\+tab/.test(endedMessage))
  check('…never the bare old sentence', !/^This session is not in Apollo Mode\. ApolloReview exists solely/.test(endedMessage))

  clearModeTransitions()
  recordModeTransition({ from: null, to: 'flow', road: 'boot' })
  const never = await ApolloReviewTool.validateInput!(input, mkContext('flow') as never)
  const neverMessage = never.result === false ? never.message : ''
  check('outside Apollo with no exit recorded: the refusal says the runner never entered it, naming its start', /never entered Apollo Mode/.test(neverMessage) && /started in Flow/.test(neverMessage) && /it is in Flow/.test(neverMessage), neverMessage)
  clearModeTransitions()
  check('…and without a boot entry it still says so plainly', /never entered Apollo Mode/.test(apolloReviewRefusal('default' as never)) && /Default/.test(apolloReviewRefusal('default' as never)))

  clearModeTransitions()
  recordModeTransition({ from: 'apollo', to: 'implement', road: 'control-door' })
  recordModeTransition({ from: 'implement', to: 'apollo', road: 'control-door' })
  const back = await ApolloReviewTool.validateInput!(input, mkContext('apollo') as never)
  check('in Apollo Mode the review is accepted whatever the record holds', back.result === true)

  clearModeTransitions()
  recordModeTransition({ from: 'apollo', to: 'default', road: 'permission-answer' })
  recordModeTransition({ from: 'default', to: 'apollo', road: 'control-door' })
  recordModeTransition({ from: 'apollo', to: 'flow', road: 'review-approval' })
  const second = await ApolloReviewTool.validateInput!(input, mkContext('flow') as never)
  check('the latest exit is the one named', second.result === false && /review card's approval/.test(second.message) && /moved the session to Flow/.test(second.message))

  const lifecycles = (await import('../../src/utils/attachments/modeLifecycles.js')) as typeof import('../../src/utils/attachments/modeLifecycles.js')
  clearModeTransitions()
  recordModeTransition({ from: 'apollo', to: 'implement', road: 'permission-answer', detail: 'setMode at the session scope' })
  const packRow = { type: 'attachment', attachment: { type: 'mode_pack', mode: 'apollo', text: 'the pack' } } as never
  const exitRows = lifecycles.getModePackAttachments([packRow], mkContext('implement') as never) as Array<{ type: string; mode?: string; reason?: string }>
  const exitRow = exitRows.find(row => row.type === 'mode_pack_exit')
  check('leaving apollo emits ONE exit row carrying the reason (the road and the destination)', exitRows.length === 1 && exitRow?.mode === 'apollo' && /a consent answer's mode change/.test(exitRow?.reason ?? '') && /Implement Mode/.test(exitRow?.reason ?? ''), JSON.stringify(exitRows))
  clearModeTransitions()
  const bareRows = lifecycles.getModePackAttachments([packRow], mkContext('implement') as never) as Array<{ type: string; reason?: string }>
  check('with no recorded exit the row carries no reason (never a made-up one)', bareRows.length === 1 && bareRows[0]?.reason === undefined)
  const text = (await import('../../src/utils/messages/attachmentText.js')) as typeof import('../../src/utils/messages/attachmentText.js')
  const spoken = text.normalizeAttachmentForAPI({ type: 'mode_pack_exit', mode: 'apollo', reason: 'the review card moved the session to Flow' } as never)
  const spokenText = JSON.stringify(spoken.map(m => m.message.content))
  check('the reminder speaks the reason to the model', /Exited Apollo mode/.test(spokenText) && /What ended it: the review card moved the session to Flow\./.test(spokenText), spokenText.slice(0, 300))
  const silent = JSON.stringify(text.normalizeAttachmentForAPI({ type: 'mode_pack_exit', mode: 'apollo' } as never).map(m => m.message.content))
  check('a row without a reason renders as before', /Exited Apollo mode/.test(silent) && !/What ended it/.test(silent))

  const pack = (await import('../../src/prompt/apolloMode.js')) as typeof import('../../src/prompt/apolloMode.js')
  const packText = pack.getApolloModeSections('apollo')[0] ?? ''
  check('the pack names the admitted writes (the file tools, the spec directory) and the refusal', /Use the file tools \(Write, Edit\) for those files only/.test(packText) && /a write anywhere else is refused by the mode/.test(packText))
  check('the pack still teaches the only-door law', /only door to the build/.test(packText))
} catch (e) {
  check('the word owners are loadable', false, String(e).split('\n')[0])
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-apollo-exit: ${failures} failure${failures === 1 ? '' : 's'}`)
process.exit(failures === 0 ? 0 : 1)
