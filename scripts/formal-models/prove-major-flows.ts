#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SurfaceReturnToken, SurfaceTransitionVerb } from '../../src/screen/routes/surfaceRoute.ts'
import type { HeldFireV1, SaturnScheduleV1, ScheduleAccountV1 } from '../../src/daemon/saturn/saturn.ts'
import type { LayoutRoots } from '../../src/platform/update-channel/installLayout.ts'
import type { FoldExit } from '../../src/engine/compaction/foldStatus.ts'
import type { SignInKind, SignInLedgerIo } from '../../src/models/sign-in/account-ledger/signInLedger.ts'
import { checker, guardWrite, scratchRoot } from '../engine-durability/harness.ts'
import { runnerLaunches } from '../lib/runnerLaunches.ts'

const root = scratchRoot('c3-major-flows')
const daemonDir = join(root, 'daemon')
mkdirSync(daemonDir, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SATURN_DISABLE
delete process.env.MERCURY_UPDATE_FAULT

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const TABLE_PATH = join(REPO, 'scripts', 'formal-models', 'major-flows.tsv')
const SELF_PROOF = 'scripts/formal-models/prove-major-flows.ts'
const t = checker()

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()

const surface = await import('../../src/screen/routes/surfaceRoute.ts')
const runKernel = await import('../../src/engine/run/runKernel.ts')
const runSidecar = await import('../../src/engine/run/runSidecar.ts')
const { makeOwnerKey } = await import('../../src/engine/run-owner/ownerKey.ts')
const permAsks = await import('../../src/daemon/session-seat/permissionAsks.ts')
const { permissionQueueStatus } = await import('../../src/permissions/cards/PermissionQueueContext.ts')
const { updateConcourseWorkers, concourseWorkersPath } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const saturn = await import('../../src/daemon/saturn/saturn.ts')
const { saturnDueAtOf } = await import('../../src/daemon/saturn/saturnTicker.ts')
const installLayout = await import('../../src/platform/update-channel/installLayout.ts')
const foldStatus = await import('../../src/engine/compaction/foldStatus.ts')
const completionEvaluator = await import('../../src/engine/run/completionEvaluator.ts')
const runInspector = await import('../../src/commands/run/runInspectorModel.ts')
const currentWork = await import('../../src/screen/workbench/currentWork.ts')
const promptDraft = await import('../../src/screen/composer/input-core/promptDraft.ts')
const signInLedger = await import('../../src/models/sign-in/account-ledger/signInLedger.ts')
const { loginSuccessReceipt } = await import('../../src/models/sign-in/account-ledger/loginReceipt.ts')
const { AuthCodeListener } = await import('../../src/models/sign-in/oauth/auth-code-listener.ts')

const EXPECTED_HEADERS = [
  'flow',
  'category',
  'anchor',
  'start_action_outcome',
  'invariant',
  'production_entry',
  'disposition',
  'witness_kind',
  'model_proof',
  'unmodellable_part',
  'waiver_reason',
  'behavioral_witness',
  'approval_ref',
] as const

type FlowDisposition = 'modelled' | 'waiver-accepted' | 'waiver-proposed'
type WitnessKind = 'bounded-model' | 'sampled-property' | 'scripted-example'

interface MajorFlowRow {
  flow: string
  category: string
  anchor: string
  start_action_outcome: string
  invariant: string
  production_entry: string
  disposition: string
  witness_kind: string
  model_proof: string
  unmodellable_part: string
  waiver_reason: string
  behavioral_witness: string
  approval_ref: string
}

const IMPLEMENTED_MODEL_IDS = new Set([
  `${SELF_PROOF}#surface-route-sessions`,
  `${SELF_PROOF}#run-identity-resume`,
  `${SELF_PROOF}#permission-answer-once`,
  `${SELF_PROOF}#saturn-hold-fire`,
  `${SELF_PROOF}#update-pointer-swap`,
  `${SELF_PROOF}#compact-fold-status`,
  `${SELF_PROOF}#edit-verify-status`,
  `${SELF_PROOF}#deliverables-panels`,
  `${SELF_PROOF}#draft-excursion`,
  `${SELF_PROOF}#signin-receipt-cancel`,
  'scripts/formal-models/prove-model-interview.ts#interview-store',
])

function parseMajorFlowsTsv(raw: string): { headers: string[]; rows: MajorFlowRow[]; errors: string[] } {
  const lines = raw.split(/\r?\n/).filter(l => l.trim() !== '')
  if (lines.length < 2) return { headers: [], rows: [], errors: ['table has no data rows'] }
  const headers = lines[0]!.split('\t')
  const errors: string[] = []
  if (JSON.stringify(headers) !== JSON.stringify([...EXPECTED_HEADERS])) {
    errors.push(`unexpected header columns: ${headers.join(',')}`)
    return { headers, rows: [], errors }
  }
  const rows: MajorFlowRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split('\t')
    if (cols.length !== EXPECTED_HEADERS.length) {
      errors.push(`line ${i + 1}: expected ${EXPECTED_HEADERS.length} columns, got ${cols.length}`)
      continue
    }
    const row = Object.fromEntries(EXPECTED_HEADERS.map((h, idx) => [h, cols[idx]!.trim()])) as unknown as MajorFlowRow
    rows.push(row)
  }
  return { headers, rows, errors }
}

function isEmptyCell(v: string): boolean {
  return v.trim() === '' || v.trim() === '-'
}

function validateMajorFlowsTable(
  rows: readonly MajorFlowRow[],
  enrolled: ReadonlySet<string>,
  goldenJourneys: readonly string[],
  fileExists: (rel: string) => boolean,
): string[] {
  const errors: string[] = []
  const seenFlows = new Set<string>()
  const seenAnchors = new Set<string>()
  for (const row of rows) {
    if (isEmptyCell(row.flow)) errors.push('empty flow id')
    else if (seenFlows.has(row.flow)) errors.push(`duplicate flow id: ${row.flow}`)
    seenFlows.add(row.flow)
    if (row.category !== 'golden-journey' && row.category !== 'crossing' && row.category !== 'deterministic-core') {
      errors.push(`${row.flow}: invalid category ${row.category}`)
    }
    if (row.category === 'deterministic-core' && row.disposition !== 'modelled') {
      errors.push(`${row.flow}: deterministic-core row must have disposition modelled`)
    }
    if (isEmptyCell(row.start_action_outcome)) errors.push(`${row.flow}: empty start_action_outcome`)
    if (isEmptyCell(row.invariant)) errors.push(`${row.flow}: empty invariant`)
    if (isEmptyCell(row.anchor) || !fileExists(row.anchor) || !enrolled.has(row.anchor)) {
      errors.push(`${row.flow}: stale or unenrolled anchor ${row.anchor}`)
    }
    seenAnchors.add(row.anchor)
    if (isEmptyCell(row.behavioral_witness) || !fileExists(row.behavioral_witness) || !enrolled.has(row.behavioral_witness)) {
      errors.push(`${row.flow}: stale or unenrolled behavioral_witness ${row.behavioral_witness}`)
    }
    const entries = row.production_entry.split(';').map(s => s.trim()).filter(Boolean)
    if (entries.length === 0) errors.push(`${row.flow}: empty production_entry`)
    for (const entry of entries) {
      const filePart = entry.split('#')[0]!
      if (!filePart.startsWith('src/') || !fileExists(filePart)) {
        errors.push(`${row.flow}: missing production_entry ${filePart}`)
      }
    }
    const disp = row.disposition as FlowDisposition
    const kind = row.witness_kind as WitnessKind
    if (disp !== 'modelled' && disp !== 'waiver-accepted' && disp !== 'waiver-proposed') {
      errors.push(`${row.flow}: invalid disposition ${row.disposition}`)
      continue
    }
    if (kind !== 'bounded-model' && kind !== 'sampled-property' && kind !== 'scripted-example') {
      errors.push(`${row.flow}: invalid witness_kind ${row.witness_kind}`)
      continue
    }
    if (disp === 'modelled') {
      if (kind === 'scripted-example') {
        errors.push(`${row.flow}: modelled flow cannot use witness_kind scripted-example`)
      }
      if (isEmptyCell(row.model_proof)) {
        errors.push(`${row.flow}: modelled flow lacks model_proof`)
      } else {
        const proofFile = row.model_proof.split('#')[0]!
        const okFile = fileExists(proofFile) && (proofFile === SELF_PROOF || enrolled.has(proofFile))
        if (!okFile) errors.push(`${row.flow}: stale or unenrolled model_proof ${row.model_proof}`)
        if (!IMPLEMENTED_MODEL_IDS.has(row.model_proof)) {
          errors.push(`${row.flow}: unregistered model_proof ${row.model_proof}`)
        }
      }
    } else {
      if (isEmptyCell(row.unmodellable_part)) errors.push(`${row.flow}: empty waiver unmodellable_part`)
      if (isEmptyCell(row.waiver_reason)) errors.push(`${row.flow}: empty waiver_reason`)
      if (disp === 'waiver-accepted' && isEmptyCell(row.approval_ref)) {
        errors.push(`${row.flow}: waiver-accepted requires approval_ref`)
      }
    }
  }
  for (const gj of goldenJourneys) {
    if (!seenAnchors.has(gj)) errors.push(`missing golden journey flow: ${gj}`)
  }
  return errors
}

