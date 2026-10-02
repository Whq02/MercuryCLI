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
console.log(' the crew messages row kind: written as crew_messages, the old kind still read')
console.log('============================================================')

section('§1 the kind the product writes is the crew\'s, owned by the attachment types')
check('CREW_MESSAGES_KIND is exported and reads crew_messages (RED on the base: no such export)', types.CREW_MESSAGES_KIND === NEW_KIND, String(types.CREW_MESSAGES_KIND))
const aliases = (types.OLD_ATTACHMENT_KINDS ?? {}) as Record<string, string>
check('the read-side alias table maps the old kind to the crew kind (RED on the base: no table)', aliases[OLD_KIND] === NEW_KIND, JSON.stringify(aliases))
const currentKind = types.currentAttachmentKind as ((type: string) => string) | undefined
check('currentAttachmentKind resolves the old kind to the crew kind and leaves every other kind alone', currentKind !== undefined && currentKind(OLD_KIND) === NEW_KIND && currentKind(NEW_KIND) === NEW_KIND && currentKind('queued_command') === 'queued_command')

section('§2 the composer speaks the same words for the crew kind and the old kind')
const freshText = attachmentText.normalizeAttachmentForAPI(fresh as never)
const oldText = attachmentText.normalizeAttachmentForAPI(old as never)
const wordsOf = (rows: unknown[]): string => JSON.stringify(rows.map(r => (r as { message?: { content?: unknown } }).message?.content ?? null))
check('a crew_messages row composes the crewmate-message envelope for the model (RED on the base: nothing)', freshText.length === 1 && wordsOf(freshText).includes('the manifest edit is in') && wordsOf(freshText).includes('summary=\\"manifest edit landed\\"'), wordsOf(freshText).slice(0, 200))
check('an old teammate_mailbox row still composes the same words', oldText.length === 1 && wordsOf(oldText) === wordsOf(freshText), wordsOf(oldText).slice(0, 200))

section('§3 the record validator knows both kinds, the old through the alias table')
check('crew_messages is a registered attachment kind (RED on the base: unknown)', validate.BODY_SHAPE_KINDS.attachment.includes(NEW_KIND), validate.BODY_SHAPE_KINDS.attachment.filter(k => /message|mailbox/.test(k)).join(','))
check('teammate_mailbox is still a registered attachment kind (old transcripts parse)', validate.BODY_SHAPE_KINDS.attachment.includes(OLD_KIND))

section('§4 the painter paints both rows with the sender and the summary')
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
check('a crew_messages row paints its sender and summary (RED on the base: nothing painted)', /beacon/.test(freshFrame) && /manifest edit landed/.test(freshFrame), freshFrame.slice(0, 200))
check('an old teammate_mailbox row paints the same', /beacon/.test(oldFrame) && /manifest edit landed/.test(oldFrame), oldFrame.slice(0, 200))

section('§5 no product file writes the old kind; its literal lives on the read side alone: the alias table and the old-row type, the validator\'s row')
function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}
const READ_SIDE = [join('utils', 'attachments', 'types.ts'), join('fabric', 'validate.ts')]
const writers = walk(join(ROOT, 'src')).filter(path => {
  const source = readFileSync(path, 'utf8')
  return /['"]teammate_mailbox['"]/.test(source) && !READ_SIDE.some(suffix => path.endsWith(suffix))
}).map(path => path.slice(ROOT.length + 1))
check('no product file outside the read side names the old kind (RED on the base: the writer, the orchestrator, the composer, the painter)', writers.length === 0, writers.join(', '))
const typesSource = readFileSync(join(ROOT, 'src/utils/attachments/types.ts'), 'utf8')
check('the attachment types name the old kind exactly twice: the alias table and the old-row type', (typesSource.match(/teammate_mailbox/g) ?? []).length === 2, String((typesSource.match(/teammate_mailbox/g) ?? []).length))
const validateSource = readFileSync(join(ROOT, 'src/fabric/validate.ts'), 'utf8')
check('the validator names the old kind exactly once: its row', (validateSource.match(/teammate_mailbox/g) ?? []).length === 1, String((validateSource.match(/teammate_mailbox/g) ?? []).length))
const writerSource = readFileSync(join(ROOT, 'src/utils/attachments/crewmates.ts'), 'utf8')
check('the one writer of the row writes the crew kind (RED on the base: the old kind)', /type: 'crew_messages'/.test(writerSource) && !/teammate_mailbox/.test(writerSource))

console.log(failures === 0 ? '\nprove-crew-messages-kind: ALL LAWS HOLD' : `\nprove-crew-messages-kind: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
