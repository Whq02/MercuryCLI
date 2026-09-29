#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
delete process.env.NODE_ENV
for (const ambient of ['ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_HOME', 'MERCURY_IMAGE_PROCESSOR']) delete process.env[ambient]
const HOME = (process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'sized-copy-follows-limits-home-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const note = (label: string): void => console.log(`  [NOTE] ${label}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the sized-copy prover exceeded 180s')
  process.exit(1)
}, 180_000)
watchdog.unref?.()

const sharp = (await import('sharp')).default
const { fitImagesToRequestCap, imageLimitsForModel, requestImageSidePx } = await import('../../src/utils/imageResizer.ts')

const DIRECT = 'claude-opus-5-5'
const RELAYED = 'glm-5'
const WIDTH = 8001
const HEIGHT = 240
const MiB = 1024 * 1024
const kb = (n: number): string => `${(n / MiB).toFixed(2)} MiB`

type Row = { type: string; uuid: string; message: { role: string; content: unknown[] } }
type Copy = { data: string; width: number; height: number } | null

function noise(width: number, height: number, seed: number): Buffer {
  const out = Buffer.alloc(width * height * 3)
  let s = seed >>> 0
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    out[i] = s >>> 24
  }
  return out
}
function pngDims(data: string): { width: number; height: number } | null {
  const header = Buffer.from(data.slice(0, 64), 'base64')
  if (header.length < 24 || header[0] !== 0x89 || header[1] !== 0x50) return null
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
}
function rows(image: Buffer): Row[] {
  return [
    { type: 'user', uuid: 'row-1', message: { role: 'user', content: [{ type: 'text', text: 'one wide capture' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } }] } },
    { type: 'assistant', uuid: 'row-2', message: { role: 'assistant', content: [{ type: 'text', text: 'noted' }] } },
    { type: 'user', uuid: 'row-3', message: { role: 'user', content: 'and now?' } },
  ]
}
function copyOf(fitted: Row[]): Copy {
  const content = fitted[0]?.message.content ?? []
  const block = content.find(b => (b as { type?: string }).type === 'image') as { source?: { data?: string } } | undefined
  const data = block?.source?.data
  if (typeof data !== 'string') return null
  const dims = pngDims(data)
  return { data, width: dims?.width ?? 0, height: dims?.height ?? 0 }
}

const direct = imageLimitsForModel(DIRECT)
const relayed = imageLimitsForModel(RELAYED)
const directCeiling = direct.maxBase64Bytes ?? direct.maxRequestBytes
const relayedCeiling = relayed.maxBase64Bytes ?? relayed.maxRequestBytes
const sidePx = requestImageSidePx(direct, 1)

section('§1 the two families a session can move between share the per-side cap and differ in the byte ceiling')
{
  check(`${DIRECT} sizes to the anthropic table`, direct.family === 'anthropic', direct.family)
  check(`${RELAYED} sizes to the generic table (a route without documented figures of its own)`, relayed.family === 'generic', relayed.family)
  check(`both tables cap a single image at the same side (${String(sidePx)} px)`, sidePx !== null && requestImageSidePx(relayed, 1) === sidePx, `${String(sidePx)} vs ${String(requestImageSidePx(relayed, 1))}`)
  check(`the generic ceiling is stricter than the anthropic one (${kb(relayedCeiling)} vs ${kb(directCeiling)} as base64)`, relayedCeiling < directCeiling)
}

const source = await sharp(noise(WIDTH, HEIGHT, 7), { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).png({ compressionLevel: 6 }).toBuffer()
note(`fixture: ${WIDTH}x${HEIGHT} incompressible PNG, ${kb(source.length)} raw`)
const history = rows(source)

section('§2 sized for the direct model first: the copy fits its own ceiling and is over the generic one (the fixture is decisive)')
const first = await fitImagesToRequestCap(history, { model: DIRECT })
const firstCopy = copyOf(first.messages)
{
  check('one image was sized', first.sized === 1 && firstCopy !== null, `sized=${first.sized} firstEdited=${first.firstEdited}`)
  check(`the copy is within ${String(sidePx)} px a side`, firstCopy !== null && Math.max(firstCopy.width, firstCopy.height) <= (sidePx ?? 0), firstCopy ? `${firstCopy.width}x${firstCopy.height}` : 'no copy')
  check(`the copy fits the anthropic ceiling (${firstCopy ? kb(firstCopy.data.length) : '-'} of ${kb(directCeiling)})`, firstCopy !== null && firstCopy.data.length <= directCeiling)
  check(`the copy is over the generic ceiling (${firstCopy ? kb(firstCopy.data.length) : '-'} of ${kb(relayedCeiling)}), so the two families cannot share it`, firstCopy !== null && firstCopy.data.length > relayedCeiling)
}

section('§3 the same rows sent through the generic-route model: the copy on the wire fits THAT family\'s ceiling')
const second = await fitImagesToRequestCap(history, { model: RELAYED })
const secondCopy = copyOf(second.messages)
{
  check('one image was sized', second.sized === 1 && secondCopy !== null, `sized=${second.sized} firstEdited=${second.firstEdited}`)
  check(`the copy is within ${String(sidePx)} px a side (sized, never left as it was)`, secondCopy !== null && Math.max(secondCopy.width, secondCopy.height) <= (sidePx ?? 0), secondCopy ? `${secondCopy.width}x${secondCopy.height}` : 'no copy')
  check(
    `the copy fits the generic ceiling (${secondCopy ? kb(secondCopy.data.length) : '-'} of ${kb(relayedCeiling)}) — a copy sized for another family\'s ceiling is never served here`,
    secondCopy !== null && secondCopy.data.length <= relayedCeiling,
    secondCopy !== null && firstCopy !== null && secondCopy.data === firstCopy.data ? 'the wire carries the copy sized for the anthropic ceiling, byte for byte' : '',
  )
}

section('§4 the remembered copies still serve: each family gets its own copy back, byte for byte, on the next send')
{
  const again = await fitImagesToRequestCap(history, { model: DIRECT })
  const againCopy = copyOf(again.messages)
  check('the direct model gets the copy sized for it back', againCopy !== null && firstCopy !== null && againCopy.data === firstCopy.data, againCopy && firstCopy ? `${kb(againCopy.data.length)} vs ${kb(firstCopy.data.length)}` : 'no copy')
  const relayedAgain = await fitImagesToRequestCap(history, { model: RELAYED })
  const relayedAgainCopy = copyOf(relayedAgain.messages)
  check('the generic-route model gets the copy sized for it back', relayedAgainCopy !== null && secondCopy !== null && relayedAgainCopy.data === secondCopy.data, relayedAgainCopy && secondCopy ? `${kb(relayedAgainCopy.data.length)} vs ${kb(secondCopy.data.length)}` : 'no copy')
  check('the history rows still hold the original bytes (the wire carries copies)', history[0]?.message.content.some(b => (b as { source?: { data?: string } }).source?.data === source.toString('base64')) === true)
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\nprove-sized-copy-follows-limits: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