function checkObligationTable(): void {
  t.section('§1 — major-flows obligation table: runner enrollment, golden journeys, waiver guards')
  const enrolled = new Set(runnerLaunches(REPO).flatMap(s => s.launched))
  const goldenJourneys = readdirSync(join(REPO, 'scripts', 'golden-journeys'))
    .filter(f => /^journey-j\d+\.ts$/.test(f))
    .sort()
    .map(f => `scripts/golden-journeys/${f}`)
  const fileExists = (rel: string): boolean => existsSync(join(REPO, rel))
  const parsed = parseMajorFlowsTsv(readFileSync(TABLE_PATH, 'utf8'))
  t.check('major-flows.tsv parses with exact 13-column schema', parsed.errors.length === 0, parsed.errors.join('; '))
  const tableErrors = validateMajorFlowsTable(parsed.rows, enrolled, goldenJourneys, fileExists)
  t.check('all table rows match enrolled anchors, golden journeys, production entries, and waiver rules', tableErrors.length === 0, tableErrors.join('; '))
  const topLevel = parsed.rows.filter(r => r.category === 'golden-journey' || r.category === 'crossing')
  const detCores = parsed.rows.filter(r => r.category === 'deterministic-core')
  t.check('table holds 12 major-flow obligations plus 4 deterministic-core rows', topLevel.length === 12 && detCores.length === 4, `top=${topLevel.length} cores=${detCores.length}`)

  const modelled = parsed.rows.filter(r => r.disposition === 'modelled')
  const bounded = modelled.filter(r => r.witness_kind === 'bounded-model').length
  const sampled = modelled.filter(r => r.witness_kind === 'sampled-property').length
  const accepted = parsed.rows.filter(r => r.disposition === 'waiver-accepted').length
  const proposed = parsed.rows.filter(r => r.disposition === 'waiver-proposed').length
  console.log(
    `  [census] total=${parsed.rows.length} (flows=${topLevel.length}, deterministic-cores=${detCores.length}) modelled=${modelled.length} (bounded-model=${bounded}, sampled-property=${sampled}) waiver-accepted=${accepted} waiver-proposed=${proposed} (decision-needed=${proposed})`,
  )

  const withStaleProof = parsed.rows.map((r, i) => (i === 0 ? { ...r, anchor: 'scripts/golden-journeys/journey-stale.ts' } : r))
  const staleErrs = validateMajorFlowsTable(withStaleProof, enrolled, goldenJourneys, fileExists)
  t.check('validator rejects a stale or unenrolled anchor path', staleErrs.some(e => e.includes('stale or unenrolled anchor')), staleErrs.join('; '))

  const missingFlowErrs = validateMajorFlowsTable(parsed.rows, enrolled, [...goldenJourneys, 'scripts/golden-journeys/journey-j6.ts'], fileExists)
  t.check('validator rejects a newly added golden journey missing from the table', missingFlowErrs.some(e => e.includes('missing golden journey')), missingFlowErrs.join('; '))

  const syntheticEmptyWaiver: MajorFlowRow = {
    ...parsed.rows[0]!,
    flow: 'synthetic-empty-waiver',
    category: 'crossing',
    disposition: 'waiver-proposed',
    witness_kind: 'scripted-example',
    model_proof: '-',
    unmodellable_part: 'synthetic external step',
    waiver_reason: '-',
    approval_ref: '-',
  }
  const emptyWaiverErrs = validateMajorFlowsTable([...parsed.rows, syntheticEmptyWaiver], enrolled, goldenJourneys, fileExists)
  t.check('validator rejects an empty waiver reason independent of live row statuses', emptyWaiverErrs.some(e => e.includes('empty waiver_reason')), emptyWaiverErrs.join('; '))

  const syntheticUnapproved: MajorFlowRow = {
    ...parsed.rows[0]!,
    flow: 'synthetic-unapproved-waiver',
    category: 'crossing',
    disposition: 'waiver-accepted',
    witness_kind: 'scripted-example',
    model_proof: '-',
    unmodellable_part: 'synthetic external step',
    waiver_reason: 'synthetic external boundary',
    approval_ref: '-',
  }
  const selfApprovedErrs = validateMajorFlowsTable([...parsed.rows, syntheticUnapproved], enrolled, goldenJourneys, fileExists)
  t.check('validator rejects waiver-accepted without an owner approval_ref', selfApprovedErrs.some(e => e.includes('requires approval_ref')), selfApprovedErrs.join('; '))

  const fakeModelKind = parsed.rows.map(r => (r.flow === 'switch-live-chats' ? { ...r, witness_kind: 'scripted-example' } : r))
  const fakeKindErrs = validateMajorFlowsTable(fakeModelKind, enrolled, goldenJourneys, fileExists)
  t.check('validator rejects labelling a scripted-example as modelled', fakeKindErrs.some(e => e.includes('cannot use witness_kind scripted-example')), fakeKindErrs.join('; '))
}

interface RouteOracle {
  route: string
  stack: Array<{ to: string; nonce: number }>
  chatOpen: boolean
  generation: number
  lastVerb: SurfaceTransitionVerb
  tokenA: SurfaceReturnToken | null
  tokenB: SurfaceReturnToken | null
}

type RouteAction = 'enterA' | 'enterB' | 'enterConcourse' | 'enterBoot' | 'enterRoot' | 'retTokenA' | 'retTokenB' | 'retActive' | 'toggleChat'

function stepRouteOracle(
  oracle: RouteOracle,
  action: RouteAction,
  mintedNonce?: number,
): { ok: boolean; code?: string } {
  const pushTo = (target: string): { ok: boolean; code?: string } => {
    if (oracle.route === target) return { ok: false, code: 'already-current' }
    const nonce = mintedNonce ?? -1
    oracle.stack.push({ to: oracle.route, nonce })
    oracle.route = target
    oracle.generation += 1
    oracle.lastVerb = 'PUSH'
    return { ok: true }
  }
  const tryReturn = (tok: SurfaceReturnToken | null): { ok: boolean } => {
    if (tok === null) return { ok: false }
    const top = oracle.stack[oracle.stack.length - 1]
    if (!top || top.nonce !== tok.nonce) return { ok: false }
    if (top.to === 'repl' && !oracle.chatOpen) return { ok: false }
    oracle.stack.pop()
    oracle.route = top.to
    oracle.generation += 1
    oracle.lastVerb = 'RETURN'
    return { ok: true }
  }
  switch (action) {
    case 'enterA':
      return pushTo('session:sess-A')
    case 'enterB':
      return pushTo('session:sess-B')
    case 'enterConcourse':
      return pushTo('concourse')
    case 'enterBoot':
      return pushTo('boot-settings')
    case 'enterRoot': {
      if (!oracle.chatOpen) return { ok: false, code: 'no-chat' }
      if (oracle.route !== 'repl' || oracle.stack.length > 0) {
        oracle.route = 'repl'
        oracle.stack = []
        oracle.generation += 1
        oracle.lastVerb = 'HOME'
      }
      return { ok: true }
    }
    case 'retTokenA':
      return tryReturn(oracle.tokenA)
    case 'retTokenB':
      return tryReturn(oracle.tokenB)
    case 'retActive': {
      const top = oracle.stack[oracle.stack.length - 1]
      return tryReturn(top ? { to: surface.ROOT_CHAT_ROUTE, nonce: top.nonce } : null)
    }
    case 'toggleChat':
      oracle.chatOpen = !oracle.chatOpen
      return { ok: true }
  }
}

function runRouteTrace(actions: readonly RouteAction[]): string | null {
  surface._resetSurfaceRouteForTesting()
  surface.registerRouteSurface('session', { render: () => null })
  surface.registerRouteSurface('concourse', { render: () => null })
  surface.registerRouteSurface('boot-settings', { render: () => null })
  let chatOpen = true
  surface.registerChatPresence({ present: () => chatOpen, subscribe: () => () => {} })
  const oracle: RouteOracle = {
    route: 'repl',
    stack: [],
    chatOpen: true,
    generation: 0,
    lastVerb: 'INIT',
    tokenA: null,
    tokenB: null,
  }
  let maxNonce = 0
  for (let i = 0; i < actions.length; i++) {
    const act = actions[i]!
    let realOk = false
    let realCode: string | undefined
    let minted: SurfaceReturnToken | undefined
    if (act === 'enterA') {
      const r = surface.enterSessionChat('sess-A')
      realOk = r.ok
      if (r.ok) {
        minted = r.token
        oracle.tokenA = r.token
      } else realCode = r.code
    } else if (act === 'enterB') {
      const r = surface.enterSessionChat('sess-B')
      realOk = r.ok
      if (r.ok) {
        minted = r.token
        oracle.tokenB = r.token
      } else realCode = r.code
    } else if (act === 'enterConcourse') {
      const r = surface.enterConcourse()
      realOk = r.ok
      if (r.ok) minted = r.token
      else realCode = r.code
    } else if (act === 'enterBoot') {
      const r = surface.enterBootSettings()
      realOk = r.ok
      if (r.ok) minted = r.token
      else realCode = r.code
    } else if (act === 'enterRoot') {
      const r = surface.enterRootChat()
      realOk = r.ok
      if (!r.ok) realCode = r.code
    } else if (act === 'retTokenA') {
      realOk = oracle.tokenA !== null ? surface.returnFromSurface(oracle.tokenA).ok : false
    } else if (act === 'retTokenB') {
      realOk = oracle.tokenB !== null ? surface.returnFromSurface(oracle.tokenB).ok : false
    } else if (act === 'retActive') {
      realOk = surface.leaveCurrentSurface().ok
    } else if (act === 'toggleChat') {
      chatOpen = !chatOpen
      realOk = true
    }
    if (minted !== undefined) {
      if (minted.nonce <= maxNonce) return `trace ${actions.join('>')}: non-monotonic nonce ${minted.nonce}`
      maxNonce = minted.nonce
    }
    const expected = stepRouteOracle(oracle, act, minted?.nonce)
    if (realOk !== expected.ok || (expected.code !== undefined && realCode !== expected.code)) {
      return `trace ${actions.join('>')} step ${i} (${act}): real=(${realOk},${realCode ?? '-'}) oracle=(${expected.ok},${expected.code ?? '-'})`
    }
    const gotRoute = surface.surfaceRouteId(surface.currentSurfaceRoute())
    const gotTop = surface.activeReturnToken()?.nonce ?? null
    const wantTop = oracle.stack[oracle.stack.length - 1]?.nonce ?? null
    if (
      gotRoute !== oracle.route ||
      gotTop !== wantTop ||
      surface.surfaceGeneration() !== oracle.generation ||
      surface.lastSurfaceTransition().verb !== oracle.lastVerb
    ) {
      return `trace ${actions.join('>')} step ${i} (${act}): state mismatch real=(${gotRoute},top=${gotTop},gen=${surface.surfaceGeneration()},${surface.lastSurfaceTransition().verb}) oracle=(${oracle.route},top=${wantTop},gen=${oracle.generation},${oracle.lastVerb})`
    }
  }
  return null
}

