#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'
import { pinSourceRef } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const home = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR ?? tmpdir(), 'grep-capped-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const React = (await import('react')).default
const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { renderToAnsiString } = await import('../../src/utils/staticRender.tsx')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')

const fixture = realpathSync(mkdirSync(join(home, 'many'), { recursive: true }) ?? join(home, 'many'))
for (let i = 0; i < 400; i++) writeFileSync(join(fixture, `note-${String(i).padStart(3, '0')}.txt`), `the needle of file ${i}\n`)
const few = realpathSync(mkdirSync(join(home, 'few'), { recursive: true }) ?? join(home, 'few'))
for (let i = 0; i < 3; i++) writeFileSync(join(few, `note-${i}.txt`), `the needle of file ${i}\n`)

const context = { abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) } as never
type Data = { numFiles: number; numMatches?: number; appliedLimit?: number; appliedOffset?: number }
async function search(path: string, input: Record<string, unknown>): Promise<{ data: Data; text: string; row: string }> {
  const result = (await GrepTool.call({ pattern: 'needle', path, ...input } as never, context)) as { data: Data }
  const block = GrepTool.mapToolResultToToolResultBlockParam(result.data as never, 'tu-1') as { content: unknown }
  const node = React.createElement(AppStateProvider as never, {}, GrepTool.renderToolResultMessage(result.data as never, [] as never, { verbose: false } as never) as never)
  const row = stripAnsi(await renderToAnsiString(node as never, 120)).split('\n').map(line => line.trim()).filter(line => line !== '').join(' | ')
  return { data: result.data, text: String(block.content), row }
}
const lastLine = (text: string): string => text.split('\n').filter(line => /match|file/.test(line) && !/note-\d/.test(line)).at(-1) ?? text.split('\n')[0] ?? ''

console.log('a Grep cut at its limit says it is a page, to the model and in the row')
{
  const counted = await search(fixture, { output_mode: 'count' })
  const line = lastLine(counted.text)
  check('400 files hold the word and the count is cut at the limit', counted.data.appliedLimit !== undefined && counted.data.numFiles === counted.data.appliedLimit && counted.data.numFiles < 400, JSON.stringify(counted.data).slice(0, 200))
  check("the model's line names the page before the numbers and says more exist", line.startsWith('First page: ') && line.includes('; more exist') && line.includes('use offset to paginate'), line)
  check('the row says so too', /Found \d+ matches across \d+ files · first page, more exist/.test(counted.row), counted.row)
  const files = await search(fixture, { output_mode: 'files_with_matches' })
  const head = files.text.split('\n')[0] ?? ''
  check('a list of files cut at the limit: the same, in the line and in the row', head.startsWith('First page: ') && head.includes('; more exist') && !head.startsWith('Found ') && /Found \d+ files · first page, more exist/.test(files.row), `${head} · ${files.row}`)
  const second = await search(fixture, { output_mode: 'count', offset: 50, head_limit: 100 })
  check('a later page cut at its limit is called a page, not the first', lastLine(second.text).startsWith('This page: ') && second.row.includes('· one page, more exist'), `${lastLine(second.text)} · ${second.row}`)
}

console.log('\na Grep that is not cut reads as before')
{
  const counted = await search(few, { output_mode: 'count' })
  check("the model's line is the total, no page word", lastLine(counted.text) === '3 matches across 3 files', lastLine(counted.text))
  check('the row is the total, no trailer', /Found 3 matches across 3 files/.test(counted.row) && !counted.row.includes('page'), counted.row)
  const files = await search(few, { output_mode: 'files_with_matches' })
  check('a list of files: "Found 3 files"', files.text.startsWith('Found 3 files\n') && !files.row.includes('page'), `${files.text.split('\n')[0]} · ${files.row}`)
  const rest = await search(fixture, { output_mode: 'count', offset: 390 })
  check('the last page, read whole behind an offset, states its numbers with the offset note and no "more exist"', !lastLine(rest.text).includes('more exist') && lastLine(rest.text).includes('offset 390') && !rest.row.includes('more exist'), `${lastLine(rest.text)} · ${rest.row}`)
}

console.log(`\nprove-grep-capped-says-page: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
