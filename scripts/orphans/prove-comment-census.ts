#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { censusFiles, commentRanges, withoutComments } from '../lib/commentCensus.ts'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' the comment census: the product and its proofs carry no comments; directives and vendored code are the only comment text')
console.log('============================================================')

const found: string[] = []
let files = 0
for (const path of censusFiles(ROOT)) {
  files++
  const text = readFileSync(path, 'utf8')
  const ranges = commentRanges(path, text)
  if (ranges.length > 0) found.push(`${path.slice(ROOT.length + 1)}: ${ranges.length} (first at offset ${ranges[0]!.pos}: ${JSON.stringify(text.slice(ranges[0]!.pos, Math.min(ranges[0]!.end, ranges[0]!.pos + 60)))})`)
}
check(`every source file under src and scripts is read (${files})`, files > 5000)
check('zero comments', found.length === 0, `${found.length} file(s):\n    ${found.slice(0, 12).join('\n    ')}`)

const fixture = [
  '// @ts-expect-error kept',
  '/* eslint-disable */',
  '/// <reference types="bun" />',
  'const url = "http://example.com/not/a/comment" // trailing',
  '/** doc block */',
  'export const two = `// inside a template ${url}`',
  '/* block */ export const three = 3 /* tail */',
  '',
].join('\n')
const stripped = withoutComments('fixture.ts', fixture)
check('the scanner keeps compiler and linter directives', stripped.out.includes('// @ts-expect-error kept') && stripped.out.includes('/* eslint-disable */') && stripped.out.includes('/// <reference types="bun" />'))
check('the scanner never touches a comment-shaped string or template', stripped.out.includes('"http://example.com/not/a/comment"') && stripped.out.includes('`// inside a template ${url}`'))
check('the scanner removes line, block and doc comments and counts them', !stripped.out.includes('// trailing') && !stripped.out.includes('doc block') && !stripped.out.includes('/* block */') && !stripped.out.includes('/* tail */') && stripped.removed === 4, JSON.stringify(stripped))
check('a stripped file is still the same program (the scanner removed only trivia)', stripped.out.includes('export const three = 3') && stripped.out.includes('export const two = '))

console.log(failures === 0 ? `\n✅ COMMENT CENSUS — ${checks} checks` : `\n❌ ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