function enumerateActions<A>(alphabet: readonly A[], depth: number, visit: (seq: A[]) => void): void {
  const buf: A[] = []
  const walk = (rem: number): void => {
    if (rem === 0) {
      visit([...buf])
      return
    }
    for (const a of alphabet) {
      buf.push(a)
      walk(rem - 1)
      buf.pop()
    }
  }
  walk(depth)
}

function checkSurfaceRouteModel(): void {
  t.section('§2 — bounded model #surface-route-sessions (two sessions + stale return token oracle)')
  surface._resetSurfaceRouteForTesting()
  surface.registerRouteSurface('session', { render: () => null })
  surface.registerRouteSurface('concourse', { render: () => null })
  surface.registerChatPresence({ present: () => true, subscribe: () => () => {} })

  const enterEmpty = surface.enterSessionChat('')
  t.check('empty sessionId is rejected with invalid-target', !enterEmpty.ok && enterEmpty.code === 'invalid-target')

  const enterA = surface.enterSessionChat('sess-A')
  const enterB = surface.enterSessionChat('sess-B')
  const tokA = enterA.ok ? enterA.token : null
  const tokB = enterB.ok ? enterB.token : null
  const genBeforeStale = surface.surfaceGeneration()
  const staleFromA = tokA ? surface.returnFromSurface(tokA) : { ok: true }
  t.check(
    'stale return token from A after fresh transition to B does not navigate back',
    tokA !== null &&
      tokB !== null &&
      !staleFromA.ok &&
      surface.surfaceRouteId(surface.currentSurfaceRoute()) === 'session:sess-B' &&
      surface.surfaceGeneration() === genBeforeStale &&
      surface.activeReturnToken()?.nonce === tokB.nonce,
  )

  const oracleCopy: RouteOracle = {
    route: 'session:sess-B',
    stack: [
      { to: 'repl', nonce: tokA!.nonce },
      { to: 'session:sess-A', nonce: tokB!.nonce },
    ],
    chatOpen: true,
    generation: genBeforeStale,
    lastVerb: 'PUSH',
    tokenA: tokA,
    tokenB: tokB,
  }
  const oracleStale = stepRouteOracle(oracleCopy, 'retTokenA')
  const oracleValid = stepRouteOracle(oracleCopy, 'retTokenB')
  t.check(
    'independent route oracle distinguishes stale token A (false) from valid token B (true)',
    !oracleStale.ok && oracleValid.ok && oracleCopy.route === 'session:sess-A',
  )

  const validBackToA = surface.returnFromSurface(tokB!)
  const validBackToRoot = surface.returnFromSurface(tokA!)
  const replayTokenA = surface.returnFromSurface(tokA!)
  t.check(
    'valid LIFO returns unwind B -> A -> repl and replaying consumed token A is refused',
    validBackToA.ok &&
      validBackToRoot.ok &&
      !replayTokenA.ok &&
      surface.surfaceRouteId(surface.currentSurfaceRoute()) === 'repl' &&
      surface.activeReturnToken() === null,
  )

  const a2 = surface.enterSessionChat('sess-A')
  const b2 = surface.enterSessionChat('sess-B')
  const home = surface.enterRootChat()
  t.check(
    'enterRootChat clears the return stack so both prior session tokens are permanently stale',
    a2.ok && b2.ok && home.ok && !surface.returnFromSurface(b2.token).ok && !surface.returnFromSurface(a2.token).ok,
  )

  const coreAlphabet: readonly RouteAction[] = ['enterA', 'enterB', 'enterConcourse', 'enterRoot', 'retTokenA', 'retTokenB']
  let traces = 0
  let firstErr: string | null = null
  enumerateActions(coreAlphabet, 4, seq => {
    if (firstErr !== null) return
    traces++
    firstErr = runRouteTrace(seq)
  })
  const fullAlphabet: readonly RouteAction[] = ['enterA', 'enterB', 'enterConcourse', 'enterBoot', 'enterRoot', 'retTokenA', 'retActive', 'toggleChat']
  enumerateActions(fullAlphabet, 3, seq => {
    if (firstErr !== null) return
    traces++
    firstErr = runRouteTrace(seq)
  })
  t.check(`all ${traces} enumerated bounded route traces matched the independent transition oracle`, firstErr === null, firstErr ?? '')
}

type RunAction = 'openD1' | 'doneD1' | 'openD2' | 'editF1' | 'verifyOk' | 'complete'

function runKernelTrace(actions: readonly RunAction[]): string | null {
  const owner = makeOwnerKey({ workspace: root, sessionId: '00000000-0000-4000-8000-00000000c301', lane: 'main' })
  let snap = runKernel.emptyRunSnapshot({ runId: 'run_model_1', owner, objective: 'bounded run', rootMessageId: null, at: 1 })
  const deliverables = new Map<string, 'open' | 'done'>()
  const changed: string[] = []
  let verification: 'unverified' | 'verified' | 'stale' = 'unverified'
  let lifecycle: 'active' | 'completed' = 'active'
  let tick = 10

  for (let i = 0; i < actions.length; i++) {
    const act = actions[i]!
    tick += 10
    if (act === 'openD1') {
      snap = runKernel.reduceRunEvent(snap, { type: 'task-transition', at: tick, taskId: 'd1', title: 'D1', state: 'open' })
      deliverables.set('d1', 'open')
    } else if (act === 'doneD1') {
      snap = runKernel.reduceRunEvent(snap, { type: 'task-transition', at: tick, taskId: 'd1', title: 'D1', state: 'done' })
      deliverables.set('d1', 'done')
    } else if (act === 'openD2') {
      snap = runKernel.reduceRunEvent(snap, { type: 'task-transition', at: tick, taskId: 'd2', title: 'D2', state: 'open' })
      deliverables.set('d2', 'open')
    } else if (act === 'editF1') {
      snap = runKernel.reduceRunEvent(snap, {
        type: 'tool-effected',
        at: tick,
        toolName: 'Edit',
        toolUseId: `tu_${i}`,
        operation: 'edit apply',
        outcome: 'succeeded',
        changedPaths: ['src/f1.ts'],
      })
      if (!changed.includes('src/f1.ts')) changed.push('src/f1.ts')
      if (verification === 'verified') verification = 'stale'
    } else if (act === 'verifyOk') {
      snap = runKernel.reduceRunEvent(snap, { type: 'evidence', at: tick, state: 'verified', detail: 'ok' })
      verification = 'verified'
    } else if (act === 'complete') {
      snap = runKernel.reduceRunEvent(snap, { type: 'completed', at: tick, satisfied: ['done'] })
      const hasOpen = [...deliverables.values()].some(v => v === 'open')
      if (!hasOpen) lifecycle = 'completed'
    }
    const openCount = [...deliverables.values()].filter(v => v === 'open').length
    if (lifecycle === 'completed' && openCount > 0) lifecycle = 'active'
    const uniqueIds = new Set(snap.deliverables.map(d => d.id)).size === snap.deliverables.length
    const uniquePaths = new Set(snap.changedPaths).size === snap.changedPaths.length
    if (
      snap.runId !== 'run_model_1' ||
      !uniqueIds ||
      !uniquePaths ||
      snap.deliverables.length !== deliverables.size ||
      runKernel.openDeliverables(snap).length !== openCount ||
      JSON.stringify(snap.changedPaths) !== JSON.stringify(changed) ||
      snap.verification.state !== verification ||
      snap.lifecycle !== lifecycle
    ) {
      return `run trace ${actions.join('>')} step ${i} (${act}): real=(life=${snap.lifecycle},ver=${snap.verification.state},open=${runKernel.openDeliverables(snap).length}) oracle=(life=${lifecycle},ver=${verification},open=${openCount})`
    }
  }
  return null
}

