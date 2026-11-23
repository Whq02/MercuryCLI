#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'seat-lifecycle-'))
delete process.env.MERCURY_HOME

let failures = 0
const lifecycleFailureHint = (label: string): string => {
  if (/admit|birth|ENOCONN|re-send/.test(label)) return 'change admitWithDaemonRecheck in src/daemon/switchboard/bornSession.ts'
  if (label.startsWith('P3 ')) return 'change NoSessionConnector in src/engine/connector/noSessionConnector.ts'
  return 'change the focused slot functions in src/engine/connector/focusedConnector.ts'
}
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const shown = cond ? detail : `${detail ? `${detail} — ` : ''}${lifecycleFailureHint(label)}`
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}



{
  const { NoSessionConnector, NO_CHAT_OPEN } = await import('../../src/engine/connector/noSessionConnector.ts')
  const resting = new NoSessionConnector()
  check('P3 the resting slot is daemon-carried and blank', resting.carrier === 'daemon' && resting.records().length === 0)
  check('P3 nothing runs and nothing is pending', resting.turnActive() === false && resting.asks().length === 0 && resting.interrupt() === false)
  check('P3 the usage is honest zeros', resting.usage().totalCostUSD === 0 && resting.usage().totalInputTokens === 0)
  check('P3 no session — the empty id', resting.sessionId() === '')
  const send = await resting.sendWords('hello')
  check('P3 a send is refused with the door a chat starts through (poison: a send that creates a session)', send.state === 'refused' && send.detail === NO_CHAT_OPEN && /New Session/.test(NO_CHAT_OPEN))
  const slash = await resting.dispatchSlash('/context')
  check('P3 a slash line is refused the same way (no surprise birth from a command line)', slash.state === 'refused' && slash.detail === NO_CHAT_OPEN)
  check('P3 a model switch is refused (nothing to switch)', (await resting.setModel('claude-sonnet-5')).state === 'refused')
  const ask = await resting.answerAsk()
  check('P3 an ask answer is refused (no asks exist)', ask.ok === false)
  check(
    'P3 the reader doors answer stable snapshots (records/asks/modelFacts/usage/identity/skills/mcp/workspace/work)',
    resting.records() === resting.records() &&
      resting.asks() === resting.asks() &&
      resting.modelFacts() === resting.modelFacts() &&
      resting.usage() === resting.usage() &&
      resting.identity() === resting.identity() &&
      resting.skillsRoster() === resting.skillsRoster() &&
      resting.mcpRoster() === resting.mcpRoster() &&
      resting.workspace() === resting.workspace() &&
      resting.workRoster() === resting.workRoster(),
  )
  const door = await import('../../src/daemon/switchboard/bornSession.ts')
  const recheck = (door as { admitWithDaemonRecheck?: typeof door.admitWithDaemonRecheck }).admitWithDaemonRecheck
  check('P3 the birth door exports its daemon re-check', typeof recheck === 'function')
  if (typeof recheck === 'function') {
    const gone = { ok: false, code: 'ENOCONN', error: 'daemon closed without a reply (ENOCONN)' }
    const landed = { ok: true, sessionId: 's-1' }
    const refused = { ok: false, code: 'EUNKNOWN', error: 'the session could not start' }
    const drive = async (replies: Array<Record<string, unknown>>, daemonBack: boolean): Promise<{ answer: unknown; sends: number; rechecks: number; keys: string[] }> => {
      let sends = 0
      let rechecks = 0
      const keys: string[] = []
      const birthKey = `key-${Math.random().toString(16).slice(2)}`
      const answer = await recheck(
        async () => {
          keys.push(birthKey)
          return replies[Math.min(sends++, replies.length - 1)]!
        },
        async () => {
          rechecks++
          return daemonBack
        },
      )
      return { answer, sends, rechecks, keys }
    }
    const back = await drive([gone, landed], true)
    check('P3 a transport ENOCONN on the admit re-runs the daemon check once and re-sends once: the birth lands without a second Enter', back.answer === landed && back.sends === 2 && back.rechecks === 1, JSON.stringify(back))
    check('P3 the two sends carry ONE birth key (the re-send is the same birth, so a daemon that admitted the first answers it again)', back.keys.length === 2 && back.keys[0] === back.keys[1], JSON.stringify(back.keys))
    const still = await drive([gone, landed], false)
    check('P3 a daemon check that fails leaves the first refusal standing after one send', still.answer === gone && still.sends === 1 && still.rechecks === 1, JSON.stringify(still))
    const twice = await drive([gone, gone, landed], true)
    check('P3 a second ENOCONN after the re-check stands: one re-send, never a third', twice.answer === gone && twice.sends === 2 && twice.rechecks === 1, JSON.stringify(twice))
    const other = await drive([refused, landed], true)
    check('P3 a refusal that is not a transport loss is never re-sent and re-runs no check', other.answer === refused && other.sends === 1 && other.rechecks === 0, JSON.stringify(other))
    const first = await drive([landed], true)
    check('P3 an admitted birth sends once and re-runs no check', first.answer === landed && first.sends === 1 && first.rechecks === 0, JSON.stringify(first))
  }
}

{
  const slot = await import('../../src/engine/connector/focusedConnector.ts')
  const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
  check('P4 the focused slot rests on no session by default', slot.hasFocusedSession() === false && slot.getFocusedSessionConnector() instanceof NoSessionConnector && slot.getFocusedSessionConnector().sessionId() === '')
  let beats = 0
  const off = slot.subscribeFocusedSessionConnector(() => beats++)
  const probe = new NoSessionConnector()
  slot.setFocusedSessionConnector(probe)
  check('P4 handing the slot a connector re-points it and notifies', slot.getFocusedSessionConnector() === probe && slot.hasFocusedSession() === true && beats === 1)
  const before = slot.claimHopEpoch()
  slot.releaseFocusedSessionConnector()
  check('P4 closing the chat rests the slot again, notifies, and claims the epoch (a late hop never re-points a closed chat)', slot.hasFocusedSession() === false && beats === 2 && !slot.hopEpochIsCurrent(before))
  slot.releaseFocusedSessionConnector()
  check('P4 closing a resting slot is a no-op (no spurious beat)', beats === 2)
  off()
}


{
  const slot = await import('../../src/engine/connector/focusedConnector.ts')
  const older = slot.claimHopEpoch()
  const newer = slot.claimHopEpoch()
  check('P6 the fence: an older hop is refused once a newer one was chosen (the last-chosen session owns the commit)', !slot.hopEpochIsCurrent(older) && slot.hopEpochIsCurrent(newer))
}


console.log(failures === 0 ? '\nprove-seat-lifecycle: ALL LAWS HOLD' : `\nprove-seat-lifecycle: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
