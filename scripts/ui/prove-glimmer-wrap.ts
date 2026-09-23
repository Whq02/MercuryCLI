#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReactNode } from 'react'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'glimmer-wrap-home-')))
process.env.NODE_ENV = 'test'
process.env['FORCE_COLOR'] = '0'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const React = (await import('react')).default
const { Box, Text } = await import('../../src/ink.js')
const { renderToString } = await import('../../src/utils/staticRender.tsx')
const { GlimmerMessage } = await import('../../src/components/Spinner/GlimmerMessage.js')
const { stringWidth } = await import('../../src/ink/stringWidth.js')

const WRAP_VERB = 'Reading the complete fixture response and checking every part of it'
const TALL_VERB = `${WRAP_VERB} against the recorded expectations before answering`
const MESSAGE = `${TALL_VERB}…`
const MESSAGE_WIDTH = stringWidth(MESSAGE)
const OFFSCREEN = -10_000
const SEPARATOR = '§'
const WIDTHS = [40, 55, 59, 84]
const PER_RENDER = 3
const COLUMNS = 220

const h = React.createElement
const verb = (width: number, glimmerIndex: number) =>
  h(Box, { width, flexDirection: 'row' }, h(GlimmerMessage, { message: MESSAGE, mode: 'thinking', messageColor: 'brand', shimmerColor: 'brandShimmer', flashOpacity: 0, glimmerIndex }))
const separator = () => h(Box, { width: 4 }, h(Text, null, SEPARATOR))

const blocksOf = (frame: string): string[][] => {
  const blocks: string[][] = []
  let current: string[] | null = null
  for (const raw of frame.split('\n')) {
    const line = raw.trimEnd()
    if (line === SEPARATOR) {
      if (current !== null) blocks.push(current)
      current = []
      continue
    }
    if (current !== null) current.push(line)
  }
  return blocks
}
const lettersOf = (block: string[]): string => block.join(' ').replace(/\s+/g, ' ').trim()

const renderBatch = async (width: number, indices: number[]): Promise<string[][]> => {
  const children: ReactNode[] = []
  for (const index of indices) children.push(separator(), verb(width, index))
  children.push(separator())
  const frame = await renderToString(h(Box, { flexDirection: 'column' }, ...children), COLUMNS)
  return blocksOf(frame)
}

console.log(`prove-glimmer-wrap: a ${MESSAGE_WIDTH}-cell verb under a moving glimmer keeps its letters and its wrap at every glimmer position`)
const started = Date.now()

console.log('\n§1 the offscreen paragraph (the control): every letter survives the wrap at every width')
const offscreenBlocks = new Map<number, string[]>()
for (const width of WIDTHS) {
  const [block] = await renderBatch(width, [OFFSCREEN])
  offscreenBlocks.set(width, block ?? [])
  check(`W=${width}: the offscreen render carries the whole verb in order (${block?.length ?? 0} row(s))`, block !== undefined && lettersOf(block) === MESSAGE, JSON.stringify(block))
  check(`W=${width}: no row is wider than the capsule`, block !== undefined && block.every(row => stringWidth(row) <= width), JSON.stringify(block?.map(row => stringWidth(row))))
}
check('W=59 wraps the verb (the scene is a wrapped verb, never a one-liner)', (offscreenBlocks.get(59)?.length ?? 0) > 1, String(offscreenBlocks.get(59)?.length))

console.log('\n§2 the glimmer inside the verb: every position paints the offscreen paragraph exactly (letters, rows, wrap height)')
for (const width of WIDTHS) {
  const offscreen = offscreenBlocks.get(width) ?? []
  const indices: number[] = []
  for (let index = -3; index <= MESSAGE_WIDTH + 3; index++) indices.push(index)
  const differing: Array<{ index: number; block: string[] }> = []
  let seen = 0
  for (let at = 0; at < indices.length; at += PER_RENDER) {
    const slice = indices.slice(at, at + PER_RENDER)
    const blocks = await renderBatch(width, [OFFSCREEN, ...slice])
    if (blocks.length !== slice.length + 1) {
      differing.push({ index: slice[0]!, block: [`parsed ${blocks.length} block(s) for ${slice.length + 1} scenes`] })
      continue
    }
    const control = blocks[0]!
    if (control.join('\n') !== offscreen.join('\n')) differing.push({ index: OFFSCREEN, block: control })
    slice.forEach((index, i) => {
      seen++
      const block = blocks[i + 1]!
      if (block.join('\n') !== offscreen.join('\n')) differing.push({ index, block })
    })
  }
  const first = differing[0]
  check(
    `W=${width}: all ${seen} glimmer positions from -3 to ${MESSAGE_WIDTH + 3} paint the offscreen paragraph (${offscreen.length} row(s))`,
    seen === indices.length && differing.length === 0,
    differing.length === 0 ? '' : `${differing.length} differ; first at glimmer ${first?.index}: ${JSON.stringify(first?.block)} vs ${JSON.stringify(offscreen)}`,
  )
}

console.log('\n§3 a capsule wider than the verb: one row, with the glimmer inside or outside the verb')
{
  const [offscreen, inside] = await renderBatch(200, [OFFSCREEN, 60])
  check('W=200: the offscreen render is one row carrying the verb', offscreen !== undefined && offscreen.length === 1 && lettersOf(offscreen) === MESSAGE, JSON.stringify(offscreen))
  check('W=200: the glimmer at 60 paints the same one row', inside !== undefined && offscreen !== undefined && inside.join('\n') === offscreen.join('\n'), JSON.stringify(inside))
}

console.log(`\n${checks} checks in ${Date.now() - started} ms`)
console.log(failures === 0 ? 'prove-glimmer-wrap: all green' : `prove-glimmer-wrap: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
