#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = join(import.meta.dir, '../../src')

const scratch = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'prove-faults-fn26-')))
const home = join(scratch, 'home')
const project = join(scratch, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(project, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

try {
  console.log('\n1. readRichFormats.ts: renderSqliteTarget reports unreadable table/view errors')
  {
    const sqliteMod = 'bun:sqlite'
    const { Database } = (await import(sqliteMod)) as { Database: new (path: string) => { exec(sql: string): void; close(): void } }
    const { renderSqliteTarget } = await import('../../src/tools/FileReadTool/readRichFormats.js')
    const dbPath = join(scratch, 'faulty.sqlite')
    const db = new Database(dbPath)
    db.exec('CREATE TABLE good (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO good VALUES (1, "ok");')
    db.exec('CREATE TABLE temp_src (x INTEGER); CREATE VIEW broken_view AS SELECT x FROM temp_src; DROP TABLE temp_src;')
    db.exec('CREATE VIRTUAL TABLE broken_vtab USING fts5(body);')
    db.close()
    const rawDb = readFileSync(dbPath)
    const idx = rawDb.indexOf('fts5')
    if (idx !== -1) rawDb.write('xxxx', idx, 'ascii')
    writeFileSync(dbPath, rawDb)

    const rendered = await renderSqliteTarget(dbPath)
    check('sqlite-good-table: readable table still reports exact row count', rendered.text.includes('## good (table, 1 row)'), rendered.text)
    check('sqlite-broken-table: failed table never prints (table, view) and reports the error', !rendered.text.includes('## broken_vtab (table, view)') && /## broken_vtab \(table, .*no such module/i.test(rendered.text), rendered.text)
    check('sqlite-broken-view: failed view reports its error instead of empty view', /## broken_view \(view, .*no such table/i.test(rendered.text), rendered.text)
  }

  console.log('\n2. JournalTool.ts: getSessionId failure throws instead of staging under boot')
  {
    const childSrc = `
      import { mock } from 'bun:test'
      globalThis.MACRO = { VERSION: '1.0.0' }
      const statePath = ${JSON.stringify(join(SRC, 'bootstrap/state.ts'))}
      const realState = await import(statePath)
      mock.module(statePath, () => ({
        ...realState,
        getSessionId: () => { throw new Error('session-id-boom') },
      }))
      const { stagedJournalEntry } = await import(${JSON.stringify(join(SRC, 'mneme/journal.ts'))})
      const { JournalTool } = await import(${JSON.stringify(join(SRC, 'tools/JournalTool/JournalTool.ts'))})
      let threw = null
      try {
        await JournalTool.call({ entry: 'Finished task cleanly.' }, {} as never, {} as never, {} as never)
      } catch (err) {
        threw = err instanceof Error ? err.message : String(err)
      }
      process.stdout.write('\\n' + JSON.stringify({ threw, bootStaged: stagedJournalEntry('boot') ?? null }))
    `
    const res = spawnSync(BUN, ['-e', childSrc], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' },
    })
    const out = res.status === 0 ? (JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as { threw: string | null; bootStaged: unknown }) : { threw: `exit ${res.status}: ${res.stderr.slice(-200)}`, bootStaged: 'err' }
    check('journal-session-id-throw: rejects with session-id-boom and stages nothing under boot', out.threw === 'session-id-boom' && out.bootStaged === null, JSON.stringify(out))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
