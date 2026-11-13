#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mock, setSystemTime } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RANKED_FIXTURE_DESCRIPTION, writeRankedFixture } from './rankedFixture.ts'

const world = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'grep-ranked-bounds-')))
process.on('exit', () => {
  try {
    rmSync(world, { recursive: true, force: true })
  } catch {
  }
})
const HOME = join(world, 'home')
const TEMP = join(HOME, 'tmp')
const project = join(world, 'project')
const large = join(world, 'large')
mkdirSync(TEMP, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_TMPDIR = TEMP
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_GREP_RANKED = '1'
delete process.env.MERCURY_HOME

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

type Call = { args: string[]; target: string; cwd?: string; timeoutMs?: number; at: number }
const calls: Call[] = []
let onStart: ((started: number) => void) | null = null
const ripgrep = { ...(await import('../../src/utils/ripgrep.ts')) }
mock.module('../../src/utils/ripgrep.js', () => ({
  ...ripgrep,
  ripGrepAnswer: async (args: string[], target: string, signal: AbortSignal, options: { cwd?: string; timeoutMs?: number } = {}) => {
    calls.push({ args, target, ...options, at: performance.now() })
    onStart?.(calls.length)
    return ripgrep.ripGrepAnswer(args, target, signal, options)
  },
}))

const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')

writeRankedFixture(project)
type Data = { numFiles: number; filenames: string[]; ranked?: string; incomplete?: string }
const context = (abortController = new AbortController()) => ({ abortController, getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) }) as never
const call = async (input: Record<string, unknown>, cwd: string, abortController = new AbortController()): Promise<Data> =>
  ((await runWithCwdOverride(cwd, () => GrepTool.call({ pattern: RANKED_FIXTURE_DESCRIPTION, output_mode: 'ranked', ...input } as never, context(abortController)))) as { data: Data }).data
const said = (data: Data): string => GrepTool.mapToolResultToToolResultBlockParam(data as never, 'id').content as string
const counts = (pass: Call): boolean => pass.args.includes('-c')
const listing = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : [])
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const liveRipgrep = (): string[] => {
  if (process.platform === 'win32') return []
  let children = ''
  try {
    children = execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' })
  } catch {
    return []
  }
  return children
    .split('\n')
    .filter(Boolean)
    .map(pid => {
      try {
        return execFileSync('ps', ['-o', 'comm=', '-p', pid], { encoding: 'utf8' }).trim()
      } catch {
        return ''
      }
    })
    .filter(command => /(^|\/)rg$/.test(command))
}

console.log('bounded: twelve counting passes and one line pass at most, each inside one clock of twenty seconds')
{
  const twenty = 'retry failed upload queue attempts delay total values legacy budget limit code settings scroll position entry toast button label system'
  calls.length = 0
  const before = listing(TEMP)
  const data = await call({ pattern: twenty }, project)
  const counting = calls.filter(counts)
  const reading = calls.filter(pass => !counts(pass))
  check('twenty words in the pattern: twelve are counted, in twelve passes, then one line pass', counting.length === 12 && reading.length === 1 && calls.indexOf(reading[0]!) === 12, `${counting.length} counting, ${reading.length} line`)
  check('the answer names the twelve words it counted', (said(data).split('\n')[0]!.match(/\(\d[\d,]*(?: files?)?\)/g) ?? []).length === 12, said(data).split('\n')[0])
  check('every pass is given what is left of the same twenty seconds, never more', calls.every(pass => pass.timeoutMs !== undefined && pass.timeoutMs > 0 && pass.timeoutMs <= 20_000) && calls.every((pass, index) => index === 0 || pass.timeoutMs! <= calls[index - 1]!.timeoutMs!), JSON.stringify(calls.map(pass => pass.timeoutMs)))
  check('one ripgrep at a time: a pass starts only when the one before it has ended', calls.every((pass, index) => index === 0 || pass.at >= calls[index - 1]!.at), JSON.stringify(calls.map(pass => Math.round(pass.at))))
  check('nothing is left in the temp folder', JSON.stringify(listing(TEMP)) === JSON.stringify(before), JSON.stringify(listing(TEMP)))
}

