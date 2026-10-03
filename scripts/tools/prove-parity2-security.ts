#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
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

const { armInactivityDeadline, withInactivityDeadline, isDeadlineExceeded, DeadlineExceededError, minutesKnobToMs, formatLimit } =
  await import('../../src/utils/deadline.ts')
{
  let clock = 1_000
  const now = () => clock
  let expired: unknown = null
  const dl = armInactivityDeadline({ seam: 'prover seam', limitMs: 100, advice: 'try again', now, onExpire: e => (expired = e) })
  t('deadline arms', dl.armed && !dl.fired)
  clock = 1_080
  dl.touch()
  await sleep(110)
  t('progress before the limit resets the clock (no expiry at the original mark)', !dl.fired && expired === null)
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

{
  const { isRefocusPress } = await import('../../src/ink/components/App.tsx')
  t('a press while the focus store reads blurred is focus-only', isRefocusPress({ focused: false, refocusedAt: -1, now: 10_000 }))
  t('a press 50ms after a focus-in is focus-only', isRefocusPress({ focused: true, refocusedAt: 9_950, now: 10_000 }))
  t('a press in the same batch as the focus-in (0ms) is focus-only', isRefocusPress({ focused: true, refocusedAt: 10_000, now: 10_000 }))
  t('a press 2s after the focus-in is a real click', !isRefocusPress({ focused: true, refocusedAt: 8_000, now: 10_000 }))
  t('a press with no focus-in ever seen, focused, is a real click', !isRefocusPress({ focused: true, refocusedAt: -1, now: 10_000 }))
}

{
  const { cycleModeMayApprove } = await import('../../src/components/permissions/FilePermissionDialog/useFilePermissionDialog.ts')
  t('no feedback field open ⇒ the chord may approve', cycleModeMayApprove({ yesInputMode: false, noInputMode: false }))
  t('reject feedback open ⇒ inert', !cycleModeMayApprove({ yesInputMode: false, noInputMode: true }))
  t('accept feedback open ⇒ inert', !cycleModeMayApprove({ yesInputMode: true, noInputMode: false }))
}

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

{
  const { holdWorkerAsk, answerPermissionAsk, listPendingPermissionAsks, expiredAskDenialMessage, permissionAskExpiryMs, DEFAULT_PERMISSION_ASK_EXPIRY_MINUTES } =
    await import('../../src/daemon/permissionAsks.ts')
  const { concourseWorkersPath } = await import('../../src/daemon/concourseSupervisor.ts')
  type Answer = import('../../src/runner/wire/methods.ts').PermissionAnswer
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
  const held = new Map<string, { id: string; answer: Answer | null }>()
  const hold = (short: string, tag: string, tool: string, expiryMs: number, agentId?: string): string => {
    const h = holdWorkerAsk(short, { kind: 'tool', tool_use_id: `tu-${tag}`, tool_name: tool, input: { command: 'ls' }, ...(agentId !== undefined ? { agent_id: agentId } : {}) }, daemonDir, expiryMs, () => 'attached')
    const id = listPendingPermissionAsks().filter(a => a.workerId === short).at(-1)?.requestId ?? `(unparked ${tag})`
    const entry = { id, answer: null as Answer | null }
    void h.answer.then(a => {
      entry.answer = a
    })
    held.set(tag, entry)
    return id
  }
  const answerOf = (tag: string): Answer | null => held.get(tag)?.answer ?? null
  const idOf = (tag: string): string => held.get(tag)?.id ?? ''

  t("default expiry is the registered ten-minute knob — the ceiling a sub-agent's ask carries", DEFAULT_PERMISSION_ASK_EXPIRY_MINUTES === 10 && permissionAskExpiryMs() === DEFAULT_PERMISSION_ASK_EXPIRY_MINUTES * 60_000)

  hold('concourse-w1', 'main-waits', 'Bash', 40)
  t("the session's own ask parks", listPendingPermissionAsks().some(a => a.requestId === idOf('main-waits') && a.agentId === undefined))
  await sleep(140)
  t("the session's own ask is STILL parked past a 40ms limit (no clock on the main thread's ask)", listPendingPermissionAsks().some(a => a.requestId === idOf('main-waits')))
  t('no expiry denial ever reached the runner for it', answerOf('main-waits') === null)
  const lateAnswer = answerPermissionAsk(idOf('main-waits'), true, 'operator')
  await sleep(10)
  t("the operator's answer, whenever it comes, lands where the ask waits", lateAnswer.outcome === 'applied' && answerOf('main-waits')?.outcome === 'allow')

  hold('concourse-w1', 'expire', 'Bash', 40, 'agent-park-1')
  t("a sub-agent's ask parks with its agent id", listPendingPermissionAsks().some(a => a.requestId === idOf('expire') && a.agentId === 'agent-park-1'))
  await sleep(140)
  const denial = answerOf('expire')
  t("a sub-agent's expiry resolves the runner's request with a typed DENY", denial?.outcome === 'deny')
  t('the denial names the cause, the limit, and the next step',
    denial?.outcome === 'deny' && denial.message === expiredAskDenialMessage('Bash', 40, 'expired') && /expired/.test(denial.message ?? '') && /operator/.test(denial.message ?? ''),
    denial?.outcome === 'deny' ? denial.message : JSON.stringify(denial))
  t('the expired ask leaves the parked table', !listPendingPermissionAsks().some(a => a.requestId === idOf('expire')))

  const oblPath = join(crewDir, 'obligations-switchboard.json')
  type ObligationRow = { ref: string; status: string; settlement?: { by?: string } }
  const readObligation = (): ObligationRow | undefined => {
    const rows = existsSync(oblPath) ? (JSON.parse(readFileSync(oblPath, 'utf8')) as { obligations: Record<string, ObligationRow> }).obligations : {}
    return Object.values(rows).find(r => r.ref === `permission:${idOf('expire')}`)
  }
  let row = readObligation()
  for (let waited = 0; row?.status !== 'withdrawn' && waited < 10_000; waited += 50) {
    await sleep(50)
    row = readObligation()
  }
  t('the obligation row settles withdrawn with the expiry named', row?.status === 'withdrawn' && /expired unanswered/.test(row?.settlement?.by ?? ''), row === undefined ? 'no obligation row appeared' : JSON.stringify(row))
  const asksSource = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'permissionAsks.ts'), 'utf8')
  t('every mint keeps its promise on the ask (obligationLanded) and every settle site (the five: expiry, cancel, the two answers, the respawn/exit retirement) awaits it through settleAskObligation; the unattended denial is minted settled',
    (asksSource.match(/ask\.obligationLanded = upsertObligation\(/g) ?? []).length === 2 &&
      (asksSource.match(/settleAskObligation\(ask, /g) ?? []).length === 5 &&
      (asksSource.match(/void recordSettledObligation\(\{/g) ?? []).length === 1 &&
      (asksSource.match(/o\.resolveObligation\(/g) ?? []).length === 1 &&
      /const landed = ask\.obligationLanded \?\? Promise\.resolve\(ask\.obligationId\)/.test(asksSource),
    `mints=${(asksSource.match(/ask\.obligationLanded = upsertObligation\(/g) ?? []).length} settles=${(asksSource.match(/settleAskObligation\(ask, /g) ?? []).length} born-settled=${(asksSource.match(/void recordSettledObligation\(\{/g) ?? []).length}`)

  hold('concourse-w2', 'answer', 'Edit', 60, 'agent-park-2')
  const r = answerPermissionAsk(idOf('answer'), true, 'operator')
  t('an answered ask applies', r.outcome === 'applied')
  await sleep(120)
  t('an answered ask never receives a late expiry denial', answerOf('answer')?.outcome === 'allow')

  hold('concourse-w2', 'forever', 'Bash', 0)
  await sleep(60)
  t('a zero limit never expires', listPendingPermissionAsks().some(a => a.requestId === idOf('forever')))
  answerPermissionAsk(idOf('forever'), false, 'operator')

  {
    const { mintGitInitAsk } = await import('../../src/daemon/permissionAsks.ts')
    const before = listPendingPermissionAsks().length
    const fillers: string[] = []
    for (let i = before; i < 200; i++) {
      const tag = `fill-${i}`
      fillers.push(tag)
      hold('concourse-w1', tag, 'Bash', 0)
    }
    const oldestId = listPendingPermissionAsks()[0]!.requestId
    const oldestTag = [...held.entries()].find(([, v]) => v.id === oldestId)?.[0] ?? ''
    mintGitInitAsk(join(SCRATCH, 'ws-evict'))
    await sleep(10)
    const evictedDenial = answerOf(oldestTag)
    t("the eviction resolves the oldest runner request with a typed DENY", evictedDenial?.outcome === 'deny', `${oldestId} (${oldestTag})`)
    t('the eviction denial names the full table', evictedDenial?.outcome === 'deny' && /table was full/.test(evictedDenial.message ?? ''), evictedDenial?.outcome === 'deny' ? evictedDenial.message : JSON.stringify(evictedDenial))
    t('the evicted ask left the parked table', !listPendingPermissionAsks().some(a => a.requestId === oldestId))
    for (const tag of fillers) answerPermissionAsk(idOf(tag), false, 'operator')
  }
}

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

  const denied = await drive({ behavior: 'deny', tool_use_id: 'toolu_lateanswer', message: 'not on this machine' })
  t('a late DENY runs NOTHING', denied.runs === 0)
  t('the deny settles as a rendered refusal carrying the reason', /Permission denied: not on this machine/.test(denied.settled ?? '') && /did not run/.test(denied.settled ?? ''), denied.settled ?? '(none)')
  const unanswered = await drive({ tool_use_id: 'toolu_lateanswer' })
  t('a verdict-less answer runs NOTHING and says so', unanswered.runs === 0 && /never granted/.test(unanswered.settled ?? ''))
  const junk = await drive({ behavior: 'ask', tool_use_id: 'toolu_lateanswer' })
  t('an ask-with-no-answer runs NOTHING', junk.runs === 0 && /never granted/.test(junk.settled ?? ''))

  killCapability(undefined, 'SpyTool')
  const killedRun = await drive({ behavior: 'allow', tool_use_id: 'toolu_lateanswer', updated_input: { command: 'echo hi' } })
  t('an ALLOW for a tool killed since the ask is refused at replay time', killedRun.runs === 0 && /kill switch/.test(killedRun.settled ?? ''), killedRun.settled ?? '(none)')
  restoreCapability(undefined, 'SpyTool')

  const allowed = await drive({ behavior: 'allow', tool_use_id: 'toolu_lateanswer', updated_input: { command: 'echo hi' } })
  t('the allow arm still runs exactly once (the control)', allowed.runs === 1)

}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures ? '\nFAILURES' : '\nALL GREEN')
process.exit(failures)
