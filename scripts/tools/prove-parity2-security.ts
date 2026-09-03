#!/usr/bin/env bun
// ============================================================================
//  prove-parity2-security — frontier-sweep #2, the security /
//  permission-honesty tier, mechanism-pinned:
//
//   1. Refocus click is focus-only (packet 20): the left press that brings
//      the terminal forward — the focus store still blurred, or within the
//      refocus window of a DECSET-1004 focus-in — never reaches the click
//      dispatcher; the matching release is swallowed with it.
//   2. Shift+tab inside a feedback field never approves (packet 29): the
//      file dialog's mode-cycle chord is inert while either feedback field
//      is open.
//   3. Lock teardown ownership (packet 73): every hand-rolled lock estate
//      releases ONLY what still names this process — the mneme consolidate
//      lock, the autoDream consolidation lock, the review-artifact write
//      fence, the OpenAI refresh lock.
//   4. IDE selection line truth (packet 79): the zero-based wire line is
//      reported as the one-based line the editor displays.
//   5. Parked permission asks expire (rider R4): the shared inactivity
//      deadline retires an unanswered ask with a typed denial through the
//      child's control channel and settles the obligation visibly; an
//      answered ask disarms its deadline; the limit 0 means never.
//   6. The deadline primitive itself: progress resets the clock, silence
//      expires it, cancel disarms, a non-positive limit is inert, the error
//      is typed and names the seam.
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { entryToRecord } from '../../src/fabric/entryCodec.js'
import { ordinalOf } from '../../src/fabric/ordinal.js'
let __ord = 0
const __encRecordLine = (e: unknown): string =>
  JSON.stringify(
    entryToRecord(e as never, {
      sessionId: 'parity2-proof',
      nextOrdinal: () => ordinalOf(++__ord),
      observedAt: '2026-08-01T10:00:00.000Z',
      source: { channel: 'interactive' },
    } as never),
  )

