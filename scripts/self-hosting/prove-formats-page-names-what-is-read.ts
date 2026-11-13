#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const repo = join(import.meta.dir, '../..')
const { conventionsForProfile } = await import(join(repo, 'src/services/instructions/compositionOrder.ts'))

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const page = readFileSync(join(repo, 'docs/COMPATIBILITY.md'), 'utf8')
const HEADING = '### The files other tools left'
const section = page.includes(HEADING) ? page.slice(page.indexOf(HEADING) + HEADING.length).split(/\n#{2,3} /)[0]! : ''
const rows = section.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| ---') && !line.startsWith('| Tool '))
const cells = rows.flatMap(row => row.split('|').slice(2, 4))
const spansOf = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]!)
const named = cells.flatMap(cell => spansOf(cell.replace(/\([^)]*\)/g, '')))

const ROOT = join(repo, 'a-project')
const rel = (path: string): string => relative(ROOT, path).split('\\').join('/')
const shared = conventionsForProfile('auto').filter((convention: any) => convention.fallback)
const guides: string[] = shared.flatMap((convention: any) => [...convention.projectDirFiles(ROOT), ...(convention.localDirFiles?.(ROOT) ?? [])].map(rel))
const sources: string[] = shared.flatMap((convention: any) => convention.projectRulesDirs(ROOT).map(rel))
const starts = (span: string, path: string): boolean => span === path || span.startsWith(`${path}/`)

console.log('the table of docs/COMPATIBILITY.md and the adapters name the same files')
check('the page has the table, one row for each tool', rows.length === 7, `${rows.length} row(s)`)
check('every guide and local file an adapter reads is named in the table', guides.length >= 9 && guides.every(path => named.includes(path)), guides.filter(path => !named.includes(path)).join(', '))
check('every rule file and rules folder an adapter reads is named in the table', sources.length >= 12 && sources.every(path => named.some(span => starts(span, path))), sources.filter(path => !named.some(span => starts(span, path))).join(', '))
check('the table names no file that no adapter reads', named.length > 0 && named.every(span => guides.includes(span) || sources.some(path => starts(span, path))), named.filter(span => !guides.includes(span) && !sources.some(path => starts(span, path))).join(', '))

console.log(`formats-page-names-what-is-read: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
