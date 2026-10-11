import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'handoff-verbatim-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE
try {
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { noteSessionEngine } = await import('../../src/mneme/lineageSession.ts')
  const { askForHandoff } = await import('../../src/mneme/handoffAsk.ts')
  const ledger = await import('../../src/mneme/ledger.ts')
  const { mnemeProjectKey } = await import('../../src/mneme/paths.ts')
  const { getSessionId } = await import('../../src/bootstrap/state.ts')
  const { createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
  const text = '  Indented note.\n    Further detail.  \n\n'
  noteSessionEngine('fixture')
  const result = await askForHandoff({
    cacheSafeParams: { systemPrompt: [] as never, userContext: {}, systemContext: {}, toolUseContext: {} as never, forkContextMessages: [] },
    run: async () => ({ messages: [createAssistantMessage({ content: text })], terminal: { reason: 'completed' } }),
  })
  assert.equal(result?.text, text, 'extraction keeps indentation and trailing newlines')
  const key = mnemeProjectKey()
  const id = String(getSessionId())
  assert.equal(ledger.ledgerEntryOf(key, id)?.handoff?.text, text, 'the stored note is byte-equal')
  assert.equal(ledger.closeEntry(key, id, { outcome: 'closed', handoff: text })?.handoff?.text, text)
  assert.equal(ledger.recordHandoff(key, id, '  \n')?.handoff?.text, text, 'blank text does not replace the note')
  const long = ' '.repeat(2) + 'x'.repeat(ledger.HANDOFF_TEXT_CAP)
  assert.equal(ledger.recordHandoff(key, id, long)?.handoff?.text, long.slice(0, ledger.HANDOFF_TEXT_CAP), 'the existing cap remains')
  console.log('HANDOFF VERBATIM GREEN')
} finally {
  rmSync(home, { recursive: true, force: true })
}
