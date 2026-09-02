#!/usr/bin/env bun
// ============================================================================
//  scripts/rewind/prove-rewind-cockpit.ts — THE COCKPIT END OF /rewind
//  (release-hardening audit FN-015 rank 8: the advertising surfaces tell the
//  truth and the screen's restore road reaches the runner), cpu-pure.
//
//   §1 THE CONNECTOR DOORS: checkpointFacts / subscribeCheckpoints / rewind
//      are contract doors; the resting slot answers 'off' and refuses typed
//      ('no-chat'); the daemon-hosted connector folds the runner's facts
//      (absent ⇒ 'unknown', never 'on'; present ⇒ on/off + the restorable
//      set, content-keyed and stable by identity).
//   §2 THE ROAD OVER A FAKE DAEMON: against a proto-5 daemon the connector
//      relays the runner's receipt verbatim (applied, the files named);
//      against a proto-4 daemon (the mixed-version law from the screen's
//      side) the unknown-op refusal answers 'daemon-older' naming the
//      remedy — never a throw, never a silent no-op.
//   §3 THE SURFACES: the slash description says what the verb does; the
//      selector reads the SESSION's facts (never the screen's own
//      file-history state), offers a code restore only where a saved point
//      exists, asks the runner's dry run for the counts, runs ONE restore
//      door and paints the typed refusal; the Settings row beside the
//      switch reports THIS session's capture truth; the branch forks the
//      focused session's transcript (rank 68) with a caught failure.
//   §4 THE DISPLAY PROJECTION is wired into the connector's paint.
//
//  Run: ~/.bun/bin/bun run scripts/rewind/prove-rewind-cockpit.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const HOME = mkdtempSync(join(tmpdir(), 'rewind-cockpit-home-'))
const CONFIG = join(HOME, 'config')
const DAEMON_DIR = join(HOME, 'daemon')
mkdirSync(CONFIG, { recursive: true })
mkdirSync(DAEMON_DIR, { recursive: true })
process.env.MERCURY_CONFIG_DIR = CONFIG
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
delete process.env.MERCURY_HOME
const CONTROL_KEY = 'k'.repeat(64)
writeFileSync(join(DAEMON_DIR, 'control.key'), CONTROL_KEY)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const protocol = await import('../../src/daemon/protocol.ts')
const socketMod = await import('../../src/daemon/controlSocket.ts')
const { encodeFrame, readControlFrame } = protocol
const { controlSockPath, forgetDaemonProtoForTesting } = socketMod
const SESSION = '00000000-0000-4000-8000-00000000rw01'

/** A fake daemon at a given proto: hello keyless; the version gate; the key;
 *  sessionRewind answered with a scripted receipt when the proto knows it,
 *  'unknown op' otherwise (the v4 router's exact refusal). */
function startDaemon(opts: { proto: number; receipt?: Record<string, unknown> }): Promise<{ received: string[]; close: () => Promise<void> }> {
  const received: string[] = []
  const server = net.createServer(sock => {
    readControlFrame(
      sock,
      line => {
        const req = JSON.parse(line) as Record<string, unknown>
        const op = String(req.op)
        received.push(op)
        const answer = (payload: unknown): void => void sock.end(encodeFrame(payload))
        if (op === 'hello') {
          return answer({ ok: true, op: 'hello', proto: opts.proto, minProto: 1, ready: true, version: '9.9.9', buildTree: null, pid: 4242, startedAt: Date.now() - 5000, ownerPid: null, foreground: false, live: 0, liveSessions: 0, warm: 0, restartArmed: false })
        }
        if (op === 'ping') return answer({ ok: true, op: 'ping', version: '9.9.9', proto: opts.proto })
        const proto = req.proto
        if (typeof proto !== 'number' || proto < 1 || proto > opts.proto) {
          return answer({ ok: false, code: 'EPROTO', error: 'proto mismatch', serverProto: opts.proto, serverVersion: '9.9.9' })
        }
        if (req.auth !== CONTROL_KEY) return answer({ ok: false, code: 'EAUTH', error: `${op} rejected: no key` })
        if (op === 'sessionRewind' && opts.proto >= 5) {
          return answer({ ok: true, op: 'sessionRewind', mode: req.mode, ...(opts.receipt ?? { outcome: 'applied' }) })
        }
        if (op === 'sessionControl') return answer({ ok: true, op: 'sessionControl', outcome: 'applied' })
        return answer({ ok: false, code: 'EUNKNOWN', error: `unknown op: ${op}` })
      },
      () => sock.destroy(),
    )
  })
  return new Promise(resolveStart => {
    try {
      unlinkSync(controlSockPath())
    } catch {
      /* no stale socket */
    }
    server.listen(controlSockPath(), () => resolveStart({ received, close: () => new Promise(done => server.close(() => done())) }))
  })
}

