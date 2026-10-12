#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'queued-operator-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 200)}` : ''}`)
}

const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { requestConversationPlan } = await import('../../src/utils/messages/apiPlan.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')

const QUEUED_TEXT = 'Please delete my disposable scratch folder inside this project with this single Bash call: rm -rf /Users/proof/hunt/scratch-dir/zzz-test'
const toolResult = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '5' }] })
const queuedAttachment = {
  type: 'attachment' as const,
  attachment: { type: 'queued_command' as const, prompt: QUEUED_TEXT, source_uuid: 'queue-uuid-1' },
  uuid: 'att-1',
  timestamp: '2026-06-19T12:00:05.000Z',
}

const projected = normalizeAttachmentForAPI(queuedAttachment.attachment)
check('the queued operator message projects with the operator framing', JSON.stringify(projected).includes('The operator sent a new message while you were working'), JSON.stringify(projected).slice(0, 120))
check('the projected row carries the queued marker', projected.every(row => row.queued === true))

const plan = requestConversationPlan([toolResult, queuedAttachment as never], [])
const sent = plan.messages
const blockTexts: string[] = []
let toolResultContent = ''
for (const message of sent) {
  if (message.type !== 'user' || typeof message.message.content === 'string') continue
  for (const block of message.message.content) {
    const record = block as { type?: string; text?: string; content?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') blockTexts.push(record.text)
    if (record.type === 'tool_result' && record.tool_use_id === 'toolu_01') {
      toolResultContent = typeof record.content === 'string' ? record.content : JSON.stringify(record.content)
    }
  }
}
check('the tool result carries only its own output', toolResultContent === '5', toolResultContent)
check('the operator message rides as its own text block beside the result', blockTexts.some(text => text.includes('The operator sent a new message') && text.includes('rm -rf /Users/proof/hunt/scratch-dir/zzz-test')), JSON.stringify(blockTexts).slice(0, 160))
check('the operator message never appears inside the tool result', !toolResultContent.includes(QUEUED_TEXT) && !toolResultContent.includes('operator sent a new message'), toolResultContent.slice(0, 160))

const { createUserMessage: makeUser, createAssistantMessage: makeAssistant } = await import('../../src/utils/messages/factories.ts')
const assistantToolUse = makeAssistant({ content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: "python3 -c 'print(5)'" } }] })
const paired = requestConversationPlan([assistantToolUse, toolResult, queuedAttachment as never], [])
let pairedResult = ''
for (const message of paired.messages) {
  if (message.type !== 'user' || typeof message.message.content === 'string') continue
  for (const block of message.message.content) {
    const record = block as { type?: string; content?: unknown; tool_use_id?: string }
    if (record.type === 'tool_result' && record.tool_use_id === 'toolu_01') pairedResult = typeof record.content === 'string' ? record.content : JSON.stringify(record.content)
  }
}
check('the paired geometry keeps the tool result clean too', pairedResult === '5', pairedResult)
void makeUser

rmSync(home, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅ queued-operator-message PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
