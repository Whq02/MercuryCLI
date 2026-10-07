#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { FILE_TOOL_SPELLINGS } from './forbidden-file-tool.ts'

const root = resolve(import.meta.dir, '../..')
const forbidden = new Set(FILE_TOOL_SPELLINGS.map(name => name.toLowerCase()))
const hits: string[] = []
function walk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue
    const path = join(dir, entry.name)
    const rel = relative(root, path)
    if (rel === 'scripts/identity/forbidden-file-tool.ts') continue
    const pathHasName = [...forbidden].some(name => rel.toLowerCase().includes(name))
    if (entry.isDirectory()) {
      if (pathHasName) hits.push(rel)
      walk(path)
    } else if (/\.(?:tsx?|[cm]?js|json|md|txt|sh|ya?ml|tsv|csv)$/.test(entry.name)) {
      const text = readFileSync(path, 'utf8').toLowerCase()
      if (pathHasName || [...forbidden].some(name => text.includes(name))) hits.push(rel)
    }
  }
}
for (const dir of ['src', 'scripts', 'docs', 'design-system']) walk(join(root, dir))
console.log(`  [${hits.length === 0 ? 'PASS' : 'FAIL'}] the file courier has no spelling outside the identity forbidden list${hits.length ? ` — ${hits.join(', ')}` : ''}`)
console.log(hits.length === 0 ? 'file tool identity: ALL PASS' : 'file tool identity: FAILED')
process.exit(hits.length === 0 ? 0 : 1)
