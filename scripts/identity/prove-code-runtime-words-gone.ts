import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { CODE_TOOL_SPELLINGS } from './forbidden-code-tool.js'

const root = resolve(import.meta.dir, '../..')
const forbidden = CODE_TOOL_SPELLINGS.map(word => word.toLowerCase())
const hits: string[] = []
function walk(path: string): void {
  const rel = relative(root, path)
  if (rel === 'src/constants/changelog.ts' || rel === 'scripts/identity/forbidden-code-tool.ts') return
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) walk(join(path, entry.name))
    }
  } else if (/\.(tsx?|[cm]?js|json|md|txt|sh|ya?ml|tsv|csv)$/.test(path)) {
    const text = readFileSync(path, 'utf8').toLowerCase()
    if (forbidden.some(word => text.includes(word) || !rel.startsWith('scripts/eval/prove-') && rel.toLowerCase().includes(word))) hits.push(rel)
  }
}
for (const path of process.argv.slice(2).length ? process.argv.slice(2) : ['src', 'scripts', 'docs', 'design-system']) walk(resolve(root, path))
console.log(`  [${hits.length ? 'FAIL' : 'PASS'}] one code-runtime vocabulary${hits.length ? ` — ${hits.join(', ')}` : ''}`)
console.log(hits.length ? 'code runtime identity: FAILED' : 'code runtime identity: ALL PASS')
process.exit(hits.length ? 1 : 0)
