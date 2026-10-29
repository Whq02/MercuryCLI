#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { resolveAseprite } = await import('../../src/services/aseprite/asepriteApp.ts')
const { AsepriteTool } = await import('../../src/tools/AsepriteTool/AsepriteTool.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')

const resolution = resolveAseprite()
if (resolution.state !== 'ok') {
  console.log(`__SUITE_SKIPPED aseprite: ${resolution.note}`)
  console.log('  – no Aseprite on this machine — SKIP; the resolution law and the tool grammar are pinned by this suite\'s hermetic provers')
  process.exit(0)
}
console.log(`  driving: ${resolution.location.source} rung — ${resolution.location.path}`)

console.log('============================================================')
console.log(' Aseprite REAL-ENGINE proof (tool surface, end to end)')
console.log('============================================================')

const scratch = mkdtempSync(path.join(tmpdir(), 'ase-real-'))
const tree = path.join(scratch, 'tree')
mkdirSync(tree, { recursive: true })

type ToolInput = Parameters<typeof AsepriteTool.call>[0]
const ctx = {} as Parameters<typeof AsepriteTool.call>[1]
async function run(input: ToolInput): Promise<string> {
  const { data } = await AsepriteTool.call(input, ctx)
  return data.result
}

function pngSize(file: string): { width: number; height: number } | null {
  try {
    const b = readFileSync(file)
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    if (b.length < 24 || !sig.every((v, i) => b[i] === v)) return null
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  } catch {
    return null
  }
}