async function checkRunIdentityModel(): Promise<void> {
  t.section('§3 — bounded model #run-identity-resume (work identity, completion guard, durable sidecar)')
  const alphabet: readonly RunAction[] = ['openD1', 'doneD1', 'openD2', 'editF1', 'verifyOk', 'complete']
  let traces = 0
  let firstErr: string | null = null
  enumerateActions(alphabet, 4, seq => {
    if (firstErr !== null) return
    traces++
    firstErr = runKernelTrace(seq)
  })
  t.check(`all ${traces} bounded run-kernel traces matched the independent identity/completion oracle`, firstErr === null, firstErr ?? '')

  const owner = makeOwnerKey({ workspace: root, sessionId: '00000000-0000-4000-8000-00000000c302', lane: 'main' })
  const before = await runSidecar.loadRunSidecar(owner)
  let snap = runKernel.emptyRunSnapshot({ runId: 'run_durable_c3', owner, objective: 'survive restart', rootMessageId: null, at: 1 })
  snap = runKernel.reduceRunEvent(snap, { type: 'task-transition', at: 2, taskId: 't1', title: 'Step 1', state: 'open' })
  snap = runKernel.reduceRunEvent(snap, {
    type: 'tool-effected',
    at: 3,
    toolName: 'Edit',
    toolUseId: 'tu_1',
    operation: 'edit apply',
    outcome: 'succeeded',
    changedPaths: ['src/a.ts'],
  })
  snap = runKernel.reduceRunEvent(snap, {
    type: 'tool-effected',
    at: 4,
    toolName: 'Edit',
    toolUseId: 'tu_2',
    operation: 'edit apply',
    outcome: 'succeeded',
    changedPaths: ['src/a.ts'],
  })
  await runSidecar.saveRunSidecar(owner, snap)
  const rev1 = runSidecar.runRevision(owner)
  const load1 = await runSidecar.loadRunSidecar(owner)

  const sidecarFile = runSidecar.runSidecarPath(owner)
  writeFileSync(guardWrite(root, sidecarFile), '{ torn-json')
  const torn = await runSidecar.loadRunSidecar(owner)

  snap = runKernel.reduceRunEvent(snap, { type: 'resumed', at: 5, reason: 'restart' })
  snap = runKernel.reduceRunEvent(snap, { type: 'task-transition', at: 6, taskId: 't1', title: 'Step 1', state: 'done' })
  snap = runKernel.reduceRunEvent(snap, { type: 'completed', at: 7, satisfied: ['all done'] })
  await runSidecar.saveRunSidecar(owner, snap)
  const rev2 = runSidecar.runRevision(owner)
  const load2 = await runSidecar.loadRunSidecar(owner)

  t.check(
    'durable sidecar preserves runId, deduplicates repeated path edits, classifies torn JSON recoverable, and advances writeSeq monotonically',
    before.state === 'none' &&
      load1.state === 'loaded' &&
      load1.snapshot.runId === 'run_durable_c3' &&
      load1.snapshot.changedPaths.length === 1 &&
      torn.state === 'recoverable' &&
      rev2 > rev1 &&
      load2.state === 'loaded' &&
      load2.snapshot.runId === 'run_durable_c3' &&
      load2.snapshot.lifecycle === 'completed',
    `before=${before.state} load1=${load1.state} paths=${load1.state === 'loaded' ? load1.snapshot.changedPaths.length : -1} torn=${torn.state} rev=${rev1}->${rev2} load2=${load2.state}`,
  )
}

type PermAction = 'holdA' | 'holdB' | 'allowA' | 'denyA' | 'allowB' | 'withdrawB' | 'retire'

async function runPermTrace(workerId: string, sessionId: string, actions: readonly PermAction[]): Promise<string | null> {
  type SlotState = {
    requestId: string
    status: 'pending' | 'allowed' | 'denied' | 'withdrawn' | 'retired'
    held: { answer: Promise<{ outcome: string }>; withdraw: (cause?: string) => void }
    resolvedCount: number
  }
  const slots = new Map<'A' | 'B', SlotState>()
  let resolvedByOperator = 0
  const knownIds = new Set(permAsks.listPendingPermissionAsks().map(p => p.requestId))
  const holdSlot = (key: 'A' | 'B'): string | null => {
    const held = permAsks.holdWorkerAsk(
      workerId,
      { kind: 'tool', tool_use_id: `tu_${key}_${Math.random()}`, tool_name: key === 'A' ? 'Read' : 'Edit', input: { key } },
      daemonDir,
      undefined,
      () => 'attached',
    )
    const nowPending = permAsks.listPendingPermissionAsks().filter(p => p.workerId === workerId)
    const fresh = nowPending.find(p => !knownIds.has(p.requestId))
    if (!fresh) return `hold ${key} did not register a pending ask`
    knownIds.add(fresh.requestId)
    const entry: SlotState = { requestId: fresh.requestId, status: 'pending', held, resolvedCount: 0 }
    held.answer.then(() => {
      entry.resolvedCount += 1
    })
    slots.set(key, entry)
    return null
  }
  for (let i = 0; i < actions.length; i++) {
    const act = actions[i]!
    if (act === 'holdA' && slots.get('A')?.status !== 'pending') {
      const err = holdSlot('A')
      if (err) return err
    } else if (act === 'holdB' && slots.get('B')?.status !== 'pending') {
      const err = holdSlot('B')
      if (err) return err
    } else if (act === 'allowA' || act === 'denyA' || act === 'allowB') {
      const key = act === 'allowB' ? 'B' : 'A'
      const allow = act !== 'denyA'
      const slot = slots.get(key)
      if (!slot) continue
      const wasPending = slot.status === 'pending'
      const res = permAsks.answerPermissionAsk(slot.requestId, allow, 'operator:model')
      if (wasPending) {
        if (res.outcome !== 'applied') return `${actions.join('>')} step ${i}: expected applied for ${key}, got ${res.outcome}`
        slot.status = allow ? 'allowed' : 'denied'
        resolvedByOperator += 1
        const ans = await slot.held.answer
        const want = allow ? 'allow' : 'deny'
        if (ans.outcome !== want) return `${actions.join('>')} step ${i}: expected ${want}, got ${ans.outcome}`
      } else if (res.outcome !== 'refused') {
        return `${actions.join('>')} step ${i}: non-pending ${key} (${slot.status}) was NOT refused (got ${res.outcome})`
      }
    } else if (act === 'withdrawB') {
      const slot = slots.get('B')
      if (!slot) continue
      permAsks.onWorkerAskWithdrawn(slot.requestId, daemonDir, 'cancelled')
      if (slot.status === 'pending') slot.status = 'withdrawn'
    } else if (act === 'retire') {
      const retired = permAsks.retireWorkerAsks(workerId, 'worker-restarted', daemonDir)
      const expectedRetired = [...slots.values()].filter(s => s.status === 'pending').map(s => s.requestId)
      if (retired.length !== expectedRetired.length) {
        return `${actions.join('>')} step ${i}: retired ${retired.length} != expected ${expectedRetired.length}`
      }
      for (const s of slots.values()) if (s.status === 'pending') s.status = 'retired'
    }
    const wantPending = [...slots.values()].filter(s => s.status === 'pending').length
    const gotPending = permAsks.listPendingPermissionAsks().filter(p => p.sessionId === sessionId).length
    if (gotPending !== wantPending) {
      return `${actions.join('>')} step ${i} (${act}): pending real=${gotPending} oracle=${wantPending}`
    }
    const status = permissionQueueStatus(resolvedByOperator, gotPending)
    if (status.position !== resolvedByOperator + 1 || status.total !== resolvedByOperator + gotPending) {
      return `${actions.join('>')} step ${i}: queue status mismatch ${JSON.stringify(status)}`
    }
  }
  permAsks.retireWorkerAsks(workerId, 'cleanup', daemonDir)
  for (const s of slots.values()) {
    if (s.resolvedCount > 1) return `${actions.join('>')}: ask ${s.requestId} settled ${s.resolvedCount} times`
  }
  return null
}

async function checkPermissionAnswerModel(): Promise<void> {
  t.section('§4 — bounded model #permission-answer-once (consumed at most once + queue arithmetic)')
  const workerId = 'concourse-w1'
  const sessionId = 'sess-perm-c3'
  updateConcourseWorkers(workers => {
    workers[workerId] = {
      schema: 1,
      runnerId: workerId,
      sessionId,
      workspaceId: join(root, 'ws-perm'),
      isolation: 'shared',
      modelKey: 'claude-opus-5',
      effort: 'high',
      spawnedAt: Date.now(),
      lastLiveAt: Date.now(),
    } as never
  }, daemonDir)

  const traces: PermAction[][] = [
    ['holdA', 'allowA', 'allowA', 'denyA'],
    ['holdA', 'denyA', 'allowA', 'denyA'],
    ['holdA', 'holdB', 'allowA', 'allowA', 'allowB', 'allowB'],
    ['holdA', 'holdB', 'withdrawB', 'allowB', 'denyA', 'allowA'],
    ['holdA', 'holdB', 'retire', 'allowA', 'allowB'],
    ['holdB', 'withdrawB', 'holdB', 'allowB', 'allowB'],
    ['holdA', 'retire', 'allowA', 'holdA', 'denyA', 'denyA'],
    ['holdA', 'holdB', 'denyA', 'retire', 'allowB', 'allowA'],
  ]
  const smallAlpha: readonly PermAction[] = ['holdA', 'holdB', 'allowA', 'denyA', 'withdrawB', 'retire']
  let count = 0
  let firstErr: string | null = null
  for (const seq of traces) {
    count++
    firstErr = await runPermTrace(workerId, sessionId, seq)
    if (firstErr !== null) break
  }
  const generated: PermAction[][] = []
  enumerateActions(smallAlpha, 3, seq => generated.push(seq))
  for (const seq of generated.slice(0, 60)) {
    if (firstErr !== null) break
    count++
    firstErr = await runPermTrace(workerId, sessionId, seq)
  }
  const leftover = permAsks.listPendingPermissionAsks().filter(p => p.workerId === workerId).length
  t.check(`all ${count} bounded permission-ask traces held consumed-at-most-once and queue arithmetic`, firstErr === null && leftover === 0, firstErr ?? `leftover=${leftover}`)
}

