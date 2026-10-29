#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const TREES = ['src/components', 'src/screens', 'src/commands']

const EMOJI = /[\u{1F300}-\u{1FAFF}]|\u{FE0F}/u

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
console.log(' no-emoji — pictograph floor over the live TUI trees')
console.log('============================================================')

const offenders: string[] = []
for (const tree of TREES) {
  const files: string[] = []
  walk(join(ROOT, tree), files)
  for (const abs of files) {
    const rel = relative(ROOT, abs).split('\\').join('/')
    const lines = readFileSync(abs, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (isComment(line)) continue
      if (EMOJI.test(line)) offenders.push(`${rel}:${i + 1}`)
    }
  }
}

check(
  'zero true-emoji codepoints in live TUI sources (components/screens/commands)',
  offenders.length === 0,
  offenders.length ? `offenders:\n      - ${offenders.join('\n      - ')}` : 'clean',
)


console.log(failures === 0 ? '\nALL NO-EMOJI PROOFS PASS' : `\n${failures} PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