// ── §1 the connector doors ──────────────────────────────────────────────────
section('§1 — the connector doors: the resting slot refuses typed; the hosted connector folds the facts')
{
  const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
  const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
  const { publishSessionFacts, readSessionFacts } = await import('../../src/services/engine-connector/seatProjections.ts')
  // The projection publishes through an ordered atomic chain — the file
  // lands a beat later; the connector under proof reads it at construction.
  const untilPublished = async (capture: boolean): Promise<void> => {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const facts = readSessionFacts(SESSION, DAEMON_DIR) as { fileCheckpoints?: { capture?: boolean } } | null
      if (facts?.fileCheckpoints?.capture === capture) return
      await new Promise(r => setTimeout(r, 10))
    }
  }
  const types = read('src/services/engine-connector/types.ts')
  check('the contract declares the three doors', types.includes('checkpointFacts(): CheckpointFactsV1') && types.includes('subscribeCheckpoints(listener: () => void): () => void') && types.includes('rewind(req: RewindRequestV1): Promise<RewindReceiptV1>'))
  const census = read('scripts/engine-connector/prove-connector-contract.ts')
  check('the door census pins them', census.includes("'checkpointFacts'") && census.includes("'subscribeCheckpoints'") && census.includes("'rewind'"))

  const resting = new NoSessionConnector()
  check("the resting slot reads capture 'off' with no restore points", resting.checkpointFacts().capture === 'off' && resting.checkpointFacts().restorable.size === 0)
  const refused = await resting.rewind({ userMessageId: 'u1', mode: 'both' })
  check("…and refuses a rewind typed ('no-chat') naming the door a chat starts through", refused.outcome === 'refused' && refused.refusal === 'no-chat' && (refused.detail ?? '').includes('New Session'), j(refused))

  const record = { sessionId: SESSION, runnerId: 'concourse-w1', title: 'cockpit', projectLabel: 'scratch', workspaceId: '/scratch/nowhere', home: CONFIG }
  const older = new DaemonSessionConnector(record)
  check("a hosted connector with NO facts reads 'unknown' (an older runner — never 'on')", older.checkpointFacts().capture === 'unknown' && older.checkpointFacts().restorable.size === 0)

  const base = { schema: 1 as const, sessionId: SESSION, atMs: Date.now(), model: { effective: 'm', setting: null }, usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false }, identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null }, skills: [], mcp: [], permissionMode: 'default' as const, workspace: { cwd: '/x', originalCwd: '/x', projectRoot: '/x', instructionRoots: [] }, queue: [], pendingModel: null, busy: false }
  publishSessionFacts({ ...base, fileCheckpoints: { capture: true, restorable: ['u-1', 'u-2'] } } as never, DAEMON_DIR)
  await untilPublished(true)
  const seat = new DaemonSessionConnector(record)
  const facts = seat.checkpointFacts()
  check("published facts fold to capture 'on' with the restorable set", facts.capture === 'on' && facts.restorable.has('u-1') && facts.restorable.has('u-2') && !facts.restorable.has('u-3'), j({ c: facts.capture, r: [...facts.restorable] }))
  check('the snapshot is stable by identity across reads (the uSES law)', seat.checkpointFacts() === facts)
  publishSessionFacts({ ...base, fileCheckpoints: { capture: false, restorable: [] } } as never, DAEMON_DIR)
  await untilPublished(false)
  const off = new DaemonSessionConnector(record)
  check("capture false folds to 'off'", off.checkpointFacts().capture === 'off' && off.checkpointFacts().restorable.size === 0)
}

// ── §2 the road over a fake daemon ──────────────────────────────────────────
section('§2 — the road: a proto-5 daemon relays the receipt; a proto-4 daemon answers daemon-older')
{
  const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
  const record = { sessionId: SESSION, runnerId: 'concourse-w1', title: 'cockpit', projectLabel: 'scratch', workspaceId: '/scratch/nowhere', home: CONFIG }
  {
    forgetDaemonProtoForTesting()
    const daemon = await startDaemon({ proto: 5, receipt: { outcome: 'applied', code: { filesChanged: ['alpha.txt'], insertions: 1, deletions: 1 }, conversation: { turnUuid: 'u-2', removed: 3 } } })
    const seat = new DaemonSessionConnector(record)
    const receipt = await seat.rewind({ userMessageId: 'u-2', mode: 'both' })
    check("the daemon received the sessionRewind op", daemon.received.includes('sessionRewind'), j(daemon.received))
    check("the runner's receipt is relayed verbatim (applied · the file · the boundary)", receipt.outcome === 'applied' && receipt.mode === 'both' && receipt.code?.filesChanged[0] === 'alpha.txt' && receipt.conversation?.removed === 3, j(receipt))
    const dry = await seat.rewind({ userMessageId: 'u-2', mode: 'code', dryRun: true })
    check('a dry run rides the wire with its flag and comes back typed', dry.outcome === 'applied' && dry.mode === 'code', j(dry))
    await daemon.close()
  }
  {
    forgetDaemonProtoForTesting()
    const daemon = await startDaemon({ proto: 4 })
    const seat = new DaemonSessionConnector(record)
    const receipt = await seat.rewind({ userMessageId: 'u-2', mode: 'conversation' })
    check("an older daemon's unknown-op refusal answers 'daemon-older' naming /daemon restart (the mixed-version law, screen side)", receipt.outcome === 'refused' && receipt.refusal === 'daemon-older' && (receipt.detail ?? '').includes('/daemon restart'), j({ receipt, received: daemon.received }))
    await daemon.close()
  }
  {
    forgetDaemonProtoForTesting()
    try {
      unlinkSync(controlSockPath())
    } catch {
      /* already gone */
    }
    const seat = new DaemonSessionConnector(record)
    const receipt = await seat.rewind({ userMessageId: 'u-2', mode: 'code' })
    check("no daemon at all answers 'restore-failed' with nothing assumed restored — never a throw", receipt.outcome === 'refused' && receipt.refusal === 'restore-failed' && (receipt.detail ?? '').includes('nothing is assumed restored'), j(receipt))
  }
}