await runWithCwdOverride(tree, async () => {
  section('§1 · create + info (birth read back)')
  {
    const created = await run({ op: 'create', output: 'hero.aseprite', width: 12, height: 12, colorMode: 'rgb' } as ToolInput)
    check('create verifies landed bytes', /hero\.aseprite \(\d+ bytes\)/.test(created), created)
    const info = await run({ op: 'info', file: 'hero.aseprite' } as ToolInput)
    check('info reads the size back', info.includes('"width": 12') && info.includes('"height": 12'), info)
    check('info reads mode + one frame', info.includes('"colorMode": "rgb"') && info.includes('"frames": 1'), info)
    check('info carries provenance (version + rung)', info.includes('Aseprite') && info.includes('rung'), info)
  }

  section('§2 · run-script grows the sprite (3 frames + a tag)')
  {
    const grown = await run({
      op: 'run-script',
      file: 'hero.aseprite',
      source: [
        'local spr = app.activeSprite',
        'spr:newFrame()',
        'spr:newFrame()',
        "local tag = spr:newTag(1, 3)",
        "tag.name = 'walk'",
        'spr:saveAs(spr.filename)',
        "print('grown to ' .. #spr.frames .. ' frames')",
      ].join('\n'),
    } as ToolInput)
    check('script ran and reported', grown.includes('grown to 3 frames'), grown)
    const info = await run({ op: 'info', file: 'hero.aseprite' } as ToolInput)
    check('info sees 3 frames', info.includes('"frames": 3'), info)
    check('info sees the tag, 0-based', info.includes('"name": "walk"') && info.includes('"from": 0') && info.includes('"to": 2'), info)
  }

  section('§3 · export png, scale 2 (the header is the proof)')
  {
    const r = await run({ op: 'export', file: 'hero.aseprite', output: 'out/hero.png', scale: 2, frameRange: '0,0' } as ToolInput)
    check('export verifies landed bytes', r.includes('bytes'), r)
    const size = pngSize(path.join(tree, 'out', 'hero.png'))
    check('the PNG IHDR says 24x24 — scale 2 really applied', size !== null && size.width === 24 && size.height === 24, JSON.stringify(size))
  }

  section('§4 · export gif (3 frames, real signature)')
  {
    const r = await run({ op: 'export', file: 'hero.aseprite', output: 'out/hero.gif' } as ToolInput)
    check('gif export lands', r.includes('hero.gif') && r.includes('bytes'), r)
    let sig = ''
    try {
      sig = readFileSync(path.join(tree, 'out', 'hero.gif')).subarray(0, 6).toString('latin1')
    } catch {
    }
    check('a real GIF signature', sig === 'GIF89a' || sig === 'GIF87a', sig)
  }

  section('§5 · sprite sheet + json metadata')
  {
    const r = await run({
      op: 'export',
      file: 'hero.aseprite',
      output: 'out/sheet.png',
      sheetType: 'horizontal',
      dataOutput: 'out/sheet.json',
      dataFormat: 'json-array',
    } as ToolInput)
    check('sheet + metadata land', r.includes('sheet.png') && r.includes('sheet.json'), r)
    const size = pngSize(path.join(tree, 'out', 'sheet.png'))
    check('the sheet IHDR says 36x12 — 3 frames side by side', size !== null && size.width === 36 && size.height === 12, JSON.stringify(size))
    let frames = -1
    try {
      const meta = JSON.parse(readFileSync(path.join(tree, 'out', 'sheet.json'), 'utf8')) as { frames?: unknown[] }
      frames = Array.isArray(meta.frames) ? meta.frames.length : -1
    } catch {
    }
    check('the metadata carries 3 frame records', frames === 3, String(frames))
  }

  section('§6 · frameRange is 0-based (proved on the wire)')
  {
    await run({
      op: 'export',
      file: 'hero.aseprite',
      output: 'out/range.png',
      sheetType: 'horizontal',
      dataOutput: 'out/range.json',
      dataFormat: 'json-array',
      frameRange: '0,1',
    } as ToolInput)
    let frames = -1
    try {
      const meta = JSON.parse(readFileSync(path.join(tree, 'out', 'range.json'), 'utf8')) as { frames?: unknown[] }
      frames = Array.isArray(meta.frames) ? meta.frames.length : -1
    } catch {
    }
    check("frameRange '0,1' exports exactly 2 frames", frames === 2, String(frames))
  }

  section('§7 · status names the truth')
  {
    const s = await run({ op: 'status' } as ToolInput)
    check('status: version + rung + sprite census', s.includes('Aseprite') && s.includes('rung') && s.includes('sprite file'), s)
  }

  section('§8 · drawing, render-back and parts')
  const previews: string[] = []
  const art = async (value: unknown) => {
    const input = AsepriteTool.inputSchema.parse(value)
    const { data } = await AsepriteTool.call(input)
    if (data.preview) previews.push(data.preview.path)
    return data
  }
  const structure = async () => JSON.parse((await art({ op: 'describe', file: 'artist.aseprite' })).result.split('\n')[1]!)
  try {
    await run({ op: 'create', output: 'artist.aseprite', width: 16, height: 16 })
    const made = await art({ op: 'parts', file: 'artist.aseprite', ops: [
      { kind: 'create', name: 'Hero', group: true },
      ...['Body', 'Head', 'Arm'].map(name => ({ kind: 'create', name, parent: 'Hero' })),
    ] })
    check('parts create a group and three layers in one batch', made.result.includes('"applied":4'), made.result)
    const dark = { r: 24, g: 32, b: 48, a: 255 }
    const teal = { r: 40, g: 192, b: 160, a: 255 }
    const skin = { r: 248, g: 184, b: 112, a: 255 }
    const ops = [
      { kind: 'rect', layer: 'Hero/Body', x: 5, y: 8, x2: 10, y2: 13, fill: true, colour: dark },
      { kind: 'rect', layer: 'Hero/Body', x: 5, y: 8, x2: 10, y2: 13, colour: teal },
      { kind: 'flood-fill', layer: 'Hero/Body', x: 7, y: 10, colour: teal },
      { kind: 'circle', layer: 'Hero/Head', x: 7, y: 4, radius: 3, fill: true, colour: skin },
      { kind: 'circle', layer: 'Hero/Head', x: 7, y: 4, radius: 3, colour: dark },
      { kind: 'pixel', layer: 'Hero/Head', x: 6, y: 4, colour: dark },
      { kind: 'pixel', layer: 'Hero/Head', x: 8, y: 4, colour: dark },
      { kind: 'line', layer: 'Hero/Head', x: 6, y: 6, x2: 8, y2: 6, colour: dark },
      { kind: 'ellipse', layer: 'Hero/Arm', x: 2, y: 8, x2: 4, y2: 12, fill: true, colour: teal },
      { kind: 'ellipse', layer: 'Hero/Arm', x: 2, y: 8, x2: 4, y2: 12, colour: dark },
    ].map(op => ({ ...op, frame: 0 }))
    const initial = readFileSync(path.join(tree, 'artist.aseprite'))
    const drawn = await art({ op: 'draw', file: 'artist.aseprite', ops, scale: 8 })
    check('every primitive draws and returns a PNG', !!drawn.preview && drawn.result.includes('"applied":10'), drawn.result)
    if (!drawn.preview) throw new Error(drawn.result)
    const pixels = await sharp(Buffer.from(drawn.preview.base64, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const at = (x: number, y: number) => [...pixels.data.subarray((y * pixels.info.width + x) * 4, (y * pixels.info.width + x) * 4 + 4)].join(',')
    check('render is 128x128 nearest-neighbour', pixels.info.width === 128 && pixels.info.height === 128 && at(6*8, 4*8) === '24,32,48,255' && at(6*8+7, 4*8+7) === '24,32,48,255')
    check('render has skin, body and transparent background pixels', at(7*8, 3*8) === '248,184,112,255' && at(7*8, 10*8) === '40,192,160,255' && at(0, 0) === '0,0,0,0')
    const native = readFileSync(path.join(tree, 'artist.aseprite'))
    writeFileSync(path.join(tree, 'artist.aseprite'), initial)
    const repeated = await art({ op: 'draw', file: 'artist.aseprite', ops, scale: 8 })
    check('same input produces identical sprite and PNG bytes', native.equals(readFileSync(path.join(tree, 'artist.aseprite'))) && drawn.preview.base64 === repeated.preview?.base64)
    const invalid = await art({ op: 'draw', file: 'artist.aseprite', ops: [ops[0], { ...ops[0], layer: 'missing' }] })
    check('late batch failure leaves the original sprite unchanged', invalid.result.includes('no layer: missing') && native.equals(readFileSync(path.join(tree, 'artist.aseprite'))), invalid.result)
    const hidden = await art({ op: 'parts', file: 'artist.aseprite', ops: [{ kind: 'hide', part: 'Hero/Head' }, { kind: 'reorder', part: 'Hero/Arm', index: 0 }] })
    check('hide and reorder succeed', hidden.result.includes('"applied":2'), hidden.result)
    let desc = await structure()
    check('describe returns visibility and sibling order', desc.parts.find((p: any) => p.path === 'Hero/Head')?.visible === false && desc.parts.find((p: any) => p.path === 'Hero/Arm')?.index === 0)
    const copied = await art({ op: 'parts', file: 'artist.aseprite', ops: [{ kind: 'show', part: 'Hero/Head' }, { kind: 'duplicate', part: 'Hero', fromFrame: 0, toFrames: [1, 2] }] })
    check('show and group duplication extend to three frames', copied.result.includes('"applied":2'), copied.result)
    desc = await structure()
    check('describe sees independent parts across three frames', desc.frames.length === 3 && desc.parts.find((p: any) => p.path === 'Hero/Head')?.cels.length === 3)
    const a = await art({ op: 'render', file: 'artist.aseprite', frame: 0 })
    const b = await art({ op: 'render', file: 'artist.aseprite', frame: 2 })
    check('duplicated part renders identical pixels across frames', !!a.preview && a.preview.base64 === b.preview?.base64)
    await art({ op: 'draw', file: 'artist.aseprite', ops: [{ kind: 'pixel', layer: 'Hero/Head', frame: 2, x: 0, y: 0, colour: teal }] })
    const source = await art({ op: 'render', file: 'artist.aseprite', frame: 0 })
    check('duplicate cels are not linked', a.preview?.base64 === source.preview?.base64)
    const block = AsepriteTool.mapToolResultToToolResultBlockParam(drawn, 'real-art')
    check('render-back uses the existing image block shape', Array.isArray(block.content) && block.content[1]?.type === 'image')
  } finally {
    for (const preview of previews) rmSync(preview, { force: true })
  }
})

rmSync(scratch, { recursive: true, force: true })

console.log('\n============================================================')
if (failures > 0) {
  console.log(`❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ ALL CHECKS PASS (real engine)')
