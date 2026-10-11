import assert from 'node:assert/strict'
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
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { noteSessionEngine } = await import('../../src/mneme/lineageSession.ts')
  const { leaveNoteBeforeExit } = await import('../../src/mneme/exitHandoff.ts')
  const handoff = await import('../../src/mneme/handoffAsk.ts')
  const { saveCacheSafeParams } = await import('../../src/utils/forkedAgent.ts')
  const { lineagePath, mnemeProjectKey } = await import('../../src/mneme/paths.ts')
  const { createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
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
  const turn = readFileSync(new URL('../../src/run-core/turn-machine.ts', import.meta.url), 'utf8')
  assert.match(turn, /createSystemMessage\(\s*handoffNotice\(note\)/, 'the turn caller uses the same truthful notice')
  console.log('HANDOFF WRITE RECEIPT GREEN')
} finally {
  rmSync(home, { recursive: true, force: true })
}