// ── §3 the surfaces ─────────────────────────────────────────────────────────
section('§3 — the surfaces tell the truth')
{
  const command = read('src/commands/rewind/index.ts')
  check('the slash description says what the verb does', command.includes("description: 'Wind back to a saved point — the files, the conversation, or both'"))
  const selector = read('src/components/MessageSelector.tsx')
  check("the selector reads the SESSION's facts through the focused connector", selector.includes('useSyncExternalStore(subscribeFocusedCheckpoints, getFocusedCheckpoints, getFocusedCheckpoints)') && selector.includes("checkpoints.capture === 'on'"))
  check("…never the screen's own file-history state or gate", !selector.includes('fileHistoryEnabled') && !selector.includes('fileHistoryCanRestore') && !selector.includes('fileHistoryGetDiffStats') && !selector.includes('useAppState'))
  check('a code restore is offered only where a saved point exists', selector.includes('const canRestoreCode = historyOn && hasSavedPoint(chosen.uuid)') && selector.includes("'no saved files at this point'"))
  check("the confirm counts come from the runner's dry run", selector.includes("rewind({ userMessageId: chosen.uuid, mode: 'code', dryRun: true })"))
  check('ONE restore door, the typed refusal painted on the card', selector.includes('onRestore: (') && !selector.includes('onRestoreMessage') && !selector.includes('onRestoreCode') && selector.includes("setErrorText(`Not restored — ${receipt.detail ?? receipt.refusal"))
  check('the headline names the off switch and the older-runner case honestly', selector.includes('File checkpoints are off for this session (Settings › File checkpointing)') && selector.includes('an older runner — /daemon restart when ready'))
  check('the option descriptions no longer promise a summary-and-fork that never happened', !selector.includes('will be summarised and the conversation forked'))
  check('the branch forks the FOCUSED session\'s transcript with a caught failure (rank 68)', selector.includes("typeof focused.transcriptFile === 'function' ? focused.transcriptFile() : null") && selector.includes('setErrorText(`branch failed — ') && !selector.includes('getTranscriptPathForSession(String(getSessionId()))'))
  const repl = read('src/screens/REPL.tsx')
  check("the REPL's restore road calls the connector's rewind and paints the receipt", repl.includes('connector.rewind({ userMessageId: message.uuid, mode })') && repl.includes("key: 'rewind-receipt'"))
  check('the composer takes the words back only after a LANDED conversation rewind', repl.includes("if (receipt.outcome === 'applied' && receipt.conversation !== undefined) {") && repl.indexOf('const resubmit = textForResubmit(message);', repl.indexOf('const onRestore = useCallback')) > repl.indexOf("receipt.conversation !== undefined", repl.indexOf('const onRestore = useCallback')))
  check('a running turn is interrupted and given a bounded settle before the ask', repl.includes('connector.interrupt();') && repl.includes('REWIND_SETTLE_WAIT_MS'))
  check("the old 'not available for a managed session yet' refusal no longer fronts the rewind", !repl.includes("refuseSessionRewrite('rewinding the conversation')") && !repl.includes("refuseSessionRewrite('restoring files to a checkpoint')"))
  const config = read('src/components/Settings/Config.tsx')
  check("Settings carries 'Checkpoints in this session' beside the switch, read from the focused connector", config.includes("label: 'Checkpoints in this session'") && config.includes('getFocusedSessionConnector().checkpointFacts()'))
  check('…with the three honest states', config.includes("'not capturing in this session'") && config.includes("predates checkpoint capture (/daemon restart when ready)") && config.includes('restore point'))
}

// ── §4 the display projection ───────────────────────────────────────────────
section('§4 — the display projection is wired into the paint')
{
  const connector = read('src/services/engine-connector/daemonConnector.ts')
  const paint = connector.slice(connector.indexOf('  private paint(): void {'), connector.indexOf('  // ── the /rewind facts + verb'))
  check('paint projects the operator windows out of the chat BY IDENTITY (display-row anchors stay true)', paint.includes('projectOperatorRewinds(this.rawRecords)') && paint.includes('dropped.has(record)'))
  check('a landed conversation rewind re-reads the transcript at once', connector.includes("if (receipt.outcome === 'applied' && receipt.conversation !== undefined && receipt.dryRun !== true) void this.tick()"))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL REWIND COCKPIT PROOFS PASS')
else console.log(`❌ ${failures} REWIND COCKPIT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
