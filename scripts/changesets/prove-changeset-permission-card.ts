#!/usr/bin/env bun
import { Buffer } from 'node:buffer'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.ts'

const HOME = pinScratchHome('changeset-perm-card-home')
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'changeset-perm-card-proj-')))
const CS_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'changeset-perm-card-cs-')))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CHANGESET_DIR = CS_DIR
process.chdir(PROJ)

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n── ${title} ──`)

const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/boot/process-state/processState.js')
setCwdState(PROJ)
setOriginalCwd(PROJ)
setProjectRoot(PROJ)

const { ChangeSetTool } = await import('../../src/tools/change-set/ChangeSetTool.js')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.js')
const { mintFileAnchor } = await import('../../src/tools/engines/change-transaction/snapshotAnchor.js')
const { CHANGESET_BOUNDS } = await import('../../src/tools/engines/change-transaction/changeSetContracts.js')
const {
  _resetChangeSetStoreForTesting,
  getChangeSetPlan,
  rememberChangeSetPlan,
} = await import('../../src/tools/engines/change-transaction/changeSetStore.js')
const { processMainOwner } = await import('../../src/engine/run-owner/resolveOwner.js')
const { PermissionRequest } = await import('../../src/permissions/cards/PermissionRequest.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const { AppStoreContext } = await import('../../src/screen/app-state/AppState.js')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.js')
const { createStore } = await import('../../src/platform/primitives/store.js')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.js')

const owner = processMainOwner()

const alphaPath = join(PROJ, 'alpha.ts')
const betaPath = join(PROJ, 'beta.ts')
const gammaPath = join(PROJ, 'gamma.ts')
const alphaBefore = 'export const alpha = "alpha-before"\nexport const alphaKeep = 1\n'
const betaBefore = 'export const beta = "beta-before"\nexport const betaKeep = 2\n'
const gammaBefore = 'export const gamma = "gamma-before"\nexport const gammaKeep = 3\n'
const alphaAfter = 'export const alpha = "alpha-after"\nexport const alphaKeep = 1\n'
const betaAfter = 'export const beta = "beta-after"\nexport const betaKeep = 2\n'
const gammaAfter = 'export const gamma = "gamma-after"\nexport const gammaKeep = 3\n'

function resetFixtures(): void {
  writeFileSync(alphaPath, alphaBefore)
  writeFileSync(betaPath, betaBefore)
  writeFileSync(gammaPath, gammaBefore)
}

function snapshotBytes(): Map<string, Buffer> {
  return new Map([
    [alphaPath, readFileSync(alphaPath)],
    [betaPath, readFileSync(betaPath)],
    [gammaPath, readFileSync(gammaPath)],
  ])
}

function bytesEqual(a: Map<string, Buffer>, b: Map<string, Buffer>): boolean {
  if (a.size !== b.size) return false
  for (const [path, buf] of a) {
    const other = b.get(path)
    if (!other || !buf.equals(other)) return false
  }
  return true
}

function makeContext() {
  const readFileState = new Map<string, { content: string; timestamp: number; offset: undefined; limit: undefined }>()
  for (const path of [alphaPath, betaPath, gammaPath]) {
    readFileState.set(path, {
      content: readFileSync(path, 'utf8'),
      timestamp: Date.now() + 60_000,
      offset: undefined,
      limit: undefined,
    })
  }
  const permCtx = getEmptyToolPermissionContext()
  return {
    owner,
    readFileState,
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    abortController: new AbortController(),
    options: { engineModel: 'fixture-model' },
    getAppState: () => ({ toolPermissionContext: permCtx }),
    setAppState: () => {},
  } as never
}

async function callChangeSet(input: Record<string, unknown>, ctx: ReturnType<typeof makeContext>) {
  return (await (ChangeSetTool as { call: Function }).call(input, ctx, null, {
    uuid: '00000000-0000-0000-0000-00000000cs01',
    message: { id: 'msg_cs_card' },
  })) as { data: { op: string; result: string; outcome: string; planId?: string } }
}

function threeFileChanges() {
  return [
    {
      file_path: alphaPath,
      expected_anchor: mintFileAnchor(alphaBefore),
      hunks: [{ lines: '1', replace: 'export const alpha = "alpha-after"' }],
    },
    {
      file_path: betaPath,
      expected_anchor: mintFileAnchor(betaBefore),
      hunks: [{ lines: '1', replace: 'export const beta = "beta-after"' }],
    },
    {
      file_path: gammaPath,
      expected_anchor: mintFileAnchor(gammaBefore),
      hunks: [{ lines: '1', replace: 'export const gamma = "gamma-after"' }],
    },
  ]
}

type CardRun = {
  allowed: Array<{ input: unknown; updates: unknown[]; feedback?: string }>
  confirmRejected: Array<string | undefined>
  cardRejected: number
  done: number
  frame: Awaited<ReturnType<typeof mountOffscreen>>
}

async function mountCard(
  input: Record<string, unknown>,
  ctx: ReturnType<typeof makeContext>,
  opts: {
    cols?: number
    rows?: number
    toolUseID?: string
    onAllowEffect?: () => void | Promise<void>
  } = {},
): Promise<CardRun> {
  const allowed: Array<{ input: unknown; updates: unknown[]; feedback?: string }> = []
  const confirmRejected: Array<string | undefined> = []
  let cardRejected = 0
  let done = 0
  const store = createStore(getDefaultAppState())
  const confirm = {
    tool: ChangeSetTool,
    input,
    description: 'Apply change set',
    toolUseContext: ctx,
    toolUseID: opts.toolUseID ?? 'toolu_cs_card',
    permissionResult: { behavior: 'ask' as const, message: 'Apply this change set?' },
    permissionPromptStartTimeMs: Date.now(),
    onUserInteraction() {},
    onAbort() {},
    async recheckPermission() {},
    onAllow(updatedInput: unknown, updates: unknown[], feedback?: string) {
      allowed.push({ input: updatedInput, updates, feedback })
      void opts.onAllowEffect?.()
    },
    onReject(feedback?: string) {
      confirmRejected.push(feedback)
    },
  }
  const tree = React.createElement(
    ThemeProvider,
    null,
    React.createElement(
      AppStoreContext.Provider,
      { value: store as never },
      React.createElement(
        KeybindingSetup,
        null,
        React.createElement(PermissionRequest, {
          toolUseConfirm: confirm as never,
          toolUseContext: ctx,
          onDone: () => {
            done++
          },
          onReject: () => {
            cardRejected++
          },
          verbose: false,
        }),
      ),
    ),
  )
  const frame = await mountOffscreen(tree, opts.cols ?? 120, opts.rows ?? 52)
  await waitFor(() => frame.screen().includes('Apply change set'), 3000)
  await settle(60)
  return {
    get allowed() {
      return allowed
    },
    get confirmRejected() {
      return confirmRejected
    },
    get cardRejected() {
      return cardRejected
    },
    get done() {
      return done
    },
    frame,
  }
}

try {
  resetFixtures()
  _resetChangeSetStoreForTesting()
  const ctx = makeContext()

  section('1. Three-file preview plan: checkPermissions asks and full diffs paint on the card')
  const previewRes = await callChangeSet({ op: 'preview', changes: threeFileChanges() }, ctx)
  const planId = previewRes.data.planId!
  check('preview minted a plan id', typeof planId === 'string' && planId.startsWith('cs-'), previewRes.data.result)
  const plan = getChangeSetPlan(owner, planId)
  check('stored plan exists for owner', plan !== undefined)

  const permDecision = await (ChangeSetTool as { checkPermissions: Function }).checkPermissions(
    { op: 'apply', plan_id: planId },
    ctx,
  )
  check('ChangeSetTool.checkPermissions asks for the 3-file apply', permDecision.behavior === 'ask', JSON.stringify(permDecision))

  const fullRun = await mountCard({ op: 'apply', plan_id: planId }, ctx, { cols: 120, rows: 52, toolUseID: 'cs-full' })
  try {
    const screen = fullRun.frame.screen()
    check('title paints Apply change set', screen.includes('Apply change set'), screen)
    check('summary names 3 files and 3 hunks', screen.includes('Apply this change set to 3 files (3 hunks)?'), screen)
    check('plan id and digest prefix paint', screen.includes(`plan ${planId}`) && screen.includes(`digest ${plan!.digest.slice(0, 12)}`), screen)
    check('alpha.ts header and diff lines paint', screen.includes('alpha.ts') && screen.includes('alpha-before') && screen.includes('alpha-after'), screen)
    check('beta.ts header and diff lines paint', screen.includes('beta.ts') && screen.includes('beta-before') && screen.includes('beta-after'), screen)
    check('gamma.ts header and diff lines paint', screen.includes('gamma.ts') && screen.includes('gamma-before') && screen.includes('gamma-after'), screen)
  } finally {
    fullRun.frame.unmount()
  }

  section('2. Bounded preview hides overflow and ctrl+f expands all three files')
  const compactRun = await mountCard({ op: 'apply', plan_id: planId }, ctx, { cols: 120, rows: 27, toolUseID: 'cs-compact' })
  try {
    const collapsed = compactRun.frame.screen()
    check('compact viewport hides remaining files with ctrl+f expand hint', collapsed.includes('ctrl+f expands') && !collapsed.includes('gamma-after'), collapsed)
    compactRun.frame.push('\x06')
    const expanded = await waitFor(() => compactRun.frame.screen().includes('ctrl+f collapses the preview'), 3000)
    const expandedScreen = compactRun.frame.screen()
    check('ctrl+f expands preview to show all three files and collapse hint', expanded && expandedScreen.includes('alpha-after') && expandedScreen.includes('beta-after') && expandedScreen.includes('gamma-after'), expandedScreen)
    compactRun.frame.push('\x06')
    const recollapsed = await waitFor(() => compactRun.frame.screen().includes('ctrl+f expands'), 3000)
    check('second ctrl+f collapses the preview back', recollapsed, compactRun.frame.screen())
  } finally {
    compactRun.frame.unmount()
  }

  section('3. Denial via No leaves all three files byte-for-byte untouched')
  const beforeNo = snapshotBytes()
  let applyAttemptedOnNo = false
  const noRun = await mountCard(
    { op: 'apply', plan_id: planId },
    ctx,
    {
      cols: 120,
      rows: 52,
      toolUseID: 'cs-no',
      onAllowEffect: async () => {
        applyAttemptedOnNo = true
        await callChangeSet({ op: 'apply', plan_id: planId }, ctx)
      },
    },
  )
  try {
    noRun.frame.push(KEY.down)
    await settle(40)
    noRun.frame.push(KEY.enter)
    const done = await waitFor(() => noRun.done === 1, 3000)
    check('No calls onReject and onDone without calling onAllow', done && noRun.allowed.length === 0 && noRun.cardRejected === 1 && noRun.confirmRejected.length === 1 && noRun.confirmRejected[0] === undefined)
    check('apply was never invoked on No', !applyAttemptedOnNo)
    check('all three files on disk are byte-for-byte unchanged after No', bytesEqual(beforeNo, snapshotBytes()))
  } finally {
    noRun.frame.unmount()
  }

  section('4. Denial via No + feedback carries words and leaves bytes untouched')
  const beforeFeedbackNo = snapshotBytes()
  const noFeedbackRun = await mountCard({ op: 'apply', plan_id: planId }, ctx, { cols: 120, rows: 52, toolUseID: 'cs-no-fb' })
  try {
    noFeedbackRun.frame.push(KEY.down)
    await settle(40)
    noFeedbackRun.frame.push('\t')
    await settle(40)
    noFeedbackRun.frame.push('split into two sets')
    await settle(40)
    noFeedbackRun.frame.push(KEY.enter)
    const done = await waitFor(() => noFeedbackRun.done === 1, 3000)
    check('No with Tab feedback forwards the trimmed words to onReject', done && noFeedbackRun.allowed.length === 0 && noFeedbackRun.cardRejected === 1 && noFeedbackRun.confirmRejected[0] === 'split into two sets', JSON.stringify(noFeedbackRun.confirmRejected))
    check('all three files on disk are byte-for-byte unchanged after No with feedback', bytesEqual(beforeFeedbackNo, snapshotBytes()))
  } finally {
    noFeedbackRun.frame.unmount()
  }

  section('5. Cancel via Esc denies and leaves all three files untouched')
  const beforeEsc = snapshotBytes()
  const escRun = await mountCard({ op: 'apply', plan_id: planId }, ctx, { cols: 120, rows: 52, toolUseID: 'cs-esc' })
  try {
    escRun.frame.push(KEY.esc)
    const done = await waitFor(() => escRun.done === 1, 3000)
    check('Esc triggers onReject and onDone without calling onAllow', done && escRun.allowed.length === 0 && escRun.cardRejected === 1 && escRun.confirmRejected.length === 1)
    check('all three files on disk are byte-for-byte unchanged after Esc', bytesEqual(beforeEsc, snapshotBytes()))
  } finally {
    escRun.frame.unmount()
  }

  section('6. Missing, evicted, expired plans and preflight refusal paint honestly and write nothing')
  const beforeInvalid = snapshotBytes()
  const missingRun = await mountCard({ op: 'apply', plan_id: 'cs-missing0001' }, ctx, { cols: 120, rows: 28, toolUseID: 'cs-missing' })
  try {
    const missingScreen = missingRun.frame.screen()
    check('missing plan_id paints absent-or-expired refusal text', missingScreen.includes('cs-missing0001') && missingScreen.includes('not previewable here (absent or expired)'), missingScreen)
    missingRun.frame.push(KEY.down)
    await settle(40)
    missingRun.frame.push(KEY.enter)
    check('missing plan card can be rejected cleanly', await waitFor(() => missingRun.done === 1 && missingRun.cardRejected === 1, 3000))
  } finally {
    missingRun.frame.unmount()
  }

  const expiredPlan = { ...plan!, id: 'cs-expired0001', expiresAt: Date.now() - 10_000 }
  rememberChangeSetPlan(owner, expiredPlan)
  const expiredApply: { data: { outcome: string; result: string } | null } = { data: null }
  const expiredRun = await mountCard(
    { op: 'apply', plan_id: expiredPlan.id },
    ctx,
    {
      cols: 120,
      rows: 52,
      toolUseID: 'cs-expired',
      onAllowEffect: async () => {
        const res = await callChangeSet({ op: 'apply', plan_id: expiredPlan.id }, ctx)
        expiredApply.data = res.data
      },
    },
  )
  try {
    expiredRun.frame.push(KEY.enter)
    await waitFor(() => expiredApply.data !== null, 3000)
    check('expired plan refuses honestly on apply without writing', expiredApply.data?.outcome === 'failed' && expiredApply.data.result.includes('expired') && expiredApply.data.result.includes('Nothing was written'), JSON.stringify(expiredApply.data))
    check('all three files remain byte-for-byte unchanged after expired plan apply', bytesEqual(beforeInvalid, snapshotBytes()))
  } finally {
    expiredRun.frame.unmount()
  }
  for (let i = 0; i <= CHANGESET_BOUNDS.planRing; i++) {
    rememberChangeSetPlan(owner, { ...plan!, id: `cs-fill${String(i).padStart(4, '0')}` })
  }
  const evictedRun = await mountCard({ op: 'apply', plan_id: expiredPlan.id }, ctx, { cols: 120, rows: 28, toolUseID: 'cs-evicted' })
  try {
    const evictedScreen = evictedRun.frame.screen()
    check('evicted plan_id paints absent-or-expired refusal text', evictedScreen.includes(expiredPlan.id) && evictedScreen.includes('not previewable here (absent or expired)'), evictedScreen)
  } finally {
    evictedRun.frame.unmount()
  }

  const badChanges = [
    {
      file_path: alphaPath,
      expected_anchor: 'fa:000000000000',
      hunks: [{ lines: '1', replace: 'export const alpha = "never"' }],
    },
  ]
  const refusalRun = await mountCard({ op: 'apply', changes: badChanges }, ctx, { cols: 120, rows: 28, toolUseID: 'cs-preflight' })
  try {
    const refusalScreen = refusalRun.frame.screen()
    check('bad direct changes paints preflight refusal text', refusalScreen.includes('This change set will refuse at preflight') && refusalScreen.includes('alpha.ts'), refusalScreen)
  } finally {
    refusalRun.frame.unmount()
  }
  check('no invalid or refusal preview touched disk', bytesEqual(beforeInvalid, snapshotBytes()))

  section('7. Yes with feedback and Yes end-to-end apply writes all three files atomically')
  const yesFeedbackInput = { op: 'apply', changes: threeFileChanges() }
  const yesFeedbackRun = await mountCard(yesFeedbackInput, ctx, { cols: 120, rows: 52, toolUseID: 'cs-yes-fb' })
  try {
    const directScreen = yesFeedbackRun.frame.screen()
    check('direct changes apply previews all three files', directScreen.includes('alpha-after') && directScreen.includes('beta-after') && directScreen.includes('gamma-after'), directScreen)
    yesFeedbackRun.frame.push('\t')
    await settle(40)
    yesFeedbackRun.frame.push('run typecheck after')
    await settle(40)
    yesFeedbackRun.frame.push(KEY.enter)
    const done = await waitFor(() => yesFeedbackRun.done === 1, 3000)
    check('Yes with Tab feedback passes input, empty updates, and trimmed words to onAllow', done && yesFeedbackRun.allowed.length === 1 && yesFeedbackRun.allowed[0]!.feedback === 'run typecheck after' && yesFeedbackRun.allowed[0]!.updates.length === 0 && yesFeedbackRun.cardRejected === 0, JSON.stringify(yesFeedbackRun.allowed))
  } finally {
    yesFeedbackRun.frame.unmount()
  }
  const freshPreview = await callChangeSet({ op: 'preview', changes: threeFileChanges() }, ctx)
  const freshPlanId = freshPreview.data.planId!
  const applyResult: { data: { outcome: string; result: string } | null } = { data: null }
  const yesApplyRun = await mountCard(
    { op: 'apply', plan_id: freshPlanId },
    ctx,
    {
      cols: 120,
      rows: 52,
      toolUseID: 'cs-yes-apply',
      onAllowEffect: async () => {
        const res = await callChangeSet({ op: 'apply', plan_id: freshPlanId }, ctx)
        applyResult.data = res.data
      },
    },
  )
  try {
    yesApplyRun.frame.push(KEY.enter)
    await waitFor(() => applyResult.data !== null, 3000)
    check('Yes fires onAllow and ChangeSetTool.call commits the plan', yesApplyRun.done === 1 && yesApplyRun.allowed.length === 1 && applyResult.data?.outcome === 'succeeded', JSON.stringify(applyResult.data))
    check('alpha.ts updated on disk', readFileSync(alphaPath, 'utf8') === alphaAfter)
    check('beta.ts updated on disk', readFileSync(betaPath, 'utf8') === betaAfter)
    check('gamma.ts updated on disk', readFileSync(gammaPath, 'utf8') === gammaAfter)
  } finally {
    yesApplyRun.frame.unmount()
  }
} finally {
  await releaseScratchHome(HOME)
  rmSync(PROJ, { recursive: true, force: true })
  rmSync(CS_DIR, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS changeset permission card' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
