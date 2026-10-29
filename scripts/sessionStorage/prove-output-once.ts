import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'output-once-'))
process.env.MERCURY_CONFIG_DIR = home
await import('../../src/tasks.ts')
const { recordTranscript, settleTranscriptMessage, getProject, setSessionFileForTesting } = await import('../../src/utils/sessionStorage/writer.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages/factories.ts')
const file = join(home, 'session.jsonl')
setSessionFileForTesting(file)
const records = () => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
try {
  const request = createUserMessage({ content: 'fixture turn' })
  const reply = { ...createAssistantMessage({ content: 'fixture answer' }), requestId: 'fixture-request' }
  await Promise.all([recordTranscript([request, reply]), recordTranscript([request, reply])])
  await getProject().flush()
  const reordered = { ...reply, message: Object.fromEntries(Object.entries(reply.message).reverse()) } as typeof reply
  reordered.message.usage = Object.fromEntries(Object.entries(reply.message.usage).reverse()) as typeof reply.message.usage
  await settleTranscriptMessage(reordered)
  await getProject().flush()
  assert.equal(records().filter(row => row.recordId === reply.uuid).length, 1, 'equivalent output is not written again when object key order changes')
  reordered.message.usage = { ...reordered.message.usage, output_tokens: 77 }
  await settleTranscriptMessage(reordered)
  await getProject().flush()
  const outputs = records().filter(row => row.recordId === reply.uuid)
  assert.equal(outputs.length, 2, 'a real settlement update remains durable')
  assert.equal(outputs[1].updates, reply.uuid)
  assert.equal(outputs[1].payload.usage.outputTokens, 77)
  await settleTranscriptMessage(reordered)
  await getProject().flush()
  assert.equal(records().filter(row => row.recordId === reply.uuid).length, 2)
  console.log('PASS duplicate turn publication and equivalent settlement write once; changed usage keeps its update record')
} finally {
  await getProject().flush()
  rmSync(home, { recursive: true, force: true })
}
