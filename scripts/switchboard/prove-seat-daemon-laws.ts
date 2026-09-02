#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-connector/prove-seat-daemon-laws.ts — the SECOND
//  implementation's laws (the daemon-hosted session behind the connector),
//  driven on a REAL scratch daemon hosting a real session (the built dist,
//  the fixture API as its provider) with the connector running in THIS
//  process — the in-process laws mirrored, plus the hop:
//
//   D1  the record stream IS the session's own file: records() carries its
//       rows and subscribeRecords hears the file grow;
//   D2  the ask round-trips with the FULL payload: a parked ask arrives as a
//       real ToolUseConfirm (the tool by name, the input, an 'ask' result);
//       answerAsk('allow') settles the entry FIRST, the daemon routes the
//       answer, the obligation settles, the tool runs, the reply lands;
//   D3  interrupt reaches the session: a streaming turn stops, the
//       interruption marker lands, the live view falls idle and the
//       interrupting latch clears;
//   D4  the model doors: setModel idle applies NOW (the record's modelKey,
//       the facts, and the WIRE — the fixture serves the next turn only to a
//       sonnet-model request); a mid-turn pick parks (the record's
//       pendingModelKey, facts.pendingModel) and applies at the turn's end;
//   D5  the readout doors answer from the SESSION'S process: its cost, its
//       identity, its skills, its MCP roster, its workspace, its mode;
//   D6  the queue doors edit the session's OWN queue: words queued while it
//       is busy show in queue() and a removeQueued withdraws them before
//       they run;
//   D7  setPermissionMode reaches the session (the facts follow);
//   D8  the record chain is whole: after several delivered turns records()
//       still carries the FIRST turn's rows (the per-turn engine continues
//       the chain);
//   D9  the hop: focusDaemonSession re-points the slot, a composed door feed
//       re-attaches, closing the chat (the slot rests) detaches the connector's feeds.
//  Fixture-hermetic: scratch home + daemon dir + workspace; the daemon and
//  its child are terminated (children first) at the end.
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'daemon-laws-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
      /* not yet */
    }
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash(rm:*)'] } }))

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([
  { kind: 'tool_use', whenModel: 'opus', name: 'Bash', input: { command: `rm -f ${join(SCRATCH, 'nothing-here')}`, description: 'tidy' }, preText: 'about to tidy up. ' },
  { kind: 'text', whenModel: 'opus', text: 'Tidied after your allow.' },
  // D3: a long paced reply to interrupt.
  { kind: 'paced', whenModel: 'opus', deltas: Array.from({ length: 40 }, (_, i) => `long-${String(i + 1).padStart(2, '0')} body. `), gapMs: 400, settleDelayMs: 1500 },
  // D4: served ONLY to a sonnet-model request.
  { kind: 'text', whenModel: 'sonnet', text: 'sonnet-law body.' },
  // D4 (parked): a paced sonnet turn during which an opus pick parks, then an opus reply.
  { kind: 'paced', whenModel: 'sonnet', deltas: Array.from({ length: 12 }, (_, i) => `parked-${String(i + 1).padStart(2, '0')} body. `), gapMs: 400, settleDelayMs: 1000 },
  // D10: the FIRST opus request after the parked switch applies is the steer
  // turn — a tool boundary to steer into (↵ while busy folds the words in at
  // the next step), then the step after the fold (served to the request
  // that carries the tool result AND the folded words).
  { kind: 'paced_tool_use', whenModel: 'opus', preDeltas: ['steer-stage body. '], gapMs: 300, tools: [{ name: 'Bash', input: { command: 'sleep 6; echo steer', description: 'pause' } }] },
  { kind: 'text', whenModel: 'opus', text: 'steer-done body.' },
  { kind: 'text', whenModel: 'opus', text: 'opus-again body.' },
  { kind: 'text', text: 'Spare.' },
  { kind: 'text', text: 'Spare.' },
])

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const daemon = spawn('node', [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: api.url,
    MERCURY_CACHE_CLOCK: '0',
    MERCURY_PARTY: '0',
  },
  stdio: ['ignore', logFd, logFd],
})