type SaturnAction = 'addAt' | 'addEvery' | 'pause' | 'resume' | 'hold' | 'take' | 'fire' | 'remove'

function readWorkerRaw(workerId: string): { schedules?: SaturnScheduleV1[]; heldFires?: HeldFireV1[] } {
  const raw = JSON.parse(readFileSync(concourseWorkersPath(daemonDir), 'utf8')) as {
    workers: Record<string, { schedules?: SaturnScheduleV1[]; heldFires?: HeldFireV1[] }>
  }
  return raw.workers[workerId] ?? {}
}

function runSaturnTrace(workerId: string, sessionId: string, actions: readonly SaturnAction[]): string | null {
  updateConcourseWorkers(workers => {
    const rec = workers[workerId] as { schedules?: unknown; heldFires?: unknown } | undefined
    if (!rec) return
    delete rec.schedules
    delete rec.heldFires
  }, daemonDir)

  const account: ScheduleAccountV1 = {
    family: 'anthropic',
    source: 'oauth',
    scopeDir: join(daemonDir, 'scope'),
    identity: 'fixture@example.com',
    knownExpiresAt: Date.now() + 86_400_000,
    refreshable: true,
  }
  const deps = { deriveAccount: () => ({ ok: true as const, account }) }
  const oracleSchedules = new Map<string, { kind: 'at' | 'every'; paused: boolean }>()
  const oracleHolds = new Set<string>()
  let activeId: string | null = null
  const DUE = Date.now() + 3_600_000

  for (let i = 0; i < actions.length; i++) {
    const act = actions[i]!
    if (act === 'addAt' || act === 'addEvery') {
      const when = act === 'addAt' ? ({ kind: 'at', atMs: DUE } as const) : ({ kind: 'every', cron: '0 * * * *' } as const)
      const r = saturn.applyConcourseScheduleOp(
        sessionId,
        { op: 'add', schedule: { when, action: { kind: 'fire', prompt: 'tick', onParked: 'queue' } } },
        'operator:model',
        deps,
        daemonDir,
      )
      if (r.outcome !== 'applied' || !r.scheduleId) return `${actions.join('>')} step ${i}: add failed (${r.outcome})`
      activeId = r.scheduleId
      oracleSchedules.set(activeId, { kind: act === 'addAt' ? 'at' : 'every', paused: false })
    } else if (act === 'pause' || act === 'resume') {
      if (!activeId) continue
      const cur = oracleSchedules.get(activeId)
      const r = saturn.applyConcourseScheduleOp(sessionId, { op: act, scheduleId: activeId }, 'operator:model', deps, daemonDir)
      const wantOutcome = !cur ? 'refused' : (act === 'pause' ? (cur.paused ? 'noop' : 'applied') : (cur.paused ? 'applied' : 'noop'))
      if (r.outcome !== wantOutcome) return `${actions.join('>')} step ${i} (${act}): real=${r.outcome} oracle=${wantOutcome}`
      if (cur && r.outcome === 'applied') cur.paused = act === 'pause'
    } else if (act === 'hold') {
      if (!activeId) continue
      const key = `${activeId}@${DUE}`
      const had = oracleHolds.has(key)
      const r = saturn.holdSaturnFire(
        sessionId,
        {
          scheduleId: activeId,
          dueAt: DUE,
          reason: 'parked-queued',
          envelope: { scheduleId: activeId, kind: 'fire', dueAt: DUE, prompt: 'tick', onParked: 'queue' },
          heldAt: Date.now(),
        },
        daemonDir,
      )
      const want = had ? 'already-held' : 'held'
      if (r !== want) return `${actions.join('>')} step ${i} (hold): real=${r} oracle=${want}`
      oracleHolds.add(key)
    } else if (act === 'take') {
      if (!activeId) continue
      const key = `${activeId}@${DUE}`
      const had = oracleHolds.has(key)
      const taken = saturn.takeSaturnHeldFires(sessionId, [{ scheduleId: activeId, dueAt: DUE }], daemonDir)
      if (taken.length !== (had ? 1 : 0)) return `${actions.join('>')} step ${i} (take): real=${taken.length} oracle=${had ? 1 : 0}`
      oracleHolds.delete(key)
    } else if (act === 'fire') {
      if (!activeId) continue
      const cur = oracleSchedules.get(activeId)
      const r = saturn.markSaturnFired(sessionId, activeId, Date.now(), daemonDir)
      const want = !cur ? 'missing' : cur.kind === 'at' ? 'spent' : 'marked'
      if (r !== want) return `${actions.join('>')} step ${i} (fire): real=${r} oracle=${want}`
      if (cur && cur.kind === 'at') oracleSchedules.delete(activeId)
    } else if (act === 'remove') {
      if (!activeId) continue
      const cur = oracleSchedules.get(activeId)
      const r = saturn.applyConcourseScheduleOp(sessionId, { op: 'remove', scheduleId: activeId }, 'operator:model', deps, daemonDir)
      const want = cur ? 'applied' : 'refused'
      if (r.outcome !== want) return `${actions.join('>')} step ${i} (remove): real=${r.outcome} oracle=${want}`
      if (cur) {
        oracleSchedules.delete(activeId)
        for (const k of [...oracleHolds]) if (k.startsWith(`${activeId}@`)) oracleHolds.delete(k)
      }
    }
    const raw = readWorkerRaw(workerId)
    const realScheds = raw.schedules ?? []
    const realHolds = raw.heldFires ?? []
    if (realScheds.length !== oracleSchedules.size || realHolds.length !== oracleHolds.size) {
      return `${actions.join('>')} step ${i} (${act}): counts real=(s=${realScheds.length},h=${realHolds.length}) oracle=(s=${oracleSchedules.size},h=${oracleHolds.size})`
    }
    for (const s of realScheds) {
      const o = oracleSchedules.get(s.id)
      const due = saturnDueAtOf(s)
      if (!o || (o.paused ? due !== null : due === null)) {
        return `${actions.join('>')} step ${i}: dueAt mismatch for ${s.id} paused=${o?.paused} due=${due}`
      }
    }
  }
  return null
}

function checkSaturnHoldFireModel(): void {
  t.section('§5 — bounded model #saturn-hold-fire (one-shot spend, idempotent hold, take-once, orphan-free remove)')
  const workerId = 'concourse-w2'
  const sessionId = 'sess-saturn-c3'
  const ws = join(root, 'ws-saturn')
  mkdirSync(ws, { recursive: true })
  updateConcourseWorkers(workers => {
    workers[workerId] = {
      schema: 1,
      runnerId: workerId,
      sessionId,
      workspaceId: ws,
      isolation: 'shared',
      modelKey: 'claude-opus-5',
      effort: 'high',
      spawnedAt: Date.now(),
      lastLiveAt: Date.now(),
    } as never
  }, daemonDir)

  const traces: SaturnAction[][] = [
    ['addAt', 'pause', 'pause', 'resume', 'resume', 'fire', 'fire'],
    ['addAt', 'hold', 'hold', 'take', 'take', 'fire', 'fire'],
    ['addAt', 'hold', 'remove', 'take', 'fire', 'remove'],
    ['addEvery', 'fire', 'fire', 'pause', 'resume', 'hold', 'remove', 'take'],
    ['addEvery', 'hold', 'hold', 'take', 'hold', 'remove', 'take'],
    ['addAt', 'fire', 'pause', 'resume', 'remove'],
    ['addAt', 'hold', 'fire', 'take', 'take'],
  ]
  const tails: readonly SaturnAction[] = ['pause', 'resume', 'hold', 'take', 'fire', 'remove']
  const expanded: SaturnAction[][] = [...traces]
  enumerateActions(tails, 2, seq => {
    expanded.push(['addAt', ...seq])
    expanded.push(['addEvery', ...seq])
  })
  let firstErr: string | null = null
  for (const seq of expanded) {
    firstErr = runSaturnTrace(workerId, sessionId, seq)
    if (firstErr !== null) break
  }
  t.check(`all ${expanded.length} bounded scheduler traces matched the independent hold/fire oracle`, firstErr === null, firstErr ?? '')
}

