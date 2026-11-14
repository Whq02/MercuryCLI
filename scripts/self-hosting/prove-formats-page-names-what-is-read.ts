#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const repo = join(import.meta.dir, '../..')
const { conventionsForProfile } = await import(join(repo, 'src/services/instructions/compositionOrder.ts'))
const VARIABLE = 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS'

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const page = readFileSync(join(repo, 'docs/COMPATIBILITY.md'), 'utf8')
const HEADING = '### The files other tools left'
const section = page.includes(HEADING) ? page.slice(page.indexOf(HEADING) + HEADING.length).split(/\n#{2,3} /)[0]! : ''
const table = section.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| ---') && !line.startsWith('| Tool '))
const rows = table.filter(row => !row.includes(VARIABLE))
const spansOf = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]!)
const namedIn = (lines: string[]): string[] => lines.flatMap(row => row.split('|').slice(2, 4)).flatMap(cell => spansOf(cell.replace(/\([^)]*\)/g, '')))
const named = namedIn(rows)

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

console.log('the row of the folders a variable names, and the adapter that reads the variable')
process.env[VARIABLE] = ROOT
const byVariable = shared.flatMap((convention: any) => (convention.named?.()?.by === VARIABLE ? convention.named().folders : []))
const namedGuides: string[] = byVariable.flatMap((folder: any) => folder.guides.map(rel))
const namedRules: string[] = byVariable.flatMap((folder: any) => folder.rules.map(rel))
const ofVariable = namedIn(table.filter(row => row.includes(`\`${VARIABLE}\``)))
check('one row names the variable', table.length === rows.length + 1, `${table.length - rows.length} row(s)`)
check('the row names what the adapter reads in such a folder and nothing else', namedGuides.length === 1 && namedRules.length === 1 && namedGuides.every(path => ofVariable.includes(path)) && namedRules.every(path => ofVariable.some(span => starts(span, path))) && ofVariable.every(span => namedGuides.includes(span) || namedRules.some(path => starts(span, path))), `${ofVariable.join(', ')} against ${[...namedGuides, ...namedRules].join(', ')}`)

console.log(`formats-page-names-what-is-read: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
