import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { CODE_TOOL_SPELLINGS } from './forbidden-code-tool.js'

const root = resolve(import.meta.dir, '../..')
const forbidden = CODE_TOOL_SPELLINGS.map(word => word.toLowerCase())
const hits: string[] = []
const walked: string[] = []
const files: string[] = []
function walk(path: string): void {
  const rel = relative(root, path)
  if (rel === 'src/commands/update-notes/changelogArchive.ts' || rel === 'scripts/identity/forbidden-code-tool.ts') return
  if (rel) walked.push(rel)
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) walk(join(path, entry.name))
    }
  } else if (/\.(tsx?|[cm]?js|json|md|txt|sh|ya?ml|tsv|csv)$/.test(path)) files.push(rel)
}
for (const path of process.argv.slice(2).length ? process.argv.slice(2) : ['src', 'scripts', 'docs', 'design-system']) walk(resolve(root, path))
const asked = spawnSync('git', ['-C', root, 'check-ignore', '-z', '--stdin'], { input: walked.join('\0'), encoding: 'utf8', maxBuffer: 1 << 28 })
const ignored = new Set(asked.status === 0 ? asked.stdout.split('\0') : [])
const underIgnored = (rel: string): boolean => rel.split(sep).some((_, at, parts) => ignored.has(parts.slice(0, at + 1).join(sep)))
for (const rel of files) {
  if (underIgnored(rel)) continue
  const text = readFileSync(join(root, rel), 'utf8').toLowerCase()
  if (forbidden.some(word => text.includes(word) || rel.toLowerCase().includes(word))) hits.push(rel)
}
console.log(`  [${hits.length ? 'FAIL' : 'PASS'}] one code-runtime vocabulary${hits.length ? ` — ${hits.join(', ')} · each listed file contains a spelling from CODE_TOOL_SPELLINGS in scripts/identity/forbidden-code-tool.ts; reword it there` : ''}`)
console.log(hits.length ? 'code runtime identity: FAILED' : 'code runtime identity: ALL PASS')
process.exit(hits.length ? 1 : 0)
