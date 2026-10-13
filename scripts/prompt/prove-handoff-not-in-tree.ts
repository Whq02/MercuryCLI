import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const source = readFileSync(join(import.meta.dir, '../../src/constants/prompts.ts'), 'utf8')
const section = source.slice(source.indexOf('function projectEstateSection('), source.indexOf('const BATCHING_INSTRUCTION'))
const line = section.split('\n').find(row => row.includes('handoff')) ?? ''
const ok = line.includes('Mercury keeps the handoff note') && line.includes('never write your own handoff file into the project') && !line.includes('handoff notes, plans')
console.log(`${ok ? 'PASS' : 'FAIL'} the project estate names the product-owned handoff, not a file the model should create`)
process.exit(ok ? 0 : 1)