function checkUpdatePointerModel(): void {
  t.section('§6 — bounded model #update-pointer-swap (atomic version pointer + rollback oracle)')
  type Op = { kind: 'switch' | 'restore'; version: '1.0.0' | '1.0.1' | '1.0.2' }
  const alphabet: readonly Op[] = [
    { kind: 'switch', version: '1.0.0' },
    { kind: 'switch', version: '1.0.1' },
    { kind: 'switch', version: '1.0.2' },
    { kind: 'restore', version: '1.0.0' },
    { kind: 'restore', version: '1.0.1' },
    { kind: 'restore', version: '1.0.2' },
  ]
  let count = 0
  let firstErr: string | null = null
  enumerateActions(alphabet, 3, seq => {
    if (firstErr !== null) return
    count++
    const versionsDir = join(root, 'updater', `t-${count}`)
    const binDir = join(root, 'updater', `b-${count}`)
    mkdirSync(versionsDir, { recursive: true })
    const roots: LayoutRoots = { versionsDir, binDir, shimPath: join(binDir, 'mercury'), isWindows: false }
    installLayout.switchCurrent(roots, '1.0.0')
    let cur = '1.0.0'
    let prev: string | null = null
    for (let i = 0; i < seq.length; i++) {
      const op = seq[i]!
      if (op.kind === 'switch') {
        const res = installLayout.switchCurrent(roots, op.version)
        if (res.previous !== cur) {
          firstErr = `trace ${count} step ${i}: returned previous=${res.previous} expected ${cur}`
          return
        }
        if (cur !== op.version) prev = cur
        cur = op.version
      } else {
        installLayout.restoreCurrent(roots, op.version)
        cur = op.version
      }
      const gotCur = installLayout.readCurrentVersion(roots)
      const gotPrev = installLayout.readPreviousVersion(roots)
      const tmpLeft = readdirSync(versionsDir).some(n => n.includes('.tmp.'))
      if (gotCur !== cur || gotPrev !== prev || tmpLeft) {
        firstErr = `trace ${count} step ${i}: real=(cur=${gotCur},prev=${gotPrev},tmp=${tmpLeft}) oracle=(cur=${cur},prev=${prev})`
        return
      }
    }
  })
  t.check(`all ${count} exhaustive depth-3 version-pointer traces matched the independent oracle`, firstErr === null, firstErr ?? '')
}

function checkCompactFoldStatusModel(): void {
  t.section('§7 — bounded model #compact-fold-status (monotonic stages, clamped fill, frozen exit)')
  type FoldAction = 'stageMicro' | 'stageSum' | 'progressSmall' | 'progressHuge' | 'hooksPost' | 'retry2' | 'exitLanded' | 'exitCancelled'
  const alphabet: readonly FoldAction[] = ['stageMicro', 'stageSum', 'progressSmall', 'progressHuge', 'hooksPost', 'retry2', 'exitLanded', 'exitCancelled']
  let count = 0
  let firstErr: string | null = null

  for (const sessionMemory of [false, true]) {
    for (const microcompaction of [false, true]) {
      enumerateActions(alphabet, 3, seq => {
        if (firstErr !== null) return
        count++
        let real = foldStatus.beginFoldStatus({ trigger: 'manual', startedAtMs: 1000, sessionMemory, microcompaction })
        const stages = [...real.stages]
        let stageIdx = -1
        let fill: number | null = null
        let attempt = 1
        let exit: FoldExit | undefined = undefined

        const advance = (name: 'micro-compaction' | 'summarising' | 'restoring'): void => {
          const next = stages.indexOf(name)
          if (next === -1 || next <= stageIdx) return
          stageIdx = next
          fill = null
        }

        for (let i = 0; i < seq.length; i++) {
          const act = seq[i]!
          if (act === 'stageMicro') {
            real = foldStatus.foldStatusOnEvent(real, { type: 'stage', stage: 'micro-compaction' })
            if (exit === undefined) advance('micro-compaction')
          } else if (act === 'stageSum') {
            real = foldStatus.foldStatusOnEvent(real, { type: 'compact_start' })
            if (exit === undefined) advance('summarising')
          } else if (act === 'progressSmall' || act === 'progressHuge') {
            const chars = act === 'progressSmall' ? 400 : 10_000_000
            real = foldStatus.foldStatusOnEvent(real, { type: 'summary_progress', chars })
            const sumIdx = stages.indexOf('summarising')
            if (exit === undefined && stageIdx <= sumIdx) {
              const tokens = Math.max(0, Math.floor(chars / 4))
              const measured = real.summaryCapTokens > 0 ? Math.min(1, tokens / real.summaryCapTokens) : 0
              const nextFill = Math.max(fill ?? 0, measured)
              advance('summarising')
              fill = nextFill
            }
          } else if (act === 'hooksPost') {
            real = foldStatus.foldStatusOnEvent(real, { type: 'hooks_start', hookType: 'post_compact' })
            if (exit === undefined) advance('restoring')
          } else if (act === 'retry2') {
            real = foldStatus.foldStatusOnEvent(real, { type: 'retry', attempt: 2 })
            if (exit === undefined) attempt = Math.max(attempt, 2)
          } else if (act === 'exitLanded' || act === 'exitCancelled') {
            const ex: FoldExit = act === 'exitLanded' ? 'landed' : 'cancelled'
            real = foldStatus.foldStatusExit(real, ex, 2000 + i)
            exit = ex
          }
          const wantStage = stageIdx === -1 ? null : stages[stageIdx]!
          const decoded = foldStatus.decodeFoldStatus(JSON.parse(JSON.stringify(real)))
          if (
            real.stage !== wantStage ||
            real.fill !== fill ||
            real.attempt !== attempt ||
            real.exit !== exit ||
            decoded === null ||
            JSON.stringify(decoded) !== JSON.stringify(real)
          ) {
            firstErr = `fold trace ${count} (${seq.join('>')}) step ${i}: real=(${real.stage},${real.fill},${real.attempt},${real.exit}) oracle=(${wantStage},${fill},${attempt},${exit})`
            return
          }
        }
      })
    }
  }
  t.check(`all ${count} exhaustive compaction-status traces matched the independent monotonic/exit oracle`, firstErr === null, firstErr ?? '')
}

function checkEditVerifyStatusModel(): void {
  t.section('§8 — bounded model #edit-verify-status (J1/J2 edit invalidation, bad effects, stop evaluator)')
  type EvAction = 'editOk' | 'editFail' | 'readOnly' | 'checkFail' | 'checkPass' | 'complete'
  const alphabet: readonly EvAction[] = ['editOk', 'editFail', 'readOnly', 'checkFail', 'checkPass', 'complete']
  const owner = makeOwnerKey({ workspace: root, sessionId: '00000000-0000-4000-8000-00000000c308', lane: 'main' })
  let count = 0
  let firstErr: string | null = null

  const runSeq = (seq: readonly EvAction[]): string | null => {
    let snap = runKernel.emptyRunSnapshot({ runId: 'run_edit_verify', owner, objective: 'fix greeting', rootMessageId: null, at: 1 })
    let ver: 'unverified' | 'verified' | 'stale' | 'failed' = 'unverified'
    let bad = 0
    let muts = 0
    let subst = false
    let life: 'active' | 'completed' = 'active'
    let tick = 10
    for (let i = 0; i < seq.length; i++) {
      const act = seq[i]!
      tick += 10
      if (act === 'editOk') {
        snap = runKernel.reduceRunEvent(snap, { type: 'tool-effected', at: tick, toolName: 'Edit', toolUseId: `e_${i}`, operation: 'edit apply', outcome: 'succeeded', changedPaths: ['src/greet.ts'] })
        subst = true
        bad = 0
        muts += 1
        if (ver === 'verified') ver = 'stale'
      } else if (act === 'editFail') {
        snap = runKernel.reduceRunEvent(snap, { type: 'tool-effected', at: tick, toolName: 'Edit', toolUseId: `f_${i}`, operation: 'edit apply', outcome: 'failed', changedPaths: [] })
        bad += 1
      } else if (act === 'readOnly') {
        snap = runKernel.reduceRunEvent(snap, { type: 'tool-effected', at: tick, toolName: 'Read', toolUseId: `r_${i}`, operation: 'read', outcome: 'succeeded', changedPaths: [] })
      } else if (act === 'checkFail') {
        snap = runKernel.reduceRunEvent(snap, { type: 'evidence', at: tick, state: 'failed', detail: 'FAIL' })
        ver = 'failed'
        muts = 0
      } else if (act === 'checkPass') {
        snap = runKernel.reduceRunEvent(snap, { type: 'evidence', at: tick, state: 'verified', detail: 'PASS' })
        ver = 'verified'
        muts = 0
      } else if (act === 'complete') {
        snap = runKernel.reduceRunEvent(snap, { type: 'completed', at: tick, satisfied: ['PASS'] })
        life = 'completed'
      }
      const stop = completionEvaluator.evaluateStop({
        snapshot: snap,
        wordingUnfinished: false,
        continuationsThisTurn: 0,
        maxContinuationsPerTurn: 3,
        aborted: false,
        apiError: false,
        verification: { state: snap.verification.state, mutationsSinceEvidence: muts, workspaceVerifiable: true, priorEvidenceDemands: 0 },
        pendingIdeFeedback: false,
        surface: 'interactive',
      })
      const wantStop = !subst || life === 'completed' ? 'complete' : bad > 0 || muts > 0 || ver === 'failed' ? 'continue' : 'complete'
      const wantDemand = subst && life !== 'completed' && bad === 0 && (muts > 0 || ver === 'failed')
      if (
        snap.verification.state !== ver ||
        snap.unresolvedBadEffects !== bad ||
        snap.lifecycle !== life ||
        stop.kind !== wantStop ||
        (stop.kind === 'continue' && Boolean(stop.evidenceDemand) !== wantDemand)
      ) {
        return `${seq.join('>')} step ${i}: real=(ver=${snap.verification.state},bad=${snap.unresolvedBadEffects},stop=${stop.kind}) oracle=(ver=${ver},bad=${bad},stop=${wantStop})`
      }
    }
    return null
  }

  const j2Scenario = runSeq(['checkFail', 'editFail', 'editOk', 'readOnly', 'checkPass', 'editOk', 'checkPass', 'complete'])
  t.check('J1/J2 reproduce -> failed edit -> fix -> read-only -> verify -> stale -> re-verify -> complete matches oracle', j2Scenario === null, j2Scenario ?? '')
  enumerateActions(alphabet, 4, seq => {
    if (firstErr !== null) return
    count++
    firstErr = runSeq(seq)
  })
  t.check(`all ${count} exhaustive edit-verification traces matched the independent kernel + stop-evaluator oracle`, firstErr === null, firstErr ?? '')
}

