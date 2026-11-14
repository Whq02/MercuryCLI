import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.env.PROVE_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const document = readFileSync(join(root, 'docs/DOCUMENTS.md'), 'utf8')
const section = document.split('## JSON and JSONL queries\n')[1]?.split('\n## ')[0] ?? ''
const text = section.replace(/\s+/g, ' ')
const lock = JSON.parse(readFileSync(join(root, 'vendor/json-query.lock.json'), 'utf8'))
const source = readFileSync(join(root, 'src/tools/FileReadTool/readJson.ts'), 'utf8')
let passed = 0, failed = 0
const check = (name: string, ok: boolean) => { ok ? passed++ : failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`) }
check('the document explains JSON queries on Read', section.length > 0)
check('the example keeps all modifiers before the verbatim filter', text.includes('<path>#read?limit=20&compact=1&q=select(.status == "failed") | {id, message}'))
check('the terminal filter is not described as URL-decoded', text.includes('Put `q` (or `query`) last') && text.includes('without URL or form decoding'))
check('value paging is distinguished from generated-line paging', text.includes('zero-based value offset') && text.includes('select generated output lines'))
check('the default count agrees with the implementation', /default 100/.test(text) && source.includes("pageNumber(params.limit, 100, 1, 'limit')"))
check('the engine version agrees with its lock', text.includes(lock.engine.replace('jq-', 'jq ')))
check('the no-install engine and numeric rule are stated', text.includes('needs no installed jq') && text.includes('preserves numeric literals') && text.includes('floating-point'))
check('JSONL source lines and the builtin line query are documented', text.includes('bracket of source lines') && text.includes('`input_line_number`'))
check('the remote first-page transfer cost is explicit', text.includes("another machine's file brings the file over first and evaluates it locally"))
check('literal names and existing resource queries retain their meaning', text.includes('Existing local literal filenames win') && text.includes('Existing resource queries stay before the suffix'))
check('generated output is not source edit evidence', text.includes('no edit anchor or source read coverage'))
check('paging identity and oversized generated values are described honestly', text.includes('Each page reopens the source') && text.includes('a continuation checks its file identity') && text.includes('retained whole in the generated result page'))
console.log(`${passed}/${passed + failed} checks`)
process.exitCode = failed ? 1 : 0
