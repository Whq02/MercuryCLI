#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const ALLOWLIST: Record<string, Partial<Record<string, string>>> = {
}

const CLASSES: Array<{ id: string; re: RegExp; label: string }> = [
  { id: 'C1', re: /\[object Object\]/, label: '[object Object] rendered' },
  { id: 'C2', re: /do not fake/, label: 'builder-doctrine hand-off phrase' },
  { id: 'C3', re: /a bare stamp/, label: 'upstream-lineage vocabulary in chrome' },
  { id: 'C4', re: /\{\{[A-Z_]{3,}\}\}/, label: 'unresolved placeholder' },
  { id: 'C5', re: /['"`]fixture-/, label: 'fixture identifier in chrome' },
  { id: 'C6', re: /['"`]\/Users\//, label: 'absolute machine path in chrome' },
]

function scannableLines(src: string): string[] {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  return noBlocks.split('\n').map(line => {
    const slash = line.indexOf('//')
    return slash === -1 ? line : line.slice(0, slash)
  })
}

async function listFiles(dir: string): Promise<string[]> {
  const { readdirSync, statSync } = await import('node:fs')
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (/\.(tsx|ts)$/.test(e) && !e.endsWith('.d.ts')) out.push(p)
    }
  }
  walk(dir)
  return out
}

console.log('── product-chrome exposure ratchet (src/components + src/screens) ──')
const files = [...(await listFiles(join(ROOT, 'src', 'components'))), ...(await listFiles(join(ROOT, 'src', 'screens')))]
console.log(`  scanning ${files.length} chrome sources`)

const hits: string[] = []
for (const f of files) {
  const rel = relative(ROOT, f)
  const lines = scannableLines(readFileSync(f, 'utf8'))
  lines.forEach((line, i) => {
    for (const cls of CLASSES) {
      if (cls.re.test(line) && !ALLOWLIST[rel]?.[cls.id]) {
        hits.push(`${rel}:${i + 1} [${cls.id} ${cls.label}] ${line.trim().slice(0, 100)}`)
      }
    }
  })
}
check('zero exposure-class hits in product chrome', hits.length === 0, `\n    ${hits.slice(0, 12).join('\n    ')}`)

console.log('\n── preservation fixtures stay wired (content is never rewritten) ──')
const machineProver = readFileSync(join(ROOT, 'scripts', 'terminal-boundary', 'prove-machine-output-contract.ts'), 'utf8')
check(
  'the byte-exact model-content preservation leg exists (L3)',
  machineProver.includes('preservation') && machineProver.includes('[object Object]') && machineProver.includes('byte-exact'),
)
const crashProver = readFileSync(join(ROOT, 'scripts', 'terminal-boundary', 'prove-crash-surface.ts'), 'utf8')
check('the crash prover asserts product projection, not content filtering', crashProver.includes('raw fault text never paints'))

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ product-chrome ratchet: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ product-chrome ratchet green')