try {
  const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
  check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
  const d = (await daemonControlRpc({
    op: 'concourseDispatch',
    clientMessageId: 'daemon-laws',
    prompt: 'tidy the scratch folder',
    workspaceDir: work,
    title: 'Law probe',
    modelKey: 'claude-opus-5',
    effort: 'xhigh',
  } as never)) as { ok?: boolean; sessionId?: string; runnerId?: string }
  check('the session dispatched', d.ok === true && d.sessionId !== undefined, JSON.stringify(d))
  const sid = d.sessionId ?? ''
  const paths = await import('../../src/utils/sessionStorage/paths.ts')
  const logPath = join(paths.getProjectDir(work), `${sid}.jsonl`)
  const logText = (): string => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '')
  const obligations = await import('../../src/services/crew/obligations.ts')
  check(
    'the session raised a REAL permission ask',
    await untilAsync(async () => (await obligations.openObligations({ scope: 'switchboard' })).some(o => o.sessionId === sid && (o.ref ?? '').startsWith('permission:')), 40_000),
  )

  const seat = await import('../../src/services/engine-connector/daemonConnector.ts')
  const slot = await import('../../src/services/engine-connector/focusedConnector.ts')
  const sup = await import('../../src/daemon/concourseSupervisor.ts')
  const recordOf = (): { modelKey?: string; pendingModelKey?: string } | undefined =>
    Object.values(sup.readSessionWorkers(daemonDir)).find(r => r.sessionId === sid)
  const record = {
    sessionId: sid,
    runnerId: d.runnerId ?? 'concourse-w1',
    title: 'Law probe',
    projectLabel: basename(work),
    workspaceId: work,
    home: paths.getProjectDir(work),
    modelKey: 'claude-opus-5',
  }

  // ── D9a: the hop re-points the slot ──
  const connector = await seat.focusDaemonSession(record)
  check('D9 focusDaemonSession re-points the focused slot', slot.getFocusedSessionConnector() === connector && connector.carrier === 'daemon')
  check('D9 one connector per session', seat.daemonSessionConnectorFor(record) === connector)

  // ── D1: records ──
  check('D1 records() carries the session\'s own rows', await untilAsync(() => connector.records().some(m => JSON.stringify(m).includes('tidy the scratch folder')), 10_000))
  // (queue() left this list with the connector's queue doors — the
  // steer-removal ruling.)
  check('D1 the reader doors answer stable snapshots between changes (the uSES law)', connector.records() === connector.records() && connector.asks() === connector.asks())
  let recordPings = 0
  const offRecords = connector.subscribeRecords(() => recordPings++)

  // ── D2: the ask, full payload ──
  check('D2 the parked ask arrives on the connector', await untilAsync(() => connector.asks().length === 1, 10_000))
  const ask = connector.asks()[0]
  const confirm = ask?.confirm
  check('D2 the FULL payload: the tool by name, the input, an ask result', confirm !== undefined && confirm.tool.name === 'Bash' && String((confirm.input as { command?: string }).command).includes('rm -f') && confirm.permissionResult.behavior === 'ask')
  check('D2 the assistant record names the asking tool use', confirm !== undefined && JSON.stringify(confirm.assistantMessage).includes(confirm.toolUseID))
  // The reason crosses STRUCTURED (decisionReasonWire): the card explains
  // "The rule Bash(rm:*) requires confirmation for this command" exactly as
  // the boot session's card does — a plain-text stand-in would explain
  // nothing (the child's string form drops rule reasons).
  const reason = confirm !== undefined && 'decisionReason' in confirm.permissionResult ? confirm.permissionResult.decisionReason : undefined
  check(
    'D2 the reason crosses structured: the matched ask rule Bash(rm:*)',
    reason?.type === 'rule' && reason.rule.ruleValue.toolName === 'Bash' && reason.rule.ruleValue.ruleContent === 'rm:*',
    JSON.stringify(reason),
  )
  let asksAtVerb = -1
  const receipt = await (async () => {
    const p = connector.answerAsk(ask!.id, { kind: 'allow', permissionUpdates: [] })
    asksAtVerb = connector.asks().length
    return p
  })()
  check('D2 answerAsk(allow) settles the entry FIRST', asksAtVerb === 0)
  check('D2 …and the daemon took the answer', receipt.ok === true, JSON.stringify(receipt))
  check('D2 the obligation settled', await untilAsync(async () => !(await obligations.openObligations({ scope: 'switchboard' })).some(o => o.sessionId === sid), 10_000))
  check('D2 the tool ran and the reply landed in the session\'s file', await untilAsync(() => logText().includes('Tidied after your allow.'), 20_000))
  check('D1 subscribeRecords heard the file grow', await untilAsync(() => recordPings > 0, 5_000), `pings=${recordPings}`)
  offRecords()
  check('D2 the ask stream is empty after settlement', connector.asks().length === 0)
  check('D2 an unknown id refuses honestly', (await connector.answerAsk('no-such-ask', { kind: 'abort' })).ok === false)

  // ── D5 (part): the facts answered by the session's process ──
  check('D5 usage() moves with the session\'s own ledger', await untilAsync(() => connector.usage().totalCostUSD > 0, 15_000), `cost=${connector.usage().totalCostUSD}`)
  const id = connector.identity()
  check('D5 identity() answers booleans + a null email on a scratch home', typeof id.firstPartyApi === 'boolean' && id.accountEmail === null)
  check('D5 skillsRoster() lists the session\'s own skills', connector.skillsRoster().skills.length > 0, `${connector.skillsRoster().skills.length} skills`)
  check('D5 mcpRoster() answers rows (name + state)', Array.isArray(connector.mcpRoster().clients) && connector.mcpRoster().clients.every(c => typeof c.name === 'string' && typeof c.type === 'string'))
  check('D5 workspace() names the session\'s workspace', connector.workspace().projectRoot === work && connector.workspace().cwd.startsWith(work))
  check('D5 permissionMode() reads the session\'s mode', connector.permissionMode() === 'flow', connector.permissionMode())
  check('D5 modelFacts() reads the session\'s model', connector.modelFacts().effective === 'claude-opus-5' && connector.modelFacts().pendingSwitch === null)

  // ── D3: interrupt a streaming turn ──
  const sent = await connector.sendWords('say something long please')
  check('D3 sendWords is accepted by an idle session', sent.state === 'accepted', JSON.stringify(sent))
  check('D3 the session\'s turn is in flight', await untilAsync(() => connector.turnActive(), 15_000))
  // ── D6 RETIRED (the steer-removal ruling): the operator-
  // facing queue journey — queue words while busy, inspect them, withdraw
  // them — died with the pen. A sent message is delivered instantly and
  // read at the next legal boundary, exactly once (D10 proves the fold).
  // POISON: the connector must carry NO queue doors — any one returning
  // here is the pen reviving and reds this section by name.
  {
    const doors = connector as unknown as Record<string, unknown>
    check('D6 the pen stays dead: no queue() door on the connector', typeof doors.queue === 'undefined')
    check('D6 the pen stays dead: no enqueue() door on the connector', typeof doors.enqueue === 'undefined')
    check('D6 the pen stays dead: no removeQueued() door on the connector', typeof doors.removeQueued === 'undefined')
  }
  check('D3 interrupt() reports the running turn', connector.interrupt() === true)
  check('D3 the interruption marker landed in the session\'s file', await untilAsync(() => logText().includes('[Request interrupted by user]'), 20_000))
  check('D3 the live view falls idle and the latch clears', await untilAsync(() => !connector.turnActive() && !connector.status().interrupting, 15_000), JSON.stringify({ active: connector.turnActive(), status: connector.status() }))

  // ── D4: the model switch — idle applies NOW, and it reaches the wire ──
  const applied = await connector.setModel('claude-sonnet-5')
  check('D4 setModel on an idle session answers applied (the daemon\'s word)', applied.state === 'applied', JSON.stringify(applied))
  check('D4 the readout flips at once', connector.modelFacts().effective === 'claude-sonnet-5')
  check('D4 the record\'s modelKey follows', await untilAsync(() => recordOf()?.modelKey === 'claude-sonnet-5', 10_000), JSON.stringify(recordOf()))
  const sonnet = await connector.sendWords('a sonnet turn please')
  check('D4 the next words are accepted', sonnet.state === 'accepted')
  check('D4 the WIRE ran the session on sonnet (the fixture serves that turn only to a sonnet request)', await untilAsync(() => logText().includes('sonnet-law body.'), 20_000))
  check('D4 the session\'s facts name sonnet', await untilAsync(() => connector.modelFacts().effective === 'claude-sonnet-5' && connector.modelFacts().pendingSwitch === null, 10_000))
  check('D4 the same model no-ops', (await connector.setModel('claude-sonnet-5')).state === 'no-op')
  // mid-turn: park, then apply at the turn's end
  const parkedTurn = await connector.sendWords('stream a parked turn')
  check('D4 a busy turn opens', parkedTurn.state === 'accepted' && (await untilAsync(() => connector.turnActive(), 15_000)))
  const queuedSwitch = await connector.setModel('claude-opus-5')
  check('D4 a mid-turn pick parks as queued (the daemon\'s word)', queuedSwitch.state === 'queued', JSON.stringify(queuedSwitch))
  check('D4 the pending switch shows in the facts', await untilAsync(() => connector.modelFacts().pendingSwitch?.setting === 'claude-opus-5', 10_000))
  check('D4 the record parks it', await untilAsync(() => recordOf()?.pendingModelKey === 'claude-opus-5', 10_000))
  check('D4 the turn\'s end applies it', await untilAsync(() => recordOf()?.modelKey === 'claude-opus-5' && recordOf()?.pendingModelKey === undefined, 30_000), JSON.stringify(recordOf()))
  check('D4 the facts follow the applied switch', await untilAsync(() => connector.modelFacts().effective === 'claude-opus-5' && connector.modelFacts().pendingSwitch === null, 15_000))
  // FN-016 R15, end to end on the REAL road: the idle-edge apply stamps
  // the daemon's own settlement receipt, and the connector's edge mints
  // the one grey settle note in THIS chat from that stamp (the retired
  // same-snapshot guard never fired here — the clear publish carries the
  // child's lagging answer).
  check(
    'D4 the parked settle paints its transcript note (the daemon receipt drives it)',
    await untilAsync(
      () =>
        connector
          .records()
          .some(
            m =>
              (m as { subtype?: string }).subtype === 'model_transition' &&
              (m as { applied?: string | null }).applied === 'claude-opus-5' &&
              (m as { boundary?: string }).boundary === 'turn-boundary',
          ),
      15_000,
    ),
  )

  // ── D10: ↵ while busy DELIVERS — the words fold into the running turn at
  // its next tool boundary and reach the model; on screen they paint as an
  // echo row instantly (the steer-removal ruling: no waiting state exists) ──
  const steerTurn = await connector.sendWords('stream a steer turn')
  const turnOpened = await untilAsync(() => connector.turnActive(), 25_000)
  check('D10 a turn with a tool boundary opens', steerTurn.state !== 'refused' && turnOpened, `${JSON.stringify(steerTurn)} turnActive=${connector.turnActive()} live=${JSON.stringify({ ...connector.live(), inProgressToolUseIDs: [...connector.live().inProgressToolUseIDs] })}`)
  const toolRunning = await untilAsync(() => connector.live().inProgressToolUseIDs.size > 0, 25_000)
  check('D10 …and its tool is running', toolRunning, `live=${JSON.stringify({ ...connector.live(), inProgressToolUseIDs: [...connector.live().inProgressToolUseIDs] })} records=${connector.records().length} stage=${JSON.stringify(connector.records()).includes('steer-stage body')}`)
  const requestsBeforeSteer = api.messageRequests().length
  const steered = await connector.sendWords('steer these words in')
  check('D10 the busy session accepts the ↵ words (queued, not refused)', steered.state !== 'refused', JSON.stringify(steered))
  const foldRequest = (): unknown =>
    api.messageRequests().slice(requestsBeforeSteer).find(r => JSON.stringify(r.body ?? {}).includes('steer these words in'))?.body
  check(
    'D10 the words reach the MODEL at the tool boundary — the request that carries them carries the tool result too (a fold, not a fresh turn)',
    (await untilAsync(() => foldRequest() !== undefined, 25_000)) && JSON.stringify(foldRequest()).includes('tool_result'),
    `requests after the steer: ${api.messageRequests().length - requestsBeforeSteer}; fold request carries a tool_result: ${JSON.stringify(foldRequest() ?? null).includes('tool_result')}`,
  )
  check('D10 the step after the fold lands in the session\'s file', await untilAsync(() => logText().includes('steer-done body.'), 25_000))
  check('D10 the turn settles', await untilAsync(() => !connector.turnActive(), 15_000))
  check(
    'D10 no separate turn ran the words (the file has no input row of them — they rode the fold)',
    logText().split('\n').filter(l => l.includes('"kind":"input"') && l.includes('steer these words in')).length === 0,
  )
  check('D10 the steered words paint as a row of the chat (the echo)', JSON.stringify(connector.records()).includes('steer these words in'))
  // The waiting-words count died with SeatStatusV1.waitingWords (the
  // steer-removal ruling): "never waiting for its turn" is now structural —
  // no waiting state EXISTS to count. Absence is the pin.
  check('D10 a steered send is never "waiting for its turn" (the count itself is gone)', !('waitingWords' in connector.status()))

  // ── D7: the permission mode ──
  connector.setPermissionMode('acceptEdits' as never)
  check('D7 setPermissionMode flips the readout at once', connector.permissionMode() === 'acceptEdits')
  check('D7 the session confirms the mode in its facts', await untilAsync(() => {
    const raw = readFileSync(join(daemonDir, 'session-facts', `${sid}.json`), 'utf8')
    return (JSON.parse(raw) as { permissionMode?: string }).permissionMode === 'acceptEdits'
  }, 10_000))

  // ── D8: the chain is whole after several delivered turns (the lead's
  // pin on the writer fix: a 3-turn daemon session's loadFullLog — the
  // connector's own reader — returns all three) ──
  check('D8 loadFullLog returns EVERY delivered turn (the record chain is whole)', await untilAsync(() => {
    const s = JSON.stringify(connector.records())
    return s.includes('tidy the scratch folder') && s.includes('Tidied after your allow.') && s.includes('sonnet-law body.')
  }, 10_000), `rows=${connector.records().length}`)

  // ── D9b: the composed feed re-attaches; closing the chat detaches ──
  // (the one-door law: the slot rests on no session — never a blank chat)
  let feed = 0
  const subscribeAsksThroughSlot = slot.subscribeThroughFocused((c, l) => c.subscribeAsks(l))
  const offFeed = subscribeAsksThroughSlot(() => feed++)
  slot.releaseFocusedSessionConnector()
  check('D9 closing the chat leaves the seat, rests the slot and notifies the composed feed', slot.getFocusedSessionConnector() !== connector && !slot.hasFocusedSession() && feed === 1)
  check('D9 the connector that lost the slot stopped its feeds', await untilAsync(() => !connector.isAttached(), 2_000))
  offFeed()

  // ── W: the warm runner on the LIVE daemon (the line-7 restoration) ──
  // A fresh workspace warms one runner over the RPC door; the status names
  // it; the board and the records DON'T (looking still creates nothing —
  // no row, no transcript); a dispatch there CLAIMS the pre-booted process
  // (the admitted worker is the very short+pid the pool pre-spawned, per
  // the daemon's own log); the pool re-warms behind the claim.
  {
    const work2 = join(SCRATCH, 'work2')
    mkdirSync(work2, { recursive: true })
    const daemonLog = (): string => {
      try {
        return readFileSync(join(SCRATCH, 'daemon.log'), 'utf8')
      } catch {
        return ''
      }
    }
    const listRows = async (): Promise<number> => {
      const l = (await daemonControlRpc({ op: 'concourseList' } as never)) as { workers?: unknown[] }
      return (l.workers ?? []).length
    }
    const rowsBefore = await listRows()
    const warmed = (await daemonControlRpc({ op: 'concourseWarm', workspaceDir: work2 } as never)) as {
      ok?: boolean
      state?: string
      detail?: string
    }
    check('W the warm door answers warmed', warmed.ok === true && warmed.state === 'warmed', JSON.stringify(warmed))
    const statusNames = async (): Promise<number | undefined> => {
      const s = (await daemonControlRpc({ op: 'status', proto: 1 } as never)) as { status?: { warmRunners?: number } }
      return s.status?.warmRunners
    }
    check('W the status op names the warm runner', await untilAsync(async () => ((await statusNames()) ?? 0) >= 1, 10_000))
    check('W the board lists NO row for it (no record)', (await listRows()) === rowsBefore)
    const warmSpawnLine = (): string | undefined => daemonLog().split('\n').find(l => l.includes('warm runner pre-spawned') && l.includes(work2))
    check('W the pool named its pre-spawn in the log', await untilAsync(() => warmSpawnLine() !== undefined, 10_000))
    const warmShort = /pre-spawned: (concourse-w\d+) \(pid (\d+)\)/.exec(warmSpawnLine() ?? '')
    check('W the pre-spawn names its short and pid', warmShort !== null, warmSpawnLine() ?? 'no line')
    // The warm runner must be READY (its stdin loop up) before the claim is
    // representative — the same condition the operator's typing gap covers.
    check('W the warm runner reaches ready', await untilAsync(async () => {
      const h = (await daemonControlRpc({ op: 'has', proto: 1, short: warmShort?.[1] ?? '' } as never)) as { ready?: boolean }
      return h.ready === true
    }, 30_000))
    const w2 = (await daemonControlRpc({
      op: 'concourseDispatch',
      clientMessageId: 'warm-claim-live',
      prompt: 'first words into the warm runner',
      workspaceDir: work2,
      title: 'Warm probe',
    } as never)) as { ok?: boolean; sessionId?: string; runnerId?: string }
    check('W the dispatch admits', w2.ok === true && typeof w2.sessionId === 'string', JSON.stringify(w2))
    check('W claim-over-spawn: the admitted worker IS the pre-spawned warm runner (same short + pid, live)', await untilAsync(async () => {
      const l = (await daemonControlRpc({ op: 'concourseList' } as never)) as { workers?: Array<{ runnerId?: string; pid?: number; sessionId?: string }> }
      const row = (l.workers ?? []).find(r => r.sessionId === w2.sessionId)
      return row !== undefined && row.runnerId === warmShort?.[1] && String(row.pid) === warmShort?.[2]
    }, 15_000))
    // The transcript is found BY SESSION ID over the projects root — the
    // bun-vs-node overlong-slug divergence (see findProjectDir's tolerant
    // scan) makes a strict path computation miss the node runner's dir.
    const transcript2 = (): string | null => {
      const root = join(home, 'projects')
      if (!existsSync(root)) return null
      for (const entry of readdirSync(root)) {
        const candidate = join(root, entry, `${w2.sessionId}.jsonl`)
        if (existsSync(candidate)) return candidate
      }
      return null
    }
    check('W the claimed session answers into its own transcript', await untilAsync(() => {
      const p = transcript2()
      return p !== null && readFileSync(p, 'utf8').includes('first words into the warm runner')
    }, 30_000))
    check('W the pool re-warms behind the claim (a second pre-spawn in the log)', await untilAsync(() => daemonLog().split('\n').filter(l => l.includes('warm runner pre-spawned') && l.includes(work2)).length >= 2, 15_000))
  }
} finally {
  try {
    await (await import('../../src/daemon/controlSocket.ts')).daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
    /* already down */
  }
  daemon.kill('SIGTERM')
  await api.close()
  if (process.env.SWITCH_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
  else rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-seat-daemon-laws: ALL LAWS HOLD' : `\nprove-seat-daemon-laws: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