import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'parity2-security-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const crewDir = join(SCRATCH, 'crew')
for (const d of [home, daemonDir, crewDir]) mkdirSync(d, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREW_DIR = crewDir
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// —— 6. the deadline primitive ————————————————————————————————————————
const { armInactivityDeadline, withInactivityDeadline, isDeadlineExceeded, DeadlineExceededError, minutesKnobToMs, formatLimit } =
  await import('../../src/utils/deadline.ts')
{
  let clock = 1_000
  const now = () => clock
  let expired: unknown = null
  const dl = armInactivityDeadline({ seam: 'prover seam', limitMs: 100, advice: 'try again', now, onExpire: e => (expired = e) })
  t('deadline arms', dl.armed && !dl.fired)
  // Progress at 80ms keeps it alive past the original 100ms mark.
  clock = 1_080
  dl.touch()
  await sleep(110)
  t('progress before the limit resets the clock (no expiry at the original mark)', !dl.fired && expired === null)
  // Silence from the touch: expires once the re-armed remainder elapses.
  clock = 1_190
  await sleep(130)
  t('silence past the limit expires', dl.fired && expired instanceof DeadlineExceededError)
  const err = expired as InstanceType<typeof DeadlineExceededError>
  t('the error is typed and names the seam, the limit, the progress, the advice',
    isDeadlineExceeded(err) && err.seam === 'prover seam' && err.limitMs === 100 && err.progressCount === 1 && /try again/.test(err.message),
    err?.message)
  t('the signal aborts on expiry', dl.signal.aborted)
  let raced: unknown = null
  await dl.expiry.catch(e => (raced = e))
  t('the expiry promise rejects with the same error', raced === expired)

  const off = armInactivityDeadline({ seam: 'off', limitMs: 0 })
  t('a zero limit is inert (never fires, never arms)', !off.armed && !off.fired)
  off.touch()
  off.cancel()

  const cancelled = armInactivityDeadline({ seam: 'cancel', limitMs: 30 })
  cancelled.cancel()
  await sleep(60)
  t('cancel disarms before expiry', !cancelled.fired)

  const ok = await withInactivityDeadline({ seam: 'fast work', limitMs: 200 }, async () => 'done')
  t('withInactivityDeadline returns the work result when it settles in time', ok === 'done')
  let slowErr: unknown = null
  await withInactivityDeadline({ seam: 'slow work', limitMs: 30 }, () => new Promise<never>(() => {})).catch(e => (slowErr = e))
  t('withInactivityDeadline rejects typed when the work stays silent', isDeadlineExceeded(slowErr))

  t('minutes knob: default / explicit / zero / junk', minutesKnobToMs(undefined, 30) === 1_800_000 && minutesKnobToMs('2', 30) === 120_000 && minutesKnobToMs('0', 30) === 0 && minutesKnobToMs('lots', 30) === 1_800_000)
  t('formatLimit reads as a human span', formatLimit(1_800_000) === '30m' && formatLimit(90_000) === '1m30s' && formatLimit(250) === '250ms')
}

// —— 1. refocus click is focus-only ————————————————————————————————————
{
  const { isRefocusPress } = await import('../../src/ink/components/App.tsx')
  t('a press while the focus store reads blurred is focus-only', isRefocusPress({ focused: false, refocusedAt: -1, now: 10_000 }))
  t('a press 50ms after a focus-in is focus-only', isRefocusPress({ focused: true, refocusedAt: 9_950, now: 10_000 }))
  t('a press in the same batch as the focus-in (0ms) is focus-only', isRefocusPress({ focused: true, refocusedAt: 10_000, now: 10_000 }))
  t('a press 2s after the focus-in is a real click', !isRefocusPress({ focused: true, refocusedAt: 8_000, now: 10_000 }))
  t('a press with no focus-in ever seen, focused, is a real click', !isRefocusPress({ focused: true, refocusedAt: -1, now: 10_000 }))
}

// —— 2. shift+tab inside a feedback field never approves ———————————————
{
  const { cycleModeMayApprove } = await import('../../src/components/permissions/FilePermissionDialog/useFilePermissionDialog.ts')
  t('no feedback field open ⇒ the chord may approve', cycleModeMayApprove({ yesInputMode: false, noInputMode: false }))
  t('reject feedback open ⇒ inert', !cycleModeMayApprove({ yesInputMode: false, noInputMode: true }))
  t('accept feedback open ⇒ inert', !cycleModeMayApprove({ yesInputMode: true, noInputMode: false }))
}

// —— 3. lock teardown ownership ——————————————————————————————————————————
{
  const { consolidateLockOwnedBy } = await import('../../src/memdir/mnemeConsolidate.ts')
  const lock = join(SCRATCH, '.consolidate.lock')
  mkdirSync(lock)
  writeFileSync(join(lock, 'pid'), String(process.pid))
  t('mneme lock: our pid ⇒ releasable', consolidateLockOwnedBy(lock, process.pid))
  writeFileSync(join(lock, 'pid'), String(process.pid + 1))
  t("mneme lock: a successor's pid ⇒ NOT ours to remove", !consolidateLockOwnedBy(lock, process.pid))
  rmSync(join(lock, 'pid'))
  t('mneme lock: no pid file (pre-pid shape) ⇒ releasable', consolidateLockOwnedBy(lock, process.pid))

  const { consolidationLockHeldBy } = await import('../../src/services/autoDream/consolidationLock.ts')
  const dream = join(SCRATCH, '.consolidation.lock')
  writeFileSync(dream, String(process.pid))
  t('autoDream lock: our pid ⇒ held by us', await consolidationLockHeldBy(dream, process.pid))
  writeFileSync(dream, String(process.pid + 7))
  t("autoDream lock: a reclaimer's pid ⇒ not ours", !(await consolidationLockHeldBy(dream, process.pid)))
  t('autoDream lock: missing file ⇒ nobody holds it', !(await consolidationLockHeldBy(join(SCRATCH, 'absent'), process.pid)))

  const { artifactLockOwnedBy } = await import('../../src/utils/artifacts/reviewStore.ts')
  const fence = join(SCRATCH, '.write-lock')
  mkdirSync(fence)
  writeFileSync(join(fence, 'owner'), '1:abc')
  t('review fence: matching token ⇒ ours', artifactLockOwnedBy(fence, '1:abc'))
  t('review fence: a different token ⇒ a successor owns it', !artifactLockOwnedBy(fence, '1:zzz'))
  rmSync(join(fence, 'owner'))
  t('review fence: no token (pre-token lock) ⇒ releasable', artifactLockOwnedBy(fence, '1:abc'))

  const { refreshLockStampedBy } = await import('../../src/services/providers/openai/openaiAccounts.ts')
  const stamp = join(SCRATCH, 'auth.refresh-lock')
  writeFileSync(stamp, `${process.pid} ${Date.now()}\n`)
  t('refresh lock: our stamp ⇒ ours', refreshLockStampedBy(stamp, process.pid))
  writeFileSync(stamp, `${process.pid + 3} ${Date.now()}\n`)
  t("refresh lock: a takeover's stamp ⇒ not ours", !refreshLockStampedBy(stamp, process.pid))
  t('refresh lock: missing ⇒ nothing to release', !refreshLockStampedBy(join(SCRATCH, 'absent-lock'), process.pid))
}

// —— 4. IDE selection line truth ———————————————————————————————————————
{
  const { displayedLineOf } = await import('../../src/hooks/useIdeSelection.ts')
  t('wire line 12 displays as line 13', displayedLineOf(12) === 13)
  t('wire line 0 displays as line 1', displayedLineOf(0) === 1)
}

// —— 5. parked permission asks expire ——————————————————————————————————
{
  const { onWorkerControlRequest, answerPermissionAsk, listPendingPermissionAsks, expiredAskDenialMessage, permissionAskExpiryMs, DEFAULT_PERMISSION_ASK_EXPIRY_MINUTES } =
    await import('../../src/daemon/permissionAsks.ts')
  const { concourseWorkersPath } = await import('../../src/daemon/concourseSupervisor.ts')
  const record = (short: string) => ({
    runnerId: short,
    sessionId: `sess-${short}`,
    workspaceId: join(SCRATCH, 'ws'),
    title: `t-${short}`,
    createdAt: Date.now(),
    startedAt: Date.now(),
  })
  writeFileSync(
    concourseWorkersPath(daemonDir),
    JSON.stringify({ version: 1, workers: { 'concourse-w1': record('concourse-w1'), 'concourse-w2': record('concourse-w2') } }),
  )
  const sent: Array<{ short: string; frame: Record<string, unknown> }> = []
  const channel = { control: (short: string, frame: string) => (sent.push({ short, frame: JSON.parse(frame) }), true) }
  const askFrame = (id: string, tool: string) => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, input: { command: 'ls' } } })

  t('default expiry is the registered 30-minute knob', permissionAskExpiryMs() === DEFAULT_PERMISSION_ASK_EXPIRY_MINUTES * 60_000)

  // Expiry: a 40ms limit fires into the channel as a typed denial.
  onWorkerControlRequest('concourse-w1', askFrame('req-expire', 'Bash'), daemonDir, channel, 40)
  t('the ask parks', listPendingPermissionAsks().some(a => a.requestId === 'req-expire'))
  await sleep(140)
  const expired = sent.find(s => (s.frame as { response?: { request_id?: string } }).response?.request_id === 'req-expire')
  const denial = (expired?.frame as { response?: { response?: { behavior?: string; message?: string } } } | undefined)?.response?.response
  t('expiry delivers a control_response DENY through the child channel', expired?.short === 'concourse-w1' && denial?.behavior === 'deny')
  t('the denial names the cause, the limit, and the next step',
    denial?.message === expiredAskDenialMessage('Bash', 40, 'expired') && /expired/.test(denial?.message ?? '') && /operator/.test(denial?.message ?? ''),
    denial?.message)
  t('the expired ask leaves the parked table', !listPendingPermissionAsks().some(a => a.requestId === 'req-expire'))

  // Obligation: settled visibly as withdrawn by the daemon's expiry. The row
  // lands through the ledger's own write cadence — read it on a bounded
  // poll (2 s), so a slower host observes the settled row rather than the
  // instant before it.
  const oblPath = join(crewDir, 'obligations-switchboard.json')
  type ObligationRow = { ref: string; status: string; settlement?: { by?: string } }
  const readObligation = (): ObligationRow | undefined => {
    const rows = existsSync(oblPath) ? (JSON.parse(readFileSync(oblPath, 'utf8')) as { obligations: Record<string, ObligationRow> }).obligations : {}
    return Object.values(rows).find(r => r.ref === 'permission:req-expire')
  }
  let row = readObligation()
  // Settle-aware patience (gate run 1, the 2-core runner): the LAW is that
  // the row settles withdrawn — the window is harness patience, and 2s
  // starved on a loaded box while every neighbouring expiry check passed.
  // Bounded at 10s; a genuinely unsettling row still reds, now with the
  // whole row named (absent vs unsettled tell apart on the next run).
  for (let waited = 0; row?.status !== 'withdrawn' && waited < 10_000; waited += 50) {
    await sleep(50)
    row = readObligation()
  }
  t('the obligation row settles withdrawn with the expiry named', row?.status === 'withdrawn' && /expired unanswered/.test(row?.settlement?.by ?? ''), row === undefined ? 'no obligation row appeared' : JSON.stringify(row))
  // THE MINT IS AWAITED (gate run 11): the settle sites route through ONE
  // owner that waits for the obligation write to land before resolving —
  // a settle that read `obligationId` alone settled nothing when the
  // expiry outran the mint, and the row stayed open for good.
  const asksSource = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'permissionAsks.ts'), 'utf8')
  t('every mint keeps its promise on the ask (obligationLanded) and every settle site awaits it through settleAskObligation',
    (asksSource.match(/ask\.obligationLanded = upsertObligation\(/g) ?? []).length === 2 &&
      (asksSource.match(/settleAskObligation\(ask, /g) ?? []).length === 4 &&
      (asksSource.match(/o\.resolveObligation\(/g) ?? []).length === 1 &&
      /const landed = ask\.obligationLanded \?\? Promise\.resolve\(ask\.obligationId\)/.test(asksSource),
    `mints=${(asksSource.match(/ask\.obligationLanded = upsertObligation\(/g) ?? []).length} settles=${(asksSource.match(/settleAskObligation\(ask, /g) ?? []).length}`)

  // Answered in time: the deadline disarms (no late denial arrives).
  onWorkerControlRequest('concourse-w2', askFrame('req-answer', 'Edit'), daemonDir, channel, 60)
  const r = answerPermissionAsk('req-answer', true, channel, 'operator')
  t('an answered ask applies', r.outcome === 'applied')
  await sleep(120)
  const lateDenials = sent.filter(s => (s.frame as { response?: { request_id?: string } }).response?.request_id === 'req-answer')
  t('an answered ask never receives a late expiry denial', lateDenials.length === 1 && (lateDenials[0]!.frame as { response: { response: { behavior: string } } }).response.response.behavior === 'allow')

  // Limit 0: never expires.
  onWorkerControlRequest('concourse-w2', askFrame('req-forever', 'Bash'), daemonDir, channel, 0)
  await sleep(60)
  t('a zero limit never expires', listPendingPermissionAsks().some(a => a.requestId === 'req-forever'))
  answerPermissionAsk('req-forever', false, channel, 'operator')

  // Eviction settles (the DF-101 deny-replay family): the
  // git-init door landing on a FULL table evicts the oldest WORKER ask WITH
  // its typed denial through the ask's carried channel — a bare delete
  // parked that child forever (no denial; its own expiry dead-ends on the
  // pending-identity guard).
  {
    const { mintGitInitAsk } = await import('../../src/daemon/permissionAsks.ts')
    const before = listPendingPermissionAsks().length
    const fillers: string[] = []
    for (let i = before; i < 200; i++) {
      const id = `req-fill-${i}`
      fillers.push(id)
      onWorkerControlRequest('concourse-w1', askFrame(id, 'Bash'), daemonDir, channel, 0)
    }
    const oldestId = listPendingPermissionAsks()[0]!.requestId
    mintGitInitAsk(join(SCRATCH, 'ws-evict'))
    const evictedFrame = sent.find(s => (s.frame as { response?: { request_id?: string } }).response?.request_id === oldestId)
    const evictedDenial = (evictedFrame?.frame as { response?: { response?: { behavior?: string; message?: string } } } | undefined)?.response?.response
    t('the eviction delivers a typed DENY through the carried channel', evictedDenial?.behavior === 'deny', oldestId)
    t('the eviction denial names the full table', /table was full/.test(evictedDenial?.message ?? ''), evictedDenial?.message)
    t('the evicted ask left the parked table', !listPendingPermissionAsks().some(a => a.requestId === oldestId))
    for (const id of fillers) answerPermissionAsk(id, false, channel, 'operator')
  }
}

// —— 7. a late DENY never replays the denied tool (sweep-4 DF-101 f2) ————
{
  const { handleOrphanedPermission } = await import('../../src/utils/queryHelpers.ts')
  const { killCapability, restoreCapability } = await import('../../src/utils/permissions/capabilityGate.ts')
  let toolRuns = 0
  const spyTool = {
    name: 'SpyTool',
    inputSchema: { safeParse: (value: unknown) => ({ success: true as const, data: value }) },
    call: async function* (): AsyncGenerator<unknown, void> {
      toolRuns++
      yield { message: { type: 'user', uuid: '00000000-0000-4000-8000-00000000ffff', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_lateanswer', content: [{ type: 'text', text: 'ran' }] }] } } }
    },
  }
  const assistantMessage = {
    type: 'assistant',
    uuid: '00000000-0000-4000-8000-00000000aaaa',
    timestamp: new Date().toISOString(),
    message: {
      id: 'msg_lateanswer',
      type: 'message',
      role: 'assistant',
      model: 'x',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', id: 'toolu_lateanswer', name: 'SpyTool', input: { command: 'rm -rf /tmp/x' } }],
    },
  }
  const drive = async (permissionResult: Record<string, unknown>): Promise<{ runs: number; settled: string | null }> => {
    const before = toolRuns
    const mutableMessages: unknown[] = []
    for await (const _projection of handleOrphanedPermission(
      { permissionResult, assistantMessage } as never,
      [spyTool] as never,
      mutableMessages as never,
      {} as never,
    )) {
      void _projection
    }
    const settled = mutableMessages
      .map(m => m as { type?: string; message?: { content?: Array<Record<string, unknown>> } })
      .filter(m => m.type === 'user' && Array.isArray(m.message?.content))
      .flatMap(m => m.message!.content!)
      .find(block => block.type === 'tool_result' && block.tool_use_id === 'toolu_lateanswer' && block.is_error === true)
    const text = settled ? JSON.stringify(settled.content) : null
    return { runs: toolRuns - before, settled: text }
  }

  const denied = await drive({ behavior: 'deny', toolUseID: 'toolu_lateanswer', message: 'not on this machine' })
  t('a late DENY runs NOTHING', denied.runs === 0)
  t('the deny settles as a rendered refusal carrying the reason', /Permission denied: not on this machine/.test(denied.settled ?? '') && /did not run/.test(denied.settled ?? ''), denied.settled ?? '(none)')
  const unanswered = await drive({ toolUseID: 'toolu_lateanswer' })
  t('a verdict-less answer runs NOTHING and says so', unanswered.runs === 0 && /never granted/.test(unanswered.settled ?? ''))
  const junk = await drive({ behavior: 'ask', toolUseID: 'toolu_lateanswer' })
  t('an ask-with-no-answer runs NOTHING', junk.runs === 0 && /never granted/.test(junk.settled ?? ''))

  killCapability(undefined, 'SpyTool')
  const killedRun = await drive({ behavior: 'allow', toolUseID: 'toolu_lateanswer', updatedInput: { command: 'echo hi' } })
  t('an ALLOW for a tool killed since the ask is refused at replay time', killedRun.runs === 0 && /kill switch/.test(killedRun.settled ?? ''), killedRun.settled ?? '(none)')
  restoreCapability(undefined, 'SpyTool')

  const allowed = await drive({ behavior: 'allow', toolUseID: 'toolu_lateanswer', updatedInput: { command: 'echo hi' } })
  t('the allow arm still runs exactly once (the control)', allowed.runs === 1)

  // The REAL admission half: the unexpected-response handler over a real
  // transcript — a DENY is admitted (so the dangling tool_use can settle),
  // deduplicated, and enqueued as the orphaned-permission command.
  const { handleOrphanedPermissionResponse } = await import('../../src/cli/headless/controlHandlers.ts')
  const { getTranscriptPath } = await import('../../src/utils/sessionStorage/paths.ts')
  const { dequeueAllMatching } = await import('../../src/input-core/command-queue.ts')
  const transcriptPath = getTranscriptPath()
  mkdirSync(join(transcriptPath, '..'), { recursive: true })
  writeFileSync(transcriptPath, `${__encRecordLine({ ...assistantMessage, sessionId: 'x', parentUuid: null })}\n`)
  const handled = new Set<string>()
  const response = {
    subtype: 'success',
    request_id: 'req-late-deny',
    response: { behavior: 'deny', toolUseID: 'toolu_lateanswer', message: 'not on this machine' },
  }
  const admitted = await handleOrphanedPermissionResponse({
    message: { type: 'control_response', response } as never,
    setAppState: () => {},
    handledToolUseIds: handled,
  })
  const queued = dequeueAllMatching(cmd => cmd.mode === 'orphaned-permission')
  t('the real admission enqueues the late deny for settlement', admitted === true && queued.length === 1 && (queued[0] as { orphanedPermission?: { permissionResult?: { behavior?: string } } }).orphanedPermission?.permissionResult?.behavior === 'deny')
  const replayAdmission = await handleOrphanedPermissionResponse({
    message: { type: 'control_response', response } as never,
    setAppState: () => {},
    handledToolUseIds: handled,
  })
  t('a transport replay of the same answer is deduplicated', replayAdmission === false && dequeueAllMatching(cmd => cmd.mode === 'orphaned-permission').length === 0)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures ? '\nFAILURES' : '\nALL GREEN')
process.exit(failures)
