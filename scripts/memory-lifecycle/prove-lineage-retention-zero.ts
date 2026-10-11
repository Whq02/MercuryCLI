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
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const settings = await import('../../src/utils/settings/settings.ts')
  const state = await import('../../src/bootstrap/state.ts')
  const session = await import('../../src/mneme/lineageSession.ts')
  const ask = await import('../../src/mneme/handoffAsk.ts')
  const exit = await import('../../src/mneme/exitHandoff.ts')
  const ledger = await import('../../src/mneme/ledger.ts')
  const paths = await import('../../src/mneme/paths.ts')
  const { saveCacheSafeParams } = await import('../../src/utils/forkedAgent.ts')
  const { createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
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
  assert.equal(readFileSync(paths.lineagePath(key), 'utf8'), before, 'retention zero stops engine, ruling, fact, file and close writes')
  assert.ok(ledger.ledgerEntryOf(key, String(state.getSessionId())), 'existing entries remain readable')
  session._resetLineageSessionForTesting()
  session.noteSessionEngine('resumed')
  assert.equal(ask.handoffAskDue({ querySource: 'sdk' }), false, 'a resumed open entry at retention zero cannot ask')
  assert.equal(exit.exitNoteDue(), false)
  let calls = 0
  const run = async () => { calls++; return { messages: [createAssistantMessage({ content: 'note' })] } }
  await ask.askForHandoff({ cacheSafeParams, run })
  await exit.leaveNoteBeforeExit({ run })
  assert.equal(calls, 0, 'neither closing entry point invokes the provider at retention zero')
  setRetention(30)
  ask._resetHandoffAskForTesting()
  const beforeAwait = readFileSync(paths.lineagePath(key), 'utf8')
  await ask.askForHandoff({ cacheSafeParams, run: async () => {
    await Promise.resolve()
    setRetention(0)
    return { messages: [createAssistantMessage({ content: 'must not persist' })] }
  } })
  assert.equal(readFileSync(paths.lineagePath(key), 'utf8'), beforeAwait, 'retention is rechecked after the awaited note')
  console.log('LINEAGE RETENTION ZERO GREEN')
} finally {
  rmSync(home, { recursive: true, force: true })
}
