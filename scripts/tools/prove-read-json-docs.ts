import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.env.PROVE_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const document = readFileSync(join(root, 'docs/DOCUMENTS.md'), 'utf8')
const section = document.split('## JSON and JSONL queries\n')[1]?.split('\n## ')[0] ?? ''
const text = section.replace(/\s+/g, ' ')
const lock = JSON.parse(readFileSync(join(root, 'vendor/json-query.lock.json'), 'utf8'))
let passed = 0, failed = 0
const check = (name: string, ok: boolean) => { ok ? passed++ : failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`) }
check('the engine version agrees with its lock', text.includes(lock.engine.replace('jq-', 'jq ')))
console.log(`${passed}/${passed + failed} checks`)
process.exitCode = failed ? 1 : 0
