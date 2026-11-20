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

  console.log('\n3. FileReadTool/read/pdfLane.ts: page failure rejects and cleans up outputDir')
  {
    const pdfDir = join(scratch, 'pdf-pages')
    mkdirSync(pdfDir, { recursive: true })
    writeFileSync(join(pdfDir, 'page-1.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const childSrc = `
      import { mock } from 'bun:test'
      globalThis.MACRO = { VERSION: '1.0.0' }
      const pdfTextPath = ${JSON.stringify(join(SRC, 'utils/pdfText.ts'))}
      const pdfPath = ${JSON.stringify(join(SRC, 'utils/pdf.ts'))}
      const resizerPath = ${JSON.stringify(join(SRC, 'utils/imageResizer.ts'))}
      const capsPath = ${JSON.stringify(join(SRC, 'utils/model/capabilities.ts'))}
      const realPdf = await import(pdfPath)
      const realResizer = await import(resizerPath)
      const realCaps = await import(capsPath)
      let removedDir = null
      mock.module(pdfTextPath, () => ({
        extractPdfText: async () => ({ pageCount: 1, pages: [{ pageNumber: 1, hasTextLayer: false, hasImages: true, text: '' }] }),
        renderPdfText: () => '',
      }))
      mock.module(pdfPath, () => ({
        ...realPdf,
        extractPDFPages: async () => ({ success: true, data: { type: 'parts', file: { filePath: '/tmp/a.pdf', originalSize: 10, count: 1, outputDir: ${JSON.stringify(pdfDir)} } } }),
        removePDFPages: async (dir: string) => { removedDir = dir },
      }))
      mock.module(resizerPath, () => ({
        ...realResizer,
        maybeResizeAndDownsampleImageBuffer: async () => { throw new Error('page-resize-boom') },
      }))
      mock.module(capsPath, () => ({
        ...realCaps,
        resolveModelCapabilities: () => ({ media: { images: true, pdf: true } }),
      }))
      const { readPdfLane } = await import(${JSON.stringify(join(SRC, 'tools/FileReadTool/read/pdfLane.ts'))})
      let threw = null
      let returned = null
      try {
        returned = await readPdfLane('/tmp/a.pdf', '/tmp/a.pdf', { file_path: '/tmp/a.pdf', pages: '1' }, { abortController: new AbortController(), options: { engineModel: 'test' } } as never, { maxTokens: 10000, maxSizeBytes: 1000000 }, false, () => ({ maxTokens: 10000, maxSizeBytes: 1000000 }))
      } catch (err) {
        threw = err instanceof Error ? err.message : String(err)
      }
      process.stdout.write('\\n' + JSON.stringify({ threw, removedDir, hasReturn: returned !== null }))
    `
    const res = spawnSync(BUN, ['-e', childSrc], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' },
    })
    const out = res.status === 0 ? (JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as { threw: string | null; removedDir: string | null; hasReturn: boolean }) : { threw: `exit ${res.status}: ${res.stderr.slice(-200)}`, removedDir: null, hasReturn: true }
    check('pdf-lane-page-throw: rejects with page-resize-boom and cleans up outputDir', out.threw === 'page-resize-boom' && out.removedDir === pdfDir && !out.hasReturn, JSON.stringify(out))
  }

  console.log('\n4. FileWriteTool/structuredTargets.ts: non-ENOENT stat failure is not reported as absent')
  if (POSIX_MODES) {
    const { parseStructuredWriteTarget, structuredTargetRefusal } = await import('../../src/tools/FileWriteTool/structuredTargets.js')
    const lockedDir = join(scratch, 'locked-structured')
    mkdirSync(lockedDir, { recursive: true })
    const dbInLocked = join(lockedDir, 'data.sqlite')
    writeFileSync(dbInLocked, '')
    const missingDb = join(scratch, 'missing.sqlite')
    chmodSync(lockedDir, 0o000)
    try {
      const lockedTarget = parseStructuredWriteTarget(`${dbInLocked}:items/1`)!
      const lockedRefusal = structuredTargetRefusal(lockedTarget, 'write')
      check('structured-target-eacces: refuses with EACCES instead of saying no SQLite database', lockedRefusal !== null && /EACCES|permission denied/i.test(lockedRefusal.message) && !lockedRefusal.message.includes('There is no SQLite database'), JSON.stringify(lockedRefusal))
      const missingTarget = parseStructuredWriteTarget(`${missingDb}:items/1`)!
      const missingRefusal = structuredTargetRefusal(missingTarget, 'write')
      check('structured-target-enoent: absent database still reports There is no SQLite database', missingRefusal !== null && missingRefusal.message.includes('There is no SQLite database'), JSON.stringify(missingRefusal))
    } finally {
      chmodSync(lockedDir, 0o700)
    }
  }

  console.log('\n5. GitTool/GitTool.ts: non-ENOENT stat failure on cwd is not reported as missing')
  if (POSIX_MODES) {
    const { GitTool } = await import('../../src/tools/GitTool/GitTool.js')
    const lockedDir = join(scratch, 'locked-git')
    mkdirSync(lockedDir, { recursive: true })
    const repoInLocked = join(lockedDir, 'repo')
    mkdirSync(repoInLocked, { recursive: true })
    chmodSync(lockedDir, 0o000)
    try {
      const eaccesRes = await GitTool.validateInput!({ op: 'status', cwd: repoInLocked }, {} as never)
      check('git-cwd-eacces: refuses with EACCES instead of saying cwd does not exist', !eaccesRes.result && /EACCES|permission denied/i.test(eaccesRes.message) && !eaccesRes.message.includes('cwd does not exist'), JSON.stringify(eaccesRes))
      const enoentRes = await GitTool.validateInput!({ op: 'status', cwd: join(scratch, 'no-such-repo') }, {} as never)
      check('git-cwd-enoent: absent cwd still reports cwd does not exist', !enoentRes.result && enoentRes.message.includes('cwd does not exist'), JSON.stringify(enoentRes))
    } finally {
      chmodSync(lockedDir, 0o700)
    }
  }

  console.log('\n6. JevEvalTool/jevEvalEvidence.ts: non-ENOENT stat failure says could not be read, not does not exist')
  if (POSIX_MODES) {
    const { expandJevEvalEvidence } = await import('../../src/tools/JevEvalTool/jevEvalEvidence.js')
    const lockedDir = join(scratch, 'locked-jev')
    mkdirSync(lockedDir, { recursive: true })
    const fileInLocked = join(lockedDir, 'notes.txt')
    writeFileSync(fileInLocked, 'hello\n')
    chmodSync(lockedDir, 0o000)
    try {
      const eaccesRes = expandJevEvalEvidence([{ file: { path: fileInLocked } }])
      check('jev-evidence-eacces: refuses with could not be read and EACCES, not does not exist', !eaccesRes.ok && eaccesRes.reason.includes('could not be read') && /EACCES|permission denied/i.test(eaccesRes.reason) && !eaccesRes.reason.includes('does not exist'), JSON.stringify(eaccesRes))
      const enoentRes = expandJevEvalEvidence([{ file: { path: join(scratch, 'missing-jev.txt') } }])
      check('jev-evidence-enoent: absent file still reports does not exist', !enoentRes.ok && enoentRes.reason.includes('does not exist'), JSON.stringify(enoentRes))
    } finally {
      chmodSync(lockedDir, 0o700)
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
