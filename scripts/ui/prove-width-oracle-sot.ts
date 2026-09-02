#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

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

const glyphs = readFileSync(join(ROOT, 'src/components/mercury-ui/glyphs.ts'), 'utf8')
check(
  'glyphs.ts charWidth/displayWidth delegate to stringWidth',
  /function charWidth[\s\S]{0,80}stringWidth\(/.test(glyphs) &&
    /function displayWidth[\s\S]{0,80}stringWidth\(/.test(glyphs),
)
check(
  'glyphs.ts truncateToWidth delegates to the rigorous truncator',
  /function truncateToWidth[\s\S]{0,160}rigorousTruncateToWidth\(/.test(glyphs),
)

console.log(failures === 0 ? '\nALL WIDTH-SOT PROOFS PASS' : `\n${failures} PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
