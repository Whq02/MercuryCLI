#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getCellLayoutCounters } from '../../src/screen/renderer/layout/cellLayout.js'
import { createLayoutNode } from '../../src/screen/renderer/layout/engine.js'
import { recordCorpus, replayScreens, type Engine, type Recorded } from './layoutRecordingScenes.js'

const SELF = 'scripts/ink-runtime/prove-layout-recording.ts'
const RECORDING = join(import.meta.dirname, 'recordings', 'layout-node.txt')
const SCREENS = join(import.meta.dirname, 'recordings', 'layout-node-scenes.jsonl')
const UNIT = 'CellLayoutNode'

let failures = 0
function fail(words: string): void {
  failures++
  console.log(`  [FAIL] ${words}`)
}

const opened = process.argv.indexOf('--open')
const open = opened < 0 ? null : (process.argv[opened + 1] ?? null)
const scratch = mkdtempSync(join(tmpdir(), 'layout-recording-'))
process.env['INK_YOGA_TRACE'] = join(scratch, 'trace.jsonl')
const engine: Engine = { create: createLayoutNode, counters: getCellLayoutCounters, trace: join(scratch, 'trace.jsonl'), open }

function record(): Recorded {
  const out: Recorded = new Map()
  for (const [name, lines] of [...recordCorpus(engine), ...replayScreens(engine, readFileSync(SCREENS, 'utf8'))]) {
    if (out.has(name)) throw new Error(`two scenes are named ${name}`)
    out.set(name, lines)
  }
  return out
}

const written = (recorded: Recorded): string => [...recorded].map(([name, lines]) => `## ${name}\n${lines.join('\n')}\n`).join('\n')

function read(text: string): Recorded {
  const out: Recorded = new Map()
  let lines: string[] | null = null
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      lines = []
      out.set(line.slice(3), lines)
    } else if (lines !== null && line !== '') lines.push(line)
  }
  return out
}

function firstDifference(stood: string[], now: string[]): string | null {
  for (let at = 0; at < Math.max(stood.length, now.length); at++) {
    if (stood[at] === now[at]) continue
    return `line ${at + 1}\n      recorded: ${stood[at] ?? '(no such line)'}\n      now:      ${now[at] ?? '(no such line)'}`
  }
  return null
}

console.log(`prove-layout-recording — the layout node of every box: each node's left, top, width and height, the engine's counters and the questions it asks its text, after every layout`)

const probe = createLayoutNode()
const made = Object.getPrototypeOf(probe)?.constructor?.name
probe.free()
if (made === UNIT) console.log(`  [PASS] the node under the recording is the product's own ${UNIT}, reached through createLayoutNode of src/screen/renderer/layout/engine.ts: nothing is replaced; the trees, the answers of the text and the order of the calls are scripted`)
else fail(`the node under the recording is not the product's own ${UNIT}: createLayoutNode answers a ${String(made)}`)

try {
  const first = record()
  const second = record()
  for (const [name, lines] of first) {
    const twice = firstDifference(lines, second.get(name) ?? [])
    if (twice !== null) fail(`${name}: two recordings in one process differ, so nothing can be compared with it: ${twice}`)
  }
  const live = getCellLayoutCounters().live
  if (live === 0) console.log(`  [PASS] every scene frees what it made: no node is live after ${first.size} scenes recorded twice`)
  else fail(`${live} nodes are live after the scenes freed their trees`)

  if (open !== null) {
    const lines = first.get(open)
    if (lines === undefined) fail(`no scene is named "${open}"`)
    else console.log(`\n## ${open}\n${lines.join('\n')}\n`)
  } else if (process.argv.includes('--write')) {
    if (failures === 0) {
      const stood = existsSync(RECORDING) ? read(readFileSync(RECORDING, 'utf8')) : new Map<string, string[]>()
      for (const [name, lines] of first) {
        const moved = stood.has(name) ? firstDifference(stood.get(name)!, lines) : 'a new scene'
        if (moved !== null) console.log(`  changed ${name}: ${moved}`)
      }
      for (const name of stood.keys()) if (!first.has(name)) console.log(`  dropped ${name}: no scene records it`)
      mkdirSync(dirname(RECORDING), { recursive: true })
      writeFileSync(RECORDING, written(first))
      console.log(`\n${first.size} scenes, ${[...first.values()].reduce((n, lines) => n + lines.length, 0)} lines written to ${RECORDING}`)
    }
  } else if (!existsSync(RECORDING)) fail(`no recording stands at ${RECORDING}: run \`bun run ${SELF} --write\` on a tree whose layout is the one to hold, and commit it`)
  else {
    const stood = read(readFileSync(RECORDING, 'utf8'))
    let equal = 0
    for (const [name, lines] of first) {
      const recorded = stood.get(name)
      if (recorded === undefined) {
        fail(`${name}: the scene has no recording; run \`bun run ${SELF} --write\` and commit the recording with the scene`)
        continue
      }
      const moved = firstDifference(recorded, lines)
      if (moved === null) equal++
      else if (failures < 12) fail(`the recorded layout of ${UNIT} changed in "${name}" at ${moved}\n      a rectangle that moved is a changed frame; a counter that moved is a subtree laid out, measured or reused where it was not before; \`bun run ${SELF} --open "${name}"\` prints the scene in full on any tree\n      if nobody asked for the change, the change is the fault; if it was asked for, run \`bun run ${SELF} --write\`, read the difference it prints, and commit the recording with the change`)
      else failures++
    }
    for (const name of stood.keys()) if (!first.has(name)) fail(`${name}: a recording stands that no scene records; run \`bun run ${SELF} --write\` to drop it`)
    if (failures === 0) console.log(`  [PASS] ${equal} scenes equal the recording, line for line`)
  }
  console.log(`\n${failures === 0 ? '✅' : '❌'} prove-layout-recording — ${first.size} scenes, ${failures === 0 ? (open !== null ? 'one printed' : process.argv.includes('--write') ? 'written' : 'equal to the recording') : `${failures} failed`}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