console.log('the clock: when the twenty seconds are spent the counting ends, nothing more starts, and the answer says so')
{
  calls.length = 0
  onStart = started => {
    if (started === 2) setSystemTime(new Date(Date.now() + 25_000))
  }
  const data = await call({}, project)
  onStart = null
  setSystemTime()
  const text = said(data)
  check('two passes had started when the time ran out; no third, and no line pass', calls.length === 2 && calls.every(counts), `${calls.length} passes`)
  check(
    'the answer is cut in Grep\'s own form, with the reason',
    data.incomplete === 'the search timed out after 20 seconds — the walk did not finish, so this ranking is PARTIAL; narrow the path or the glob' && text.endsWith('\n(INCOMPLETE SEARCH — the search timed out after 20 seconds — the walk did not finish, so this ranking is PARTIAL; narrow the path or the glob)'),
    text,
  )
  check('what was counted before the cut is said, and no file is named without having been read', /^Ranked by words, not by meaning: 0 of \d+ files holding retry \(\d+ files\), fail \(\d+\), among \d+ searched\.$/.test(text.split('\n')[0]!) && data.numFiles === 0, text.split('\n')[0])
}

console.log('the largest tree: fifty thousand small files, answered or cut inside the ceiling')
{
  const made = performance.now()
  for (let folder = 0; folder < 200; folder++) {
    const dir = join(large, `pkg${String(folder).padStart(3, '0')}`)
    mkdirSync(dir, { recursive: true })
    for (let file = 0; file < 250; file++) {
      const index = folder * 250 + file
      const body = index % 500 === 7 ? `export function resend${index}() {\n  return retryUpload(${index})\n}\nexport const uploadFailed${index} = 'the upload failed, retry it'\n` : index % 50 === 3 ? `export const retryBudget${index} = ${index}\n` : `export const value${index} = ${index}\n`
      writeFileSync(join(dir, `file${String(file).padStart(3, '0')}.ts`), body)
    }
  }
  console.log(`  (50,000 files written in ${Math.round(performance.now() - made)} ms)`)
  calls.length = 0
  const before = listing(TEMP)
  const started = performance.now()
  const data = await call({}, large)
  const took = performance.now() - started
  const text = said(data)
  console.log(`  (answered in ${Math.round(took)} ms: ${text.split('\n')[0]})`)
  check('the call ends inside the twenty seconds', took < 20_000, `${Math.round(took)} ms`)
  check('it is answered whole or says it is cut: eight files of fifty thousand searched, or Grep\'s INCOMPLETE line', (data.incomplete === undefined && data.numFiles === 8 && /among 50,000 searched\.$/.test(text.split('\n')[0]!)) || text.includes('\n(INCOMPLETE SEARCH — '), text.split('\n')[0])
  check('three counting passes and one line pass over twenty-four files at most', calls.filter(counts).length === 3 && calls.filter(pass => !counts(pass)).length <= 1 && calls.filter(pass => !counts(pass)).every(pass => pass.args.slice(pass.args.indexOf('--') + 1).length + 1 <= 24), `${calls.length} passes`)
  check('nothing is left in the temp folder', JSON.stringify(listing(TEMP)) === JSON.stringify(before), JSON.stringify(listing(TEMP)))

  console.log('stoppable: an abort in the middle of a pass ends its ripgrep and starts no other')
  calls.length = 0
  const abortController = new AbortController()
  let aborted = 0
  onStart = startedPasses => {
    if (startedPasses === 1) setTimeout(() => ((aborted = performance.now()), abortController.abort()), 60)
  }
  let thrown: unknown = null
  const began = performance.now()
  try {
    await call({}, large, abortController)
  } catch (error) {
    thrown = error
  }
  const ended = performance.now()
  onStart = null
  await pause(150)
  check('the call ends in an abort, not in an answer', thrown !== null && (thrown as { name?: string }).name === 'AbortError', String(thrown))
  check('it ends within half a second of the abort', aborted > 0 && ended - aborted < 500, `${Math.round(ended - aborted)} ms after the abort, ${Math.round(ended - began)} ms in all`)
  check('no pass started after the abort', calls.length === 1 || calls.every(pass => pass.at <= aborted), JSON.stringify(calls.map(pass => Math.round(pass.at - began))))
  check('no ripgrep of this process is alive', process.platform === 'win32' || (liveRipgrep().length === 0 && ripgrep.endLiveRipgrepChildren() === 0), liveRipgrep().join(' '))
  check('nothing is left in the temp folder', JSON.stringify(listing(TEMP)) === JSON.stringify(before), JSON.stringify(listing(TEMP)))
  const already = new AbortController()
  already.abort()
  calls.length = 0
  let refused: unknown = null
  try {
    await call({}, large, already)
  } catch (error) {
    refused = error
  }
  check('a call whose signal is already aborted starts no ripgrep at all', refused !== null && calls.length === 0, `${calls.length} passes`)
}

rmSync(world, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-grep-ranked-bounds: ${failures} of ${checks} FAILED`)
  process.exit(1)
}
console.log(`\nprove-grep-ranked-bounds: all ${checks} green`)
