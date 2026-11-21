#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, type CapturedRequest } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { nodeBinPath } from '../lib/nodeBin.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const REPO = resolve(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_PROOF_DIST ?? (process.argv[2] ? resolve(process.argv[2]) : join(REPO, 'dist', 'mercury.mjs'))
if (!existsSync(DIST)) {
  console.error(`${DIST} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'contract-tool-hosted-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })

process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = FIXTURE_API_KEY
for (const k of [
  'MERCURY_HOME',
  'CI',
  'NODE_ENV',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_CONCOURSE_WORKER',
  'MERCURY_WARM_RUNNER',
  'MERCURY_MODEL',
]) {
  delete process.env[k]
}

seedFirstRun(home, [work])

const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')

const CONTRACT_TEXT = 'Deliver the parser unit cleanly; leave unrelated modules untouched.'
const RESTATEMENT = 'I will build only the parser unit and keep every unrelated module unchanged.'
const CHECKIN_ABOUT = 'running the parser unit check before closing'
const CLOSING_REPORT = 'Delivered the parser unit cleanly; unrelated modules untouched; all checks green.'
const MODEL = 'claude-opus-4-8'

const api = await startFixtureApi([
  { kind: 'tool_use', name: 'Contract', id: 'toolu_contract_read', input: { action: 'read' }, whenModel: 'opus' },
  { kind: 'tool_use', name: 'Contract', id: 'toolu_contract_ack', input: { action: 'acknowledge', restatement: RESTATEMENT }, whenModel: 'opus' },
  { kind: 'text', text: 'Contract read and acknowledged.', whenModel: 'opus' },
  { kind: 'tool_use', name: 'Contract', id: 'toolu_contract_checkin', input: { action: 'check-in', about: CHECKIN_ABOUT }, whenModel: 'opus' },
  { kind: 'tool_use', name: 'Contract', id: 'toolu_contract_close', input: { action: 'close-against', report: CLOSING_REPORT }, whenModel: 'opus' },
  { kind: 'text', text: 'Closing receipt filed and contract closed.', whenModel: 'opus' },
])
process.env.ANTHROPIC_BASE_URL = api.url

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — prove-contract-tool-hosted exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function untilAsync(cond: () => Promise<boolean> | boolean, ms = 60_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      if (await cond()) return true
    } catch {}
    if (Date.now() > deadline) return false
    await wait(100)
  }
}

type ContractRec = {
  text: string
  status: string
  ackAt?: number
  amendments: Array<{ text: string; at: number; by: string }>
}
type WorkerRec = {
  runnerId: string
  sessionId: string
  endedAt?: number
  lastDeliveryAt?: number
  lastTurnSettledAt?: number
  contract?: ContractRec
}

const readWorker = (sid: string): WorkerRec | undefined => {
  try {
    const raw = JSON.parse(readFileSync(join(daemonDir, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, WorkerRec> }
    return Object.values(raw.workers).find(w => w.sessionId === sid && w.endedAt === undefined)
  } catch {
    return undefined
  }
}

const readFacts = (sid: string): { busy?: boolean } | undefined => {
  try {
    return JSON.parse(readFileSync(join(daemonDir, 'session-facts', `${sid}.json`), 'utf8')) as { busy?: boolean }
  } catch {
    return undefined
  }
}

const turnSettled = (sid: string, minDeliveryAt: number): boolean => {
  const rec = readWorker(sid)
  const facts = readFacts(sid)
  return (
    rec !== undefined &&
    (rec.lastDeliveryAt ?? 0) >= minDeliveryAt &&
    (rec.lastTurnSettledAt ?? 0) >= (rec.lastDeliveryAt ?? 1) &&
    facts?.busy === false
  )
}

function findToolResult(reqs: CapturedRequest[], toolUseId: string): Record<string, unknown> | null {
  for (const req of reqs) {
    const body = req.body as { messages?: Array<{ content?: unknown }> } | null
    for (const msg of body?.messages ?? []) {
      if (!Array.isArray(msg.content)) continue
      for (const block of msg.content) {
        if (block && typeof block === 'object' && block.type === 'tool_result' && block.tool_use_id === toolUseId) {
          const text = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c: { text?: string }) => c.text ?? '').join('')
              : ''
          try {
            return JSON.parse(text) as Record<string, unknown>
          } catch {
            return { raw: text }
          }
        }
      }
    }
  }
  return null
}

const logPath = join(SCRATCH, 'daemon.log')
let daemon: ChildProcess | null = null
let daemonExit: Promise<void> = Promise.resolve()

function bootDaemon(): void {
  const logFd = openSync(logPath, 'a')
  daemon = spawn(nodeBinPath(), [DIST, 'daemon', 'run', work], {
    cwd: work,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: home,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_WARM_RUNNER: '0',
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
      MERCURY_TERMINAL_TITLE: '0',
      MERCURY_TURN_RECEIPT: '0',
      MERCURY_VERIFY_EVIDENCE: '0',
      ANTHROPIC_API_KEY: FIXTURE_API_KEY,
      ANTHROPIC_BASE_URL: api.url,
    },
    stdio: ['ignore', logFd, logFd],
  })
  const child = daemon
  daemonExit = new Promise<void>(r => child.once('exit', () => r()))
}

async function stopDaemon(): Promise<void> {
  if (daemon === null) return
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 5_000 }).catch(() => undefined)
  const gone = await Promise.race([daemonExit.then(() => true), wait(10_000).then(() => false)])
  if (!gone) {
    try {
      daemon.kill('SIGKILL')
    } catch {}
  }
  daemon = null
}

try {
  bootDaemon()
  const pingOk = await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 30_000)
  check('daemon boots and answers ping', pingOk)

  const admit = (await daemonControlRpc(
    {
      op: 'sessionAdmit',
      workspaceDir: work,
      isolation: 'shared',
      by: 'operator',
      bornBlank: true,
      model: MODEL,
    } as never,
    { timeoutMs: 30_000 },
  )) as { ok: boolean; sessionId?: string; runnerId?: string; error?: string }
  check('hosted concourse worker session is admitted', admit.ok === true && typeof admit.sessionId === 'string', JSON.stringify(admit))

  if (admit.ok && admit.sessionId) {
    const sid = admit.sessionId
    const draftReply = (await daemonControlRpc(
      {
        op: 'sessionControl',
        action: 'contract',
        sessionId: sid,
        by: 'operator',
        contract: { op: 'set', text: CONTRACT_TEXT },
      } as never,
      { timeoutMs: 10_000 },
    )) as { ok?: boolean; outcome?: string; detail?: string }
    const afterDraft = readWorker(sid)?.contract
    check(
      'operator drafts a contract on the hosted session record',
      draftReply.ok === true && draftReply.outcome === 'applied' && afterDraft?.status === 'draft' && afterDraft.text === CONTRACT_TEXT,
      JSON.stringify({ draftReply, afterDraft }),
    )

    const turn1Before = Date.now()
    const send1 = (await daemonControlRpc(
      {
        op: 'sessionDispatch',
        clientMessageId: `contract-turn-1-${sid}`,
        prompt: 'Read and acknowledge the session contract.',
        workspaceDir: work,
        targetSessionId: sid,
      } as never,
      { timeoutMs: 30_000 },
    )) as { ok?: boolean; error?: string }
    check('turn 1 dispatches to the hosted worker', send1.ok === true, JSON.stringify(send1))

    const settled1 = await untilAsync(() => turnSettled(sid, turn1Before), 45_000)
    check('turn 1 settles after Contract read and acknowledge', settled1, JSON.stringify({ rec: readWorker(sid), facts: readFacts(sid) }))

    const opusReqs1 = api.messageRequests().filter(r => {
      const m = (r.body as { model?: string } | null)?.model ?? ''
      return m.includes('opus') && !r.path.includes('count_tokens')
    })
    const offeredTools = ((opusReqs1[0]?.body as { tools?: Array<{ name?: string }> } | null)?.tools ?? []).map(t => t.name)
    check('hosted worker offers the Contract tool to the model', offeredTools.includes('Contract'), `tools=${offeredTools.length}`)

    const readResult = findToolResult(opusReqs1, 'toolu_contract_read')
    check(
      'Contract read returns draft status, contract text, and acknowledgment instruction',
      readResult?.status === 'draft' &&
        readResult?.text === CONTRACT_TEXT &&
        readResult?.amendments === 0 &&
        String(readResult?.message ?? '').includes('acknowledge'),
      JSON.stringify(readResult),
    )

    const ackResult = findToolResult(opusReqs1, 'toolu_contract_ack')
    check(
      'Contract acknowledge returns acknowledged status in force',
      ackResult?.status === 'acknowledged' &&
        ackResult?.text === CONTRACT_TEXT &&
        String(ackResult?.message ?? '').includes('in force'),
      JSON.stringify(ackResult),
    )

    const afterAck = readWorker(sid)?.contract
    check(
      'worker record moves from draft to acknowledged with ackAt stamped',
      afterAck?.status === 'acknowledged' && typeof afterAck.ackAt === 'number' && afterAck.text === CONTRACT_TEXT,
      JSON.stringify(afterAck),
    )

    const turn2Before = (readWorker(sid)?.lastDeliveryAt ?? 0) + 1
    const send2 = (await daemonControlRpc(
      {
        op: 'sessionDispatch',
        clientMessageId: `contract-turn-2-${sid}`,
        prompt: 'Check in and close against the session contract.',
        workspaceDir: work,
        targetSessionId: sid,
      } as never,
      { timeoutMs: 30_000 },
    )) as { ok?: boolean; error?: string }
    check('turn 2 dispatches and promotes the acknowledged contract to active', send2.ok === true, JSON.stringify(send2))

    const settled2 = await untilAsync(() => turnSettled(sid, turn2Before), 45_000)
    check('turn 2 settles after Contract check-in and close-against', settled2, JSON.stringify({ rec: readWorker(sid), facts: readFacts(sid) }))

    const opusReqsAll = api.messageRequests().filter(r => {
      const m = (r.body as { model?: string } | null)?.model ?? ''
      return m.includes('opus') && !r.path.includes('count_tokens')
    })

    const checkinResult = findToolResult(opusReqsAll, 'toolu_contract_checkin')
    check(
      'Contract check-in observes active status after delivery promotion and echoes the planned move',
      checkinResult?.status === 'active' &&
        checkinResult?.text === CONTRACT_TEXT &&
        String(checkinResult?.message ?? '').includes(CHECKIN_ABOUT),
      JSON.stringify(checkinResult),
    )

    const closeResult = findToolResult(opusReqsAll, 'toolu_contract_close')
    check(
      'Contract close-against reports receipt filed beside the transcript and contract closed',
      String(closeResult?.message ?? '').includes('receipt beside the transcript') &&
        String(closeResult?.message ?? '').includes('contract is closed'),
      JSON.stringify(closeResult),
    )

    const afterClose = readWorker(sid)?.contract
    check(
      'worker record moves to closed with contract text and ackAt preserved',
      afterClose?.status === 'closed' &&
        afterClose.text === CONTRACT_TEXT &&
        typeof afterClose.ackAt === 'number' &&
        afterClose.amendments.length === 0,
      JSON.stringify(afterClose),
    )

    const projectDir = getProjectDir(work)
    const transcriptFile = join(projectDir, `${sid}.jsonl`)
    const receiptsFile = join(projectDir, `${sid}.receipts.jsonl`)
    const transcriptExists = existsSync(transcriptFile)
    const receiptsExists = existsSync(receiptsFile)
    const receiptEntries = receiptsExists
      ? readFileSync(receiptsFile, 'utf8')
          .split('\n')
          .filter(line => line.trim().length > 0)
          .map(line => JSON.parse(line) as { kind?: string; by?: string; summary?: string; details?: Record<string, unknown> })
      : []
    const closeReceipt = receiptEntries.find(e => e.kind === 'contract-close')
    check(
      'closing receipt sits beside the transcript with contract-close entry, worker actor, report summary, and prior status',
      transcriptExists &&
        receiptsExists &&
        closeReceipt !== undefined &&
        closeReceipt.by === `worker:${sid.slice(0, 8)}` &&
        closeReceipt.summary === CLOSING_REPORT &&
        closeReceipt.details?.status === 'active' &&
        closeReceipt.details?.amendments === 0 &&
        typeof closeReceipt.details?.ackAt === 'number',
      JSON.stringify({ transcriptExists, receiptsExists, transcriptFile, receiptsFile, closeReceipt }),
    )
  }
} finally {
  clearTimeout(guard)
  await stopDaemon()
  await api.close()
  removeScratch(SCRATCH)
}

console.log(failures === 0 ? '\nprove-contract-tool-hosted: ALL CHECKS PASS' : `\nprove-contract-tool-hosted: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
