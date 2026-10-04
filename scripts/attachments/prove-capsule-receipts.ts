import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const rootArg = process.argv.indexOf('--source-root')
const root = rootArg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[rootArg + 1]!)
const scratch = mkdtempSync(join(tmpdir(), 'capsule-receipt-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
let failures = 0
const check = (label: string, good: boolean) => {
  console.log(`${good ? 'PASS' : 'FAIL'} ${label}`)
  if (!good) failures++
}
try {
  const { enableConfigs } = await import(`${root}/src/utils/config/globalConfig.ts`)
  enableConfigs()
  const writer = await import(`${root}/src/utils/sessionStorage/writer.ts`)
  const { loadTranscriptFile } = await import(`${root}/src/utils/sessionStorage/loading.ts`)
  const { createAttachmentMessage } = await import(`${root}/src/utils/attachments/orchestrator.ts`)
  const { createUserMessage } = await import(`${root}/src/utils/messages/factories.ts`)
  const { normalizeAttachmentForAPI } = await import(`${root}/src/utils/messages/attachmentText.ts`)
  const receipt = { type: 'dynamic_skill', skillDir: '/proof/skills', displayPath: 'skills', skillNames: ['proof-skill'], capsuleReceipt: 'proof-digest' }
  check('the fixture is genuinely wire-silent before persistence', normalizeAttachmentForAPI(receipt).length === 0)
  const transcript = join(scratch, 'receipt.jsonl')
  writer.setSessionFileForTesting(transcript)
  await writer.recordTranscript([createUserMessage({ content: 'receipt proof' }), createAttachmentMessage(receipt)])
  await writer.flushSessionStorage()
  check('the wire-silent receipt and membership field are written to disk', readFileSync(transcript, 'utf8').includes('"capsuleReceipt":"proof-digest"'))
  const loaded = await loadTranscriptFile(transcript, { keepAllLeaves: true })
  const restored = [...loaded.messages.values()].find((message: any) => message.type === 'attachment' && message.attachment.capsuleReceipt === 'proof-digest') as any
  check('the resume reader restores the original kind and membership field', restored?.attachment.type === 'dynamic_skill' && restored.attachment.skillNames[0] === 'proof-skill')
  check('the restored receipt still projects no model block', !!restored && normalizeAttachmentForAPI(restored.attachment).length === 0)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures ? `FAIL capsule receipts: ${failures} checks` : 'PASS capsule receipts')
process.exit(failures ? 1 : 0)
