import assert from 'node:assert/strict'
import { spyOn } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'handoff-write-receipt-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE
try {
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const { noteSessionEngine } = await import('../../src/sessions/mneme/lineageSession.ts')
  const { leaveNoteBeforeExit } = await import('../../src/sessions/mneme/exitHandoff.ts')
  const handoff = await import('../../src/sessions/mneme/handoffAsk.ts')
  const { saveCacheSafeParams } = await import('../../src/crew/agents/forkedAgent.ts')
  const { lineagePath, mnemeProjectKey } = await import('../../src/sessions/mneme/paths.ts')
  const { createAssistantMessage } = await import('../../src/engine/message-shapes/factories.ts')
  const params = { systemPrompt: [] as never, userContext: {}, systemContext: {}, toolUseContext: {} as never, forkContextMessages: [] }
  noteSessionEngine('fixture')
  saveCacheSafeParams(params)
  const file = lineagePath(mnemeProjectKey())
  const before = readFileSync(file, 'utf8')
  chmodSync(file, 0o400)
  const notices: string[] = []
  const run = async () => ({ messages: [createAssistantMessage({ content: 'a note that cannot be saved' })], terminal: { reason: 'completed' as const } })
  const outcome = await leaveNoteBeforeExit({ run, onNotice: text => notices.push(text) } as never)
  assert.equal(readFileSync(file, 'utf8'), before, 'fixture really refused the append')
  assert.equal(outcome, 'none', 'an unwritable ledger is never reported stored')
  assert.ok(notices.some(text => text.includes('the note could not be stored')), 'exit says preservation failed')
  handoff._resetHandoffAskForTesting()
  const note = await handoff.askForHandoff({ cacheSafeParams: params, run })
  assert.equal(note?.stored, false)
  assert.match(handoff.handoffNotice(note), /the note could not be stored/)
  const t = await import('../core-runtime/turnScenarios.ts')
  const forked = await import('../../src/crew/agents/forkedAgent.ts')
  const bootstrap = await import('../../src/boot/process-state/processState.ts')
  const asks: string[] = []
  const runner = spyOn(forked, 'runForkedAgent').mockImplementation((async (asked: { forkLabel?: string }) => {
    asks.push(String(asked.forkLabel))
    return run()
  }) as never)
  let turnFile = ''
  const lastTurn = await t.runScripted({
    before: () => {
      noteSessionEngine('fixture')
      turnFile = lineagePath(mnemeProjectKey())
      chmodSync(turnFile, 0o400)
      handoff._resetHandoffAskForTesting()
      bootstrap.setRunInputClosed(true)
      return () => bootstrap.setRunInputClosed(false)
    },
    script: [t.fixtures.yields(t.fixtures.says('the work is done.'))],
  })
  runner.mockRestore()
  const said = lastTurn.events
    .filter(event => event.kind === 'notice')
    .map(event => event.message as { subtype?: string; level?: string; content?: unknown; closeState?: string })
    .map(row => (row.subtype === 'close_usage' ? `close ${String(row.closeState)}` : `${String(row.level)}: ${String(row.content)}`))
  assert.deepEqual(asks, ['handoff'], 'the turn that ends the session asks for its note once')
  assert.ok(turnFile.startsWith(lastTurn.home) && !readFileSync(turnFile, 'utf8').includes('a note that cannot be saved'), 'fixture really refused the append of the turn\'s note')
  assert.equal(lastTurn.terminal.reason, 'completed')
  assert.deepEqual(
    said,
    ['close skipped', `warning: ${handoff.handoffNotice(note)}`],
    'the turn caller uses the same truthful notice: after a handoff ask whose note was not stored, replyStands (src/engine/loop/turn/noToolReply.ts) must yield the close row as skipped and then createSystemMessage(handoffNotice(note), \'warning\')',
  )
  console.log('HANDOFF WRITE RECEIPT GREEN')
} finally {
  rmSync(home, { recursive: true, force: true })
}
