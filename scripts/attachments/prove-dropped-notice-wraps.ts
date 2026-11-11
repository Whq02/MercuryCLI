import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Writable } from 'node:stream'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const root = argument('--source-root') ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const frames = argument('--frames')
const { enableConfigs } = await import(`${root}/src/utils/config.ts`)
enableConfigs()
const React = (await import('react')).default
const { render, Box, Text } = await import(`${root}/src/ink.ts`)
const { AppStateProvider } = await import(`${root}/src/state/AppState.tsx`)
const { getDefaultAppState } = await import(`${root}/src/state/AppStateStore.ts`)
const { AttachmentMessage } = await import(`${root}/src/components/messages/AttachmentMessage.tsx`)
const { MessageMetaProvider } = await import(`${root}/src/components/messages/TranscriptNameplate.tsx`)
const h = React.createElement
let checks = 0
let failures = 0
const check = (label: string, pass: boolean, detail: string): void => {
  checks++
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${pass ? '' : `: ${detail}`}`)
}
const strip = (text: string): string => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const compact = (text: string): string => text.replace(/\s+/g, '')
if (frames) mkdirSync(frames, { recursive: true })
for (const [name, displayPath, reason] of [
  ['long', 'packages/mercury/components/transcript/attachments/a-long-project-directory/another-long-directory/mentioned-source-file.bin', 'Reading it failed: This tool cannot read binary files, and .bin looks binary — reach for a tool built for that format instead.'],
  ['short', 'image.png', 'over the 256KB limit for a mentioned file'],
] as const) {
  for (const isTranscriptMode of [false, true]) {
    const attachment = { type: 'dropped_image_file', filename: displayPath, displayPath, reason }
    const stdout = Object.assign(new Writable({ write: (_chunk, _encoding, done) => done() }), { columns: 80, rows: 24, isTTY: false })
    const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
    const body = h(Box, { width: 80, flexDirection: 'column' }, h(AttachmentMessage, { attachment, isTranscriptMode }), h(Text, null, 'FOLLOWING ROW'))
    const instance = await render(h(AppStateProvider, { initialState: getDefaultAppState() }, h(MessageMetaProvider, { message: { type: 'attachment', timestamp: '2026-06-19T12:00:07.000Z', attachment } }, body)), { stdout: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false })
    await new Promise(done => setTimeout(done, 100))
    const frame = strip(instance.lastFrame()).trimEnd()
    const lines = frame.split('\n')
    const label = `${name}, transcript ${isTranscriptMode}`
    const expected = `Dropped ${displayPath} — ${reason}`
    check(`${label}: the path and reason are complete`, compact(frame).includes(compact(expected)), frame)
    check(`${label}: the following row remains below the notice`, lines.at(-1)?.trim() === 'FOLLOWING ROW', frame)
    check(`${label}: every row stays within 80 columns`, lines.every(line => Array.from(line).length <= 80), frame)
    check(`${label}: the notice uses only the rows its words need`, name === 'short' ? lines.length === 2 : lines.length > 2, frame)
    if (frames) writeFileSync(join(frames, `${name}-${isTranscriptMode ? 'transcript' : 'chat'}-80x24.txt`), frame + '\n')
    instance.unmount()
    instance.cleanup()
    stdout.destroy()
    stdin.destroy()
  }
}
console.log(`${checks - failures}/${checks} checks; ${failures} red`)
process.exit(failures === 0 ? 0 : 1)