function checkDeliverablesPanelsModel(): void {
  t.section('§9 — bounded model #deliverables-panels (J3 kernel + /run + /workbench + stop agreement)')
  type DelAction = 'd1InProg' | 'd1Done' | 'd2InProg' | 'd2Done' | 'd3Drop' | 'complete'
  const alphabet: readonly DelAction[] = ['d1InProg', 'd1Done', 'd2InProg', 'd2Done', 'd3Drop', 'complete']
  const owner = makeOwnerKey({ workspace: root, sessionId: '00000000-0000-4000-8000-00000000c309', lane: 'main' })
  let count = 0
  let firstErr: string | null = null

  enumerateActions(alphabet, 4, seq => {
    if (firstErr !== null) return
    count++
    let snap = runKernel.emptyRunSnapshot({ runId: 'run_j3_panels', owner, objective: 'Modernize fixture', rootMessageId: null, at: 1 })
    snap = runKernel.reduceRunEvent(snap, { type: 'task-transition', at: 2, taskId: 'd1', title: 'Config', state: 'open' })
    snap = runKernel.reduceRunEvent(snap, { type: 'task-transition', at: 3, taskId: 'd2', title: 'Docs', state: 'open' })
    snap = runKernel.reduceRunEvent(snap, { type: 'task-transition', at: 4, taskId: 'd3', title: 'Release', state: 'open' })
    const states = new Map<string, 'open' | 'in-progress' | 'done' | 'dropped'>([['d1', 'open'], ['d2', 'open'], ['d3', 'open']])
    let tick = 10

    for (let i = 0; i < seq.length; i++) {
      const act = seq[i]!
      tick += 10
      if (act === 'd1InProg') { snap = runKernel.reduceRunEvent(snap, { type: 'task-transition', at: tick, taskId: 'd1', title: 'Config', state: 'in-progress' }); states.set('d1', 'in-progress') }
      else if (act === 'd1Done') { snap = runKernel.reduceRunEvent(snap, { type: 'task-transition', at: tick, taskId: 'd1', title: 'Config', state: 'done' }); states.set('d1', 'done') }
      else if (act === 'd2InProg') { snap = runKernel.reduceRunEvent(snap, { type: 'task-transition', at: tick, taskId: 'd2', title: 'Docs', state: 'in-progress' }); states.set('d2', 'in-progress') }
      else if (act === 'd2Done') { snap = runKernel.reduceRunEvent(snap, { type: 'task-transition', at: tick, taskId: 'd2', title: 'Docs', state: 'done' }); states.set('d2', 'done') }
      else if (act === 'd3Drop') { snap = runKernel.reduceRunEvent(snap, { type: 'task-transition', at: tick, taskId: 'd3', title: 'Release', state: 'dropped' }); states.set('d3', 'dropped') }
      else if (act === 'complete') { snap = runKernel.reduceRunEvent(snap, { type: 'completed', at: tick, satisfied: ['closed'] }) }

      const openIds = ['d1', 'd2', 'd3'].filter(id => states.get(id) === 'open' || states.get(id) === 'in-progress')
      const doneCount = ['d1', 'd2', 'd3'].filter(id => states.get(id) === 'done').length
      const activeId = ['d1', 'd2', 'd3'].find(id => states.get(id) === 'in-progress') ?? null
      const d3Blocked = (states.get('d3') === 'open' || states.get('d3') === 'in-progress') && states.get('d1') !== 'done'

      const tasks = ['d1', 'd2', 'd3'].map(id => ({
        id,
        subject: id,
        status: states.get(id) === 'done' ? 'completed' : states.get(id) === 'in-progress' ? 'in_progress' : 'pending',
        blockedBy: id === 'd3' ? ['d1'] : [],
      }))
      const rows = runInspector.buildRunRows(snap, tick + 1000)
      const delRow = rows.find(r => r.section === 'DELIVERABLES')
      const cw = currentWork.deriveCurrentWork({
        now: tick + 1000,
        owner,
        workspace: root,
        run: snap,
        tasks,
        workbench: null,
        model: 'claude-opus-5',
        effortLabel: 'high',
        contextPct: null,
        recovery: { state: 'live' },
      })
      const stop = completionEvaluator.evaluateStop({
        snapshot: snap,
        wordingUnfinished: false,
        continuationsThisTurn: 0,
        maxContinuationsPerTurn: 3,
        aborted: false,
        apiError: false,
        verification: null,
        pendingIdeFeedback: false,
        surface: 'interactive',
      })
      const wantTone = openIds.length === 0 ? 'ok' : 'accent'
      const wantStop = openIds.length > 0 ? 'continue' : 'complete'
      if (
        runKernel.openDeliverables(snap).length !== openIds.length ||
        !delRow ||
        !delRow.line.startsWith(`${doneCount}/3 done`) ||
        delRow.tone !== wantTone ||
        cw.scale !== 'substantial' ||
        cw.planItems.length !== 3 ||
        cw.completedCount !== doneCount ||
        (cw.activeItem?.id ?? null) !== activeId ||
        cw.blockedItems.some(b => b.id === 'd3') !== d3Blocked ||
        stop.kind !== wantStop
      ) {
        firstErr = `${seq.join('>')} step ${i}: open=${openIds.length} done=${doneCount} active=${activeId} blocked=${d3Blocked} delRow=${delRow?.line} cwBlocked=${cw.blockedItems.map(b => b.id).join(',')} stop=${stop.kind}`
        return
      }
    }
  })
  t.check(`all ${count} exhaustive multi-panel deliverable traces agreed across kernel, /run, /workbench, and stop evaluator`, firstErr === null, firstErr ?? '')
}

async function checkDraftExcursionModel(): Promise<void> {
  t.section('§10 — bounded model #draft-excursion (J5 unsent draft + work identity across excursion & Esc)')
  const sidA = '00000000-0000-4000-8000-00000000c3a5'
  const sidB = '00000000-0000-4000-8000-00000000c3b5'
  const ownerA = makeOwnerKey({ workspace: root, sessionId: sidA, lane: 'main' })
  let seed = runKernel.emptyRunSnapshot({ runId: 'run_j5_c3', owner: ownerA, objective: 'Modernize fixture', rootMessageId: null, at: 1 })
  for (let k = 1; k <= 5; k++) {
    seed = runKernel.reduceRunEvent(seed, { type: 'task-transition', at: 1 + k, taskId: `p${k}`, title: `Item ${k}`, state: k <= 2 ? 'done' : k === 3 ? 'in-progress' : 'open' })
  }
  await runSidecar.saveRunSidecar(ownerA, seed)

  type DraftAct = 'typeA1' | 'typeA2' | 'typeB1' | 'pushBoot' | 'pushConcourse' | 'esc' | 'staleEsc' | 'emptyA' | 'delB'
  const traces: DraftAct[][] = [
    ['typeA1', 'pushBoot', 'esc', 'pushConcourse', 'esc'],
    ['typeA1', 'typeB1', 'pushBoot', 'pushConcourse', 'staleEsc', 'esc', 'esc'],
    ['typeA1', 'pushBoot', 'typeA2', 'esc', 'delB', 'emptyA'],
    ['typeB1', 'typeA1', 'pushConcourse', 'esc', 'delB', 'pushBoot', 'esc'],
  ]
  const alpha: readonly DraftAct[] = ['typeA1', 'typeB1', 'pushBoot', 'pushConcourse', 'esc', 'emptyA']
  enumerateActions(alpha, 3, seq => traces.push(seq))

  let firstErr: string | null = null
  let checked = 0
  for (const seq of traces.slice(0, 64)) {
    checked++
    promptDraft.deleteDraft(sidA)
    promptDraft.deleteDraft(sidB)
    await promptDraft.flushDraftSaves()
    surface._resetSurfaceRouteForTesting()
    surface.registerRouteSurface('session', { render: () => null })
    surface.registerRouteSurface('concourse', { render: () => null })
    surface.registerRouteSurface('boot-settings', { render: () => null })
    surface.registerChatPresence({ present: () => true, subscribe: () => () => {} })

    let route = 'repl'
    const stack: Array<{ to: string; token: SurfaceReturnToken }> = []
    let firstToken: SurfaceReturnToken | null = null
    const oracleDrafts = new Map<string, string | null>([[sidA, null], [sidB, null]])

    for (let i = 0; i < seq.length; i++) {
      const act = seq[i]!
      if (act === 'typeA1' || act === 'typeA2' || act === 'typeB1') {
        const sid = act === 'typeB1' ? sidB : sidA
        const text = act === 'typeA1' ? 'cover parser edge cases' : act === 'typeA2' ? 'cover parser edge cases /diff' : 'sibling draft B'
        promptDraft.saveDraftDebounced(sid, { text, cursorOffset: text.length, mode: 'prompt', pastedContents: {} })
        await promptDraft.flushDraftSaves()
        oracleDrafts.set(sid, text)
      } else if (act === 'emptyA') {
        promptDraft.saveDraftDebounced(sidA, { text: '   ', cursorOffset: 3, mode: 'prompt', pastedContents: {} })
        await promptDraft.flushDraftSaves()
        oracleDrafts.set(sidA, null)
      } else if (act === 'delB') {
        promptDraft.deleteDraft(sidB)
        await promptDraft.flushDraftSaves()
        oracleDrafts.set(sidB, null)
      } else if (act === 'pushBoot' || act === 'pushConcourse') {
        const target = act === 'pushBoot' ? 'boot-settings' : 'concourse'
        const r = act === 'pushBoot' ? surface.enterBootSettings() : surface.enterConcourse()
        if (route !== target) {
          if (!r.ok) { firstErr = `${seq.join('>')} step ${i}: push ${target} failed`; break }
          stack.push({ to: route, token: r.token })
          if (firstToken === null) firstToken = r.token
          route = target
        } else if (r.ok) {
          firstErr = `${seq.join('>')} step ${i}: duplicate push ${target} succeeded`
          break
        }
      } else if (act === 'esc') {
        const r = surface.leaveCurrentSurface()
        const top = stack.pop()
        if (Boolean(top) !== r.ok) { firstErr = `${seq.join('>')} step ${i}: esc mismatch`; break }
        if (top) route = top.to
      } else if (act === 'staleEsc') {
        if (firstToken && stack.length >= 2) {
          const r = surface.returnFromSurface(firstToken)
          if (r.ok) { firstErr = `${seq.join('>')} step ${i}: stale token moved route`; break }
        }
      }
      const gotA = promptDraft.readDraftSync(sidA)
      const gotB = promptDraft.readDraftSync(sidB)
      const wantA = oracleDrafts.get(sidA) ?? null
      const wantB = oracleDrafts.get(sidB) ?? null
      if (
        surface.surfaceRouteId(surface.currentSurfaceRoute()) !== route ||
        (gotA?.text ?? null) !== wantA ||
        (gotA !== null && gotA.cursorOffset !== wantA!.length) ||
        (gotB?.text ?? null) !== wantB
      ) {
        firstErr = `${seq.join('>')} step ${i} (${act}): route=${surface.surfaceRouteId(surface.currentSurfaceRoute())}/${route} A=${gotA?.text ?? null}/${wantA} B=${gotB?.text ?? null}/${wantB}`
        break
      }
    }
    if (firstErr !== null) break
    const loaded = await runSidecar.loadRunSidecar(ownerA)
    if (loaded.state !== 'loaded' || loaded.snapshot.runId !== 'run_j5_c3' || loaded.snapshot.deliverables.length !== 5) {
      firstErr = `${seq.join('>')}: sidecar identity lost after excursions`
      break
    }
  }
  promptDraft.cancelPendingDraftSave()
  t.check(`all ${checked} bounded draft-excursion traces preserved unsent draft, session isolation, and 5-item work identity`, firstErr === null, firstErr ?? '')
}

