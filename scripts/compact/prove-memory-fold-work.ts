;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Message, RenderableMessage } from '../../src/types/message.ts'

const home = mkdtempSync(join(tmpdir(), 'memory-fold-work-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_TMPDIR = home
process.env.MERCURY_SM_COMPACT = '1'
process.env.MERCURY_TURN_RECEIPT = '1'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { getSessionMemoryPath, getMercuryTempDir } = await import('../../src/utils/permissions/filesystem.ts')
const { trySessionMemoryCompaction } = await import('../../src/services/compact/sessionMemoryCompact.ts')
const { buildPostCompactMessages } = await import('../../src/services/compact/compact.ts')
const { injectTurnReceipts } = await import('../../src/utils/cockpit/turnReceipt.ts')
const { buildAwayRecap } = await import('../../src/utils/cockpit/awaySummary.ts')
const timestamp = new Date().toISOString()
const user = (content: unknown) => ({ type: 'user', uuid: randomUUID(), timestamp, message: { role: 'user', content } }) as Message
const messages = [user('Check twelve commands.')]
for (let index = 0; index < 12; index++) {
  const id = randomUUID()
  messages.push({ type: 'assistant', uuid: randomUUID(), timestamp, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: `Check ${index}.` }, { type: 'tool_use', id, name: 'Bash', input: { command: 'true' } }] } } as Message)
  messages.push(user([{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(16_000) }]))
}
let failures = 0
const check = (label: string, ok: boolean) => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`) }
const counts = (rows: Message[]) => injectTurnReceipts(rows as RenderableMessage[], getMercuryTempDir()).filter(row => row.type === 'turn_receipt').map(row => row.counts)
const recap = (rows: Message[]) => { const r = buildAwayRecap(rows, Date.now()); return { turns: r?.turns, topTools: r?.topTools, filesTouched: r?.filesTouched, toolFailures: r?.toolFailures } }
try {
  const path = getSessionMemoryPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '# Current State\nTwelve commands completed.\n')
  const result = await trySessionMemoryCompaction(messages)
  check('session-memory fold resolves with a shortened tail', !!result && result.messagesToKeep!.length > 0 && result.messagesToKeep!.length < messages.length)
  if (result) {
    const after = buildPostCompactMessages(result)
    check('session-memory boundary stamps work', result.boundaryMarker.compactMetadata.work !== undefined)
    check('session-memory fold retains the full work line', JSON.stringify(counts(after)) === JSON.stringify(counts(messages)))
    check('session-memory fold retains the full resume card', JSON.stringify(recap(after)) === JSON.stringify(recap(messages)))
    const again = await trySessionMemoryCompaction(after)
    check('repeated session-memory fold carries the counts once', !!again && JSON.stringify(counts(buildPostCompactMessages(again))) === JSON.stringify(counts(messages)) && JSON.stringify(recap(buildPostCompactMessages(again))) === JSON.stringify(recap(messages)))
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} memory fold work (${failures} failures)`)
process.exit(failures ? 1 : 0)
