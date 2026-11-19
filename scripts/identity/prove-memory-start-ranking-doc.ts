#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const docs = readFileSync(resolve(root, 'docs/MNEME.md'), 'utf8').split('## What rides at the start of a session')[1]?.split('\n## ')[0] ?? ''
const describesCurrent = (text: string) => text.includes('score / √chars') && text.includes('600 × ⌈log2(1 + candidates)⌉') && text.includes('pointer') && text.includes('full text') && !text.includes('score / chars')
let failures = 0
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`) }
check('the memory page describes the implemented startup packing', describesCurrent(docs))
check('required records, current prompt and source-linked continuation precede project-state fallback', docs.includes('required records') && docs.includes('current prompt') && /source-linked\s+continuation/.test(docs) && docs.includes('fallback'))
console.log('refusals')
check('a raw-character density claim is refused', !describesCurrent(docs.replace('score / √chars', 'score / chars')))
check('an uncapped allowance claim is refused', !describesCurrent(docs.replace('600 × ⌈log2(1 + candidates)⌉', 'the entire allowance')))
check('a page omitting the pointer fallback is refused', !describesCurrent(docs.replaceAll('pointer', 'record')))
console.log(`${failures ? 'FAIL' : 'PASS'} memory startup ranking documentation; failures=${failures}`)
process.exit(failures ? 1 : 0)
