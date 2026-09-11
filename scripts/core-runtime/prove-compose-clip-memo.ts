#!/usr/bin/env bun
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
process.chdir(ROOT)

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const ComposeBuffer = (await import(join(ROOT, 'src/ink/compose-buffer.ts'))).default
const { createScreen, cellAt } = await import(join(ROOT, 'src/ink/cell-grid.ts'))
const { makeContext } = await import(join(ROOT, 'scripts/ink-runtime/frameHarness.ts'))

type Clip = { x1: number | undefined; x2: number | undefined; y1: number | undefined; y2: number | undefined }
const ctx = makeContext()
const W = 48
const H = 2
const LINE = '\x1b[31mred abcdefghijklmnop\x1b[39m 日本語 tail \x1b[1mbold\x1b[22m end'

function signature(screen: { width: number }, y: number): string {
  const out: string[] = []
  for (let x = 0; x < screen.width; x++) {
    const cell = cellAt(screen as never, x, y)
    out.push(cell ? `${cell.char}#${cell.styleId}#${cell.width}` : '·')
  }
  return out.join(' ')
}

function composeWith(buffer: InstanceType<typeof ComposeBuffer>, clip: Clip, x: number): string {
  const screen = createScreen(W, H, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  buffer.reset(W, H, screen)
  buffer.clip(clip)
  buffer.write(x, 0, LINE)
  buffer.unclip()
  return signature(buffer.get(), 0)
}

function fresh(): InstanceType<typeof ComposeBuffer> {
  const screen = createScreen(W, H, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  return new ComposeBuffer({ width: W, height: H, stylePool: ctx.stylePool, screen })
}

const clipA: Clip = { x1: 4, x2: 20, y1: undefined, y2: undefined }
const clipB: Clip = { x1: 0, x2: 30, y1: undefined, y2: undefined }
const clipEdge: Clip = { x1: 2, x2: 27, y1: undefined, y2: undefined }
const clipWhole: Clip = { x1: 0, x2: W, y1: undefined, y2: undefined }

console.log('─'.repeat(76))
console.log('· the clip slice memo: same clip ⇒ same cells; another clip ⇒ its own cells')
console.log('─'.repeat(76))

const reused = fresh()
const firstA = composeWith(reused, clipA, 0)
check('fixture: the clipped line lands cells', firstA.includes('a#') && !firstA.includes('r#'), firstA)
const oracleB = composeWith(fresh(), clipB, 0)
const reusedB = composeWith(reused, clipB, 0)
check('another clip on the remembered line composes that clip, not the first', reusedB === oracleB, `reused=${reusedB}\n   oracle=${oracleB}`)
const reusedA = composeWith(reused, clipA, 0)
check('the first clip again reproduces the first cells', reusedA === firstA, `again=${reusedA}\n   first=${firstA}`)
const oracleEdge = composeWith(fresh(), clipEdge, 0)
const reusedEdge = composeWith(reused, clipEdge, 0)
check('a wide glyph on the clip edge takes the same retry from the memo as from a fresh buffer', reusedEdge === oracleEdge, `reused=${reusedEdge}\n   oracle=${oracleEdge}`)
check('the edge clip never places a wide head in its last column', !reusedEdge.split(' ')[26]!.startsWith('日') && !reusedEdge.split(' ')[26]!.startsWith('本'), reusedEdge)
const oracleShift = composeWith(fresh(), clipA, 3)
const reusedShift = composeWith(reused, clipA, 3)
check('the same clip with the line moved right is its own slice', reusedShift === oracleShift, `reused=${reusedShift}\n   oracle=${oracleShift}`)
const oracleWhole = composeWith(fresh(), clipWhole, 0)
const reusedWhole = composeWith(reused, clipWhole, 0)
check('a clip wider than the line keeps every cell', reusedWhole === oracleWhole && reusedWhole.includes('r#'), reusedWhole)

if (failures > 0) {
  console.log(`\ncompose clip memo: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\ncompose clip memo: green (${checks} checks)`)
