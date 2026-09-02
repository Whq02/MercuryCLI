#!/usr/bin/env bun
// ============================================================================
//  scripts/aseprite/prove-aseprite-real-engine.ts — the Aseprite batch door
//  proved against the REAL resolved binary, end to end through the tool
//  surface, in a scratch tree:
//
//    create      a 12x12 rgb sprite is born; bytes land; info reads it back
//    run-script  grows it to 3 frames + a 'walk' tag through the app's own
//                Lua; info sees frames=3 and the tag 0-based
//    export      --save-as with scale 2 ⇒ a real PNG whose IHDR width IS 24
//                (the scale verified from the file's own header, not the log)
//    gif         a 3-frame GIF with a real GIF signature
//    sheet       sheetType horizontal + json-array metadata ⇒ IHDR width 36
//                (3 frames side by side) and 3 frame records in the JSON
//    frameRange  '0,1' ⇒ 2 frame records (the 0-based claim, proved)
//    status      names the version and the winning rung
//
//  No Aseprite on the box → named SKIP with the machine-readable marker
//  (the resolution law itself is pinned hermetically by this suite's other
//  provers). DELIBERATE DIVERGENCE from the browser suite's hosted-gate red
//  arm: a shard cannot provision Aseprite (there is no consented download
//  road — the app is paid/store-distributed), so an absent binary is an
//  honest skip EVERYWHERE, and the law's teeth stay in the hermetic
//  provers. On the operator's box, MERCURY_ASEPRITE_BIN pins source builds.
//
//  Run:  ~/.bun/bin/bun run scripts/aseprite/prove-aseprite-real-engine.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

// ── §0 resolve; absent = named SKIP everywhere (header reasoning) ───────────
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
      /* absent — the check names it */
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
      /* the check names it */
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
      /* the check names it */
    }
    check("frameRange '0,1' exports exactly 2 frames", frames === 2, String(frames))
  }

  section('§7 · status names the truth')
  {
    const s = await run({ op: 'status' } as ToolInput)
    check('status: version + rung + sprite census', s.includes('Aseprite') && s.includes('rung') && s.includes('sprite file'), s)
  }
})

rmSync(scratch, { recursive: true, force: true })

console.log('\n============================================================')
if (failures > 0) {
  console.log(`❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ ALL CHECKS PASS (real engine)')
