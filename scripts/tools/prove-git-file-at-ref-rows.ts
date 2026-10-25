#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'git-file-at-ref-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

const repo = join(scratch, 'repo')
mkdirSync(repo)
const g = (...args: string[]): string => {
  const run = Bun.spawnSync(['git', ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@x', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`)
  return run.stdout.toString()
}
g('init', '-q')
const seventeen = Array.from({ length: 17 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
writeFileSync(join(repo, 'seventeen.txt'), seventeen)
writeFileSync(join(repo, 'no-final-newline.txt'), 'alpha\nomega')
writeFileSync(join(repo, 'empty.txt'), '')
writeFileSync(join(repo, 'long.txt'), Array.from({ length: 75 }, (_, i) => `row ${i + 1}`).join('\n') + '\n')
g('add', '-A')
g('commit', '-q', '-m', 'blobs')

const { setCwd } = await import('../../src/utils/Shell.ts')
setCwd(repo)
const { GitTool } = await import('../../src/tools/GitTool/GitTool.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const context = { abortController: new AbortController(), messages: [], options: {}, getAppState: () => ({}), setAppState: () => {} } as never
const fileAtRef = async (path: string): Promise<string[]> => {
  const out = (await GitTool.call({ op: 'fileAtRef', ref: 'HEAD', path } as never, context)) as { data: { result: string; outcome: string } }
  if (out.data.outcome === 'failed') throw new Error(out.data.result)
  return out.data.result.split('\n')
}

{
  const rows = await fileAtRef('seventeen.txt')
  check('a 17-line blob reads "17 line(s)" (wc -l agrees)', rows[0]?.endsWith(`${Buffer.byteLength(seventeen)} byte(s), 17 line(s)`) === true && g('cat-file', '-p', 'HEAD:seventeen.txt').split('\n').length - 1 === 17, rows[0])
  check('the window shows the 17 lines and no empty row after the last', rows.slice(1, 18).join('\n') === seventeen.slice(0, -1) && rows[18]?.startsWith('full content: mercury://git/at/HEAD/seventeen.txt') === true, JSON.stringify(rows.slice(16, 20)))
}
{
  const rows = await fileAtRef('no-final-newline.txt')
  check('a blob without a final newline still counts its last line (2 lines, both shown)', rows[0]?.endsWith('2 line(s)') === true && rows[1] === 'alpha' && rows[2] === 'omega' && rows[3]?.startsWith('full content:') === true, rows.join(' | '))
}
{
  const rows = await fileAtRef('empty.txt')
  check('an empty blob is 0 lines and shows no row', rows[0]?.endsWith('0 byte(s), 0 line(s)') === true && rows[1]?.startsWith('full content:') === true && rows.length === 2, rows.join(' | '))
}
{
  const rows = await fileAtRef('long.txt')
  check('a 75-line blob shows 60 rows and says "+15 more line(s)" (not 16)', rows[0]?.endsWith('75 line(s)') === true && rows[60] === 'row 60' && rows[61]?.startsWith('… +15 more line(s)') === true, `${rows[0]} … ${rows[61]}`)
}

console.log(failures === 0 ? '\nGIT FILE-AT-REF ROWS: ALL PASS' : `\nGIT FILE-AT-REF ROWS: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
