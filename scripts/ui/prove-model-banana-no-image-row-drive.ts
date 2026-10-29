#!/usr/bin/env bun
// gate-watch: src/services/providers/gemini/geminiCatalogue.ts src/components/MercuryModelPicker.tsx src/commands/model/mercuryModel.tsx
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grabScreens, requireDist, runArtifactArena, sendStamp } from '../streaming/artifactArena.ts'

requireDist()

const CAPTURE_DIR = process.env.MERCURY_BANANA_CAPTURE_DIR ?? null
if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true })
function dump(label: string, rows: string[]): void {
  if (!CAPTURE_DIR) return
  writeFileSync(join(CAPTURE_DIR, `${label}.txt`), flat(rows) + '\n')
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const CHAT_ID = 'gemini-fixture-chat'
const CHAT_NAME = 'Fixture Chat Model'
const IMAGE_ROWS = [
  { name: 'models/gemini-2.5-flash-image', displayName: 'Nano Banana', inputTokenLimit: 32768, supportedGenerationMethods: ['generateContent'] },
  { name: 'models/nano-banana-pro-preview', displayName: 'Nano Banana Pro', inputTokenLimit: 131072, supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.1-flash-image', displayName: 'Nano Banana 2', inputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] },
]
const catalogueHits: string[] = []
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    catalogueHits.push(path)
    if (path === '/v1beta/models') {
      return Response.json({ models: [{ name: `models/${CHAT_ID}`, displayName: CHAT_NAME, inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] }, ...IMAGE_ROWS] })
    }
    return Response.json({ error: { message: 'unexpected fixture road' } }, { status: 404 })
  },
})
const ESC = '\x1b'
const flat = (rows: string[]): string => rows.map(r => r.replace(/\s+$/, '')).join('\n')
const rowsWith = (rows: string[], needle: string): string => rows.filter(r => r.includes(needle)).map(r => r.trim().slice(0, 120)).join(' | ') || `(no row carries "${needle}")`

section('§1 /model banana lists no image model: a nonsense word cannot put the chat one ↵ from a model that cannot chat')
const run = await runArtifactArena({
  cols: 120,
  rows: 50,
  turns: () => [{ kind: 'text', text: 'Hello there.' }],
  sends: [
    { awaitText: 'Type a prompt', text: '/model' },
    { awaitText: '❯ /model', text: '\r' },
    { awaitText: 'type to search', afterPrevMs: 2500, text: 'fixture' },
    { awaitText: '1 of', text: ESC },
    { awaitText: 'type to search', awaitAbsent: '1 of', text: ESC },
    { awaitText: 'Type a prompt', awaitAbsent: 'Mercury · model', afterPrevMs: 800, text: '/model banana' },
    { awaitText: '/model banana', text: '\r' },
    { awaitText: 'Mercury · model', afterPrevMs: 2500, text: '\r' },
    { awaitText: '0 of', text: '' },
  ],
  anchor: null,
  extraEnv: { MERCURY_GEMINI_API_BASE: `http://127.0.0.1:${server.port}/v1beta`, GEMINI_API_KEY: 'fixture-gemini-key' },
  seconds: 32,
  keep: true,
})
try {
  const sent = run.sendLog.map(s => Buffer.from(s.b64, 'base64').toString('latin1'))
  check('the drive delivered every send (the picker opened twice; the Gemini catalogue was read)', sent.length === 9 && catalogueHits.includes('/v1beta/models'), `${sent.length} sends: ${JSON.stringify(sent.map(s => s.slice(0, 14)))} · catalogue hits ${JSON.stringify(catalogueHits)} · ${run.driverOut.slice(-300)}`)
  const fixtureSearch = run.sendLog[3]
  const bananaEnter = run.sendLog[7]
  if (fixtureSearch !== undefined && bananaEnter !== undefined) {
    const [chatList, bananaList, final] = grabScreens(run, 120, 50, [sendStamp(run, fixtureSearch) - 200, sendStamp(run, bananaEnter) - 200, -1])
    dump('fixture-search', chatList!.rows)
    dump('banana-search', bananaList!.rows)
    dump('final', final!.rows)
    const chatText = flat(chatList!.rows)
    check('the Gemini chat row from the same catalogue is listed and searchable (the list landed; chat models stay)', chatText.includes(CHAT_NAME) && chatText.includes(CHAT_ID) && /\b1 of \d+ match\b/.test(chatText), rowsWith(chatList!.rows, 'Fixture'))
    const bananaText = flat(bananaList!.rows)
    check('/model banana opens the picker', bananaText.includes('Mercury · model'), rowsWith(bananaList!.rows, 'Mercury'))
    check('no image model row answers it — no Nano Banana, no -image id, nothing of the kind highlighted', !bananaText.includes('Nano Banana') && !bananaText.includes('flash-image') && !bananaText.includes('nano-banana'), rowsWith(bananaList!.rows, 'Banana'))
    const finalText = flat(final!.rows)
    check('↵ on no matching row keeps the picker open and the session model: no image row or image switch receipt', finalText.includes('Mercury · model') && /\b0 of \d+ match/.test(finalText) && !finalText.includes('Nano Banana') && !/(?:Model now|Set model to)[^\n]*(?:Nano|image)/i.test(finalText) && /\bOpus 5\.5\b/.test(finalText), rowsWith(final!.rows, 'Opus'))
  }
} finally {
  run.cleanup()
  server.stop(true)
}

console.log(`\n${failures === 0 ? '✅ model-banana-no-image-row PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
