#!/usr/bin/env bun
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'crew-messages-kind-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${t}`)
}

const types = (await import('../../src/utils/attachments/types.ts')) as Record<string, unknown>
const attachmentText = await import('../../src/utils/messages/attachmentText.ts')
const validate = await import('../../src/fabric/validate.ts')
const React = await import('react')
const { render } = await import('../../src/ink.js')
const { AttachmentMessage } = await import('../../src/components/messages/AttachmentMessage.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')

const NEW_KIND = 'crew_messages'
const OLD_KIND = 'teammate_mailbox'
const messages = [{ from: 'beacon', text: 'the manifest edit is in', timestamp: '2026-06-19T12:00:10.000Z', color: 'green', summary: 'manifest edit landed' }]
const fresh = { type: NEW_KIND, messages }
const old = { type: OLD_KIND, messages }

console.log('============================================================')
console.log(' the crew messages row kind: written as crew_messages; an old kind is an unknown kind')
console.log('============================================================')

section('§1 the kind the product writes is the crew\'s, owned by the attachment types; no alias table stands beside it')
check('CREW_MESSAGES_KIND is exported and reads crew_messages', types.CREW_MESSAGES_KIND === NEW_KIND, String(types.CREW_MESSAGES_KIND))
check('the attachment types carry no alias table and no kind translator (RED on the base: OLD_ATTACHMENT_KINDS and currentAttachmentKind)', !('OLD_ATTACHMENT_KINDS' in types) && !('currentAttachmentKind' in types))
check('the crew-messages predicate reads the one kind alone', types.isCrewMessagesAttachment(fresh as never) && !types.isCrewMessagesAttachment(old as never))

section('§2 the composer speaks the crew kind; an unknown kind composes nothing')
const freshText = attachmentText.normalizeAttachmentForAPI(fresh as never)
const oldText = attachmentText.normalizeAttachmentForAPI(old as never)
const wordsOf = (rows: unknown[]): string => JSON.stringify(rows.map(r => (r as { message?: { content?: unknown } }).message?.content ?? null))
check('a crew_messages row composes the crewmate-message envelope for the model', freshText.length === 1 && wordsOf(freshText).includes('the manifest edit is in') && wordsOf(freshText).includes('summary=\\"manifest edit landed\\"'), wordsOf(freshText).slice(0, 200))
check('a row under the old kind composes nothing for the model (an unknown kind, as any unknown word)', oldText.length === 0, wordsOf(oldText).slice(0, 200))

section('§3 the record validator knows the crew kind and no old spelling')
check('crew_messages is a registered attachment kind', validate.BODY_SHAPE_KINDS.attachment.includes(NEW_KIND), validate.BODY_SHAPE_KINDS.attachment.filter(k => /message|mailbox/.test(k)).join(','))
check('teammate_mailbox is not a registered attachment kind (RED on the base: a row kept for it)', !validate.BODY_SHAPE_KINDS.attachment.includes(OLD_KIND))

section('§4 the painter paints the crew row with the sender and the summary; the old kind paints nothing')
async function paint(attachment: unknown): Promise<string> {
  let written = ''
  const stdout = Object.assign(
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        written += chunk.toString()
        cb()
      },
    }),
    { columns: 100, rows: 24, isTTY: false },
  ) as unknown as NodeJS.WriteStream
  const h = React.createElement as (...a: unknown[]) => React.ReactElement
  const instance = await render(h(AppStateProvider as never, {}, h(AttachmentMessage as never, { attachment, isTranscriptMode: true })), { stdout, exitOnCtrlC: false, patchConsole: false })
  await new Promise(r => setTimeout(r, 80))
  instance.unmount()
  return written.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
}
const freshFrame = await paint(fresh)
const oldFrame = await paint(old)
check('a crew_messages row paints its sender and summary', /beacon/.test(freshFrame) && /manifest edit landed/.test(freshFrame), freshFrame.slice(0, 200))
check('a row under the old kind paints nothing (RED on the base: it painted as the crew row)', !/beacon/.test(oldFrame) && !/manifest edit landed/.test(oldFrame), oldFrame.slice(0, 200))

section('§5 no product file names the old kind at all')
function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}
const writers = walk(join(ROOT, 'src')).filter(path => /teammate_mailbox/.test(readFileSync(path, 'utf8'))).map(path => path.slice(ROOT.length + 1))
check('no product file names the old kind (RED on the base: the alias table, the old-row type, the validator\'s row)', writers.length === 0, writers.join(', '))
const writerSource = readFileSync(join(ROOT, 'src/utils/attachments/crewmates.ts'), 'utf8')
check('the one writer of the row writes the crew kind (RED on the base: the old kind)', /type: 'crew_messages'/.test(writerSource) && !/teammate_mailbox/.test(writerSource))

console.log(failures === 0 ? '\nprove-crew-messages-kind: ALL LAWS HOLD' : `\nprove-crew-messages-kind: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
