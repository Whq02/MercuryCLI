#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { charWidth, displayWidth, truncateToWidth } from '../../src/utils/glyphs.ts'
import { stringWidth } from '../../src/ink/stringWidth.ts'
import { truncateToWidth as rigorousTruncateToWidth } from '../../src/utils/truncate.ts'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')

const SANCTIONED = new Set<string>([
  'src/ink/stringWidth.ts',
  'src/utils/truncate.ts',
  'src/components/mercury-ui/glyphs.ts',
  'src/native-ts/color-diff/index.ts',
])

const DEF = /(?:function\s+(charWidth|displayWidth|truncateToWidth|visualWidth|cellWidth|stringWidth|textWidth|strWidth)\s*\(|const\s+(charWidth|displayWidth|truncateToWidth|visualWidth|cellWidth|stringWidth|textWidth|strWidth)\s*=\s*(?:\(|function))/

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const s = statSync(p)
    if (s.isDirectory()) {
      if (e === 'node_modules' || e === '__snapshots__') continue
      walk(p, out)
    } else if (p.endsWith('.ts') || p.endsWith('.tsx')) {
      out.push(p)
    }
  }
}

function isComment(line: string): boolean {
  const t = line.trimStart()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' width-oracle SOT — no second width primitive')
console.log('============================================================')

const files: string[] = []
walk(SRC, files)

const offenders: string[] = []
for (const abs of files) {
  const rel = relative(ROOT, abs).split('\\').join('/')
  if (SANCTIONED.has(rel)) continue
  const lines = readFileSync(abs, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (isComment(line)) continue
    if (DEF.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`)
  }
}

check(
  'no width-primitive definition outside the sanctioned set',
  offenders.length === 0,
  offenders.length ? `offenders:\n      - ${offenders.join('\n      - ')}` : 'clean',
)

const widthSamples = ['', 'a', 'hello', '漢', '日本語テスト', 'e\u0301', '\u200b', '🚀', '👩‍💻', '⚠️', '\x1b[31mred\x1b[0m', '\x1b[1;32m✓ ok\x1b[0m']
const widthDrift = widthSamples.filter(s => charWidth(s) !== stringWidth(s) || displayWidth(s) !== stringWidth(s))
check(
  'glyphs.ts charWidth/displayWidth agree with stringWidth',
  widthDrift.length === 0,
  widthDrift.map(s => JSON.stringify(s)).join(', '),
)
const truncDrift: string[] = []
for (const s of widthSamples) {
  if (truncateToWidth(s, 0) !== '' || truncateToWidth(s, -1) !== '') truncDrift.push(`${JSON.stringify(s)}@<=0`)
  for (const max of [1, 2, 3, 5, 8, 20]) {
    if (truncateToWidth(s, max) !== rigorousTruncateToWidth(s, max)) truncDrift.push(`${JSON.stringify(s)}@${max}`)
  }
}
check(
  'glyphs.ts truncateToWidth agrees with the rigorous truncator',
  truncDrift.length === 0,
  truncDrift.join(', '),
)

console.log(failures === 0 ? '\nALL WIDTH-SOT PROOFS PASS' : `\n${failures} PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
