import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'lineage-zero-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE
try {
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const settings = await import('../../src/platform/settings/settings.ts')
  const state = await import('../../src/boot/process-state/processState.ts')
  const session = await import('../../src/sessions/mneme/lineageSession.ts')
  const ask = await import('../../src/sessions/mneme/handoffAsk.ts')
  const exit = await import('../../src/sessions/mneme/exitHandoff.ts')
  const ledger = await import('../../src/sessions/mneme/ledger.ts')
  const paths = await import('../../src/sessions/mneme/paths.ts')
  const { saveCacheSafeParams } = await import('../../src/crew/agents/forkedAgent.ts')
  const { createAssistantMessage } = await import('../../src/engine/message-shapes/factories.ts')
  const setRetention = (days: number) => {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ records: { retentionDays: days } }))
    assert.equal(settings.getSettingsWithSources().effective.records?.retentionDays, days)
  }
  const cacheSafeParams = { systemPrompt: [] as never, userContext: {}, systemContext: {}, toolUseContext: {} as never, forkContextMessages: [] }
  const key = paths.mnemeProjectKey()
  state.setRunInputClosed(true)
  setRetention(30)
  session.noteSessionEngine('first')
  saveCacheSafeParams(cacheSafeParams)
  const before = readFileSync(paths.lineagePath(key), 'utf8')
  setRetention(0)
  session.noteSessionEngine('second')
  session.noteRetained('seq:1', true)
  session.noteCorrected('seq:2')
  session.noteFileTouched('file.ts')
  await session.closeLineageSession('closed')
  assert.equal(readFileSync(paths.lineagePath(key), 'utf8'), before, 'retention zero stops engine, ruling, fact, file and close writes: the note* functions in src/sessions/mneme/lineageSession.ts must return without writing the ledger when lineageKept() is false (records.retentionDays is 0), and closeLineageSession there must write no close either')
  assert.ok(ledger.ledgerEntryOf(key, String(state.getSessionId())), 'existing entries remain readable: retention zero must stop writes only; readLedgerFile and ledgerEntryOf in src/sessions/mneme/ledger.ts must still read the entry already stored')
  session._resetLineageSessionForTesting()
  session.noteSessionEngine('resumed')
  assert.equal(ask.handoffAskDue({ querySource: 'sdk' }), false, 'a resumed open entry at retention zero cannot ask: handoffAskDue in src/sessions/mneme/handoffAsk.ts must return false while records.retentionDays is 0')
  assert.equal(exit.exitNoteDue(), false, 'exitNoteDue in src/sessions/mneme/exitHandoff.ts must return false at retention zero (it should stop on lineageJoined() from src/sessions/mneme/lineageSession.ts)')
  let calls = 0
  const run = async () => { calls++; return { messages: [createAssistantMessage({ content: 'note' })] } }
  await ask.askForHandoff({ cacheSafeParams, run })
  await exit.leaveNoteBeforeExit({ run })
  assert.equal(calls, 0, 'neither closing entry point invokes the provider at retention zero: askForHandoff (src/sessions/mneme/handoffAsk.ts) and leaveNoteBeforeExit (src/sessions/mneme/exitHandoff.ts) must return before calling run while records.retentionDays is 0')
  setRetention(30)
  ask._resetHandoffAskForTesting()
  const beforeAwait = readFileSync(paths.lineagePath(key), 'utf8')
  await ask.askForHandoff({ cacheSafeParams, run: async () => {
    await Promise.resolve()
    setRetention(0)
    return { messages: [createAssistantMessage({ content: 'must not persist' })], terminal: { reason: 'completed' } }
  } })
  assert.equal(readFileSync(paths.lineagePath(key), 'utf8'), beforeAwait, 'retention is rechecked after the awaited note: askForHandoff in src/sessions/mneme/handoffAsk.ts must check retention again after run returns and store nothing when records.retentionDays became 0 during the ask')
  console.log('LINEAGE RETENTION ZERO GREEN')
} finally {
  rmSync(home, { recursive: true, force: true })
}