async function checkSignInReceiptCancelModel(): Promise<void> {
  t.section('§11 — bounded model #signin-receipt-cancel (receipt identity, cancel rollback, OAuth state binding)')
  type LedgerAct = 'anthOauth' | 'anthKey' | 'openaiOauth' | 'cancelAnth' | 'cancelOpenai' | 'invalidFam'
  const traces: LedgerAct[][] = [
    ['anthOauth', 'cancelAnth', 'openaiOauth', 'cancelOpenai'],
    ['cancelAnth', 'anthOauth', 'anthKey', 'cancelAnth'],
    ['openaiOauth', 'anthOauth', 'invalidFam', 'cancelAnth', 'cancelOpenai'],
  ]
  const alpha: readonly LedgerAct[] = ['anthOauth', 'anthKey', 'openaiOauth', 'cancelAnth', 'cancelOpenai', 'invalidFam']
  enumerateActions(alpha, 3, seq => traces.push(seq))

  let checked = 0
  let firstErr: string | null = null
  for (const seq of traces.slice(0, 64)) {
    checked++
    const home = join(root, 'signin-ledger', `t-${checked}`)
    mkdirSync(home, { recursive: true })
    let clock = 1000
    const io: SignInLedgerIo = { home, now: () => ++clock }
    const oracle = new Map<string, { at: number; kind: SignInKind }>()
    let epoch = signInLedger.signInLedgerEpoch()

    for (let i = 0; i < seq.length; i++) {
      const act = seq[i]!
      if (act === 'anthOauth' || act === 'anthKey' || act === 'openaiOauth') {
        const fam = act === 'openaiOauth' ? 'openai' : 'anthropic'
        const kind: SignInKind = act === 'anthKey' ? 'api-key' : 'oauth'
        const ok = signInLedger.recordSignIn(fam, kind, io)
        if (!ok) { firstErr = `${seq.join('>')} step ${i}: recordSignIn failed`; break }
        oracle.set(fam, { at: clock, kind })
        epoch += 1
      } else if (act === 'cancelAnth' || act === 'cancelOpenai') {
        const fam = act === 'cancelAnth' ? 'anthropic' : 'openai'
        const restore = signInLedger.signInRecordRestorer(fam, io)
        const ok = signInLedger.recordSignIn(fam, 'operator-switch', io)
        if (!ok) { firstErr = `${seq.join('>')} step ${i}: tentative record failed`; break }
        restore()
        epoch += 2
      } else if (act === 'invalidFam') {
        const ok = signInLedger.recordSignIn('BAD FAMILY!', 'oauth', io)
        if (ok) { firstErr = `${seq.join('>')} step ${i}: invalid family accepted`; break }
      }
      const realLedger = signInLedger.readSignInLedger(io)
      const realKeys = Object.keys(realLedger).sort()
      const wantKeys = [...oracle.keys()].sort()
      const sameEntries =
        JSON.stringify(realKeys) === JSON.stringify(wantKeys) &&
        wantKeys.every(k => realLedger[k]?.kind === oracle.get(k)?.kind && realLedger[k]?.at === oracle.get(k)?.at)
      if (!sameEntries || signInLedger.signInLedgerEpoch() !== epoch) {
        firstErr = `${seq.join('>')} step ${i} (${act}): ledger=${JSON.stringify(realLedger)} oracle=${JSON.stringify([...oracle.entries()])} epoch=${signInLedger.signInLedgerEpoch()}/${epoch}`
        break
      }
    }
    if (firstErr !== null) break
  }
  t.check(`all ${checked} bounded sign-in ledger traces held family isolation, cancel rollback, and epoch monotonicity`, firstErr === null, firstErr ?? '')

  const receiptCases: Array<[string | null | undefined, string]> = [
    [null, 'Login successful'],
    [undefined, 'Login successful'],
    ['', 'Login successful'],
    ['   ', 'Login successful'],
    ['first@fixture.example', 'Login successful — signed in as first@fixture.example'],
    ['  second@fixture.example  ', 'Login successful — signed in as second@fixture.example'],
  ]
  const receiptOk = receiptCases.every(([input, want]) => loginSuccessReceipt(input) === want)
  t.check('loginSuccessReceipt formats trimmed identity and falls back cleanly on blank identity', receiptOk)

  const listener = new AuthCodeListener('/callback')
  let listenerErr = ''
  try {
    const port = await listener.start(0)
    const badStateP = listener.waitForAuthorization('state-good').then(() => 'resolved', (e: Error) => e.message)
    const badStateRes = await fetch(`http://localhost:${port}/callback?code=c1&state=state-wrong`, { redirect: 'manual' })
    const badStateMsg = await badStateP
    if (badStateRes.status !== 400 || !badStateMsg.includes('Invalid state')) {
      listenerErr = `wrong-state returned ${badStateRes.status} / ${badStateMsg}`
    }
    if (!listenerErr) {
      const noCodeP = listener.waitForAuthorization('state-good').then(() => 'resolved', (e: Error) => e.message)
      const noCodeRes = await fetch(`http://localhost:${port}/callback?state=state-good`, { redirect: 'manual' })
      const noCodeMsg = await noCodeP
      if (noCodeRes.status !== 400 || !noCodeMsg.includes('No authorization code')) {
        listenerErr = `missing-code returned ${noCodeRes.status} / ${noCodeMsg}`
      }
    }
    if (!listenerErr) {
      const okP = listener.waitForAuthorization('state-good')
      const fetchP = fetch(`http://localhost:${port}/callback?code=fixture-auth-code&state=state-good`, { redirect: 'manual' })
      const code = await okP
      const hadPending = listener.hasPendingResponse()
      listener.close()
      const okRes = await fetchP
      if (code !== 'fixture-auth-code' || !hadPending || listener.hasPendingResponse() || okRes.status !== 302) {
        listenerErr = `valid/close mismatch code=${code} hadPending=${hadPending} afterClose=${listener.hasPendingResponse()} status=${okRes.status}`
      }
    }
  } finally {
    listener.close()
  }
  t.check('AuthCodeListener rejects wrong state and missing code, resolves matching state, and cleans up on close', listenerErr === '', listenerErr)
}

checkObligationTable()
checkSurfaceRouteModel()
await checkRunIdentityModel()
await checkPermissionAnswerModel()
checkSaturnHoldFireModel()
checkUpdatePointerModel()
checkCompactFoldStatusModel()
checkEditVerifyStatusModel()
checkDeliverablesPanelsModel()
await checkDraftExcursionModel()
await checkSignInReceiptCancelModel()

t.finish('prove-major-flows')
