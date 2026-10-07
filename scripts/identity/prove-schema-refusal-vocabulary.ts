import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const forbidden = ['InputValidationError']
const files = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)
const hits: string[] = []
for (const file of files) {
  if (file === 'scripts/identity/prove-schema-refusal-vocabulary.ts' || !/^(src|scripts|docs)\//.test(file) || !/\.(ts|tsx|js|mjs|json|md|txt|sh)$/.test(file)) continue
  const text = readFileSync(join(root, file), 'utf8')
  text.split('\n').forEach((line, index) => {
    if (forbidden.some(word => line.includes(word))) hits.push(`${file}:${index + 1}`)
  })
}
console.log(`[${hits.length ? 'FAIL' : 'PASS'}] schema refusals have no retired class spelling${hits.length ? ` — ${hits.join(', ')}` : ''}`)
process.exit(hits.length ? 1 : 0)
