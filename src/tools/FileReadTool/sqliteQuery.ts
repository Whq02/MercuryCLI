import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { copyFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReadQueryRequest, ReadQueryResult } from './readQuery.js'
import { getMercuryTempDir } from '../../utils/permissions/filesystem.js'
import { parseRichFormatTarget } from './readRichFormats.js'
import { readViewPage, readViewWindow } from './readViewPage.js'
import { withReadViewSource } from './readViewSource.js'
import { runSqliteQuery } from './sqliteQueryProcess.js'

async function remoteWal(request: ReadQueryRequest, source: string, file: string): Promise<void> {
  const { parseRemotePath } = await import('../../services/remoteFiles/target.js')
  const { remoteStat } = await import('../../services/remoteFiles/ops.js')
  const target = parseRemotePath(`${source}-wal`)
  if (target === null) return
  const { FileReadTool } = await import('./FileReadTool.js')
  const valid = await FileReadTool.validateInput!({ file_path: `${source}-wal` }, request.context)
  if (!valid.result) throw new Error(valid.message)
  if (await remoteStat(target, request.context.abortController.signal) === null) return
  await withReadViewSource(request, `${source}-wal`, async wal => { await copyFile(wal, `${file}-wal`) }, true)
}

export async function sqliteQuery(request: ReadQueryRequest): Promise<ReadQueryResult> {
  const parsed = parseRichFormatTarget(request.target.source)
  const source = parsed?.kind === 'sqlite' ? parsed.containerPath : request.target.source
  const parameters = request.target.parameters
  const table = parameters.table ?? (parsed?.kind === 'sqlite' ? parsed.subtarget : undefined)
  const window = readViewWindow(request)
  const page = await withReadViewSource(request, source, async fetched => {
    let file = source.startsWith('ssh://') ? fetched : await realpath(fetched)
    if (source.startsWith('ssh://')) await remoteWal(request, source, file)
    const wal = existsSync(`${file}-wal`) && (await stat(`${file}-wal`)).size > 32, journal = existsSync(`${file}-journal`)
    if (!source.startsWith('ssh://')) {
      for (const suffix of ['-wal', '-shm', '-journal']) {
        if (existsSync(`${file}${suffix}`)) await withReadViewSource(request, `${file}${suffix}`, async () => {}, true)
      }
    }
    let snapshot: string | null = null
    try {
      if (wal && !existsSync(`${file}-shm`) && !source.startsWith('ssh://')) {
        const root = join(getMercuryTempDir(), 'sqlite-views')
        mkdirSync(root, { recursive: true, mode: 0o700 })
        snapshot = mkdtempSync(join(root, 'snapshot-'))
        const copy = join(snapshot, 'database.sqlite')
        await copyFile(file, copy)
        await copyFile(`${file}-wal`, `${copy}-wal`)
        file = copy
      }
      const result = await runSqliteQuery({ file, immutable: !wal && !journal, sql: parameters.sql ?? (table === undefined ? 'SELECT * FROM sqlite_schema' : undefined), table, where: parameters.where, order: parameters.order, ...window, room: Math.max(1, Math.min(request.limits.maxSizeBytes, request.limits.maxTokens * 4) - 2000), artifactDirectory: join(getMercuryTempDir(), 'query-results') }, request.context.abortController.signal)
      return { ...result, privateCopy: snapshot !== null }
    } finally { if (snapshot !== null) rmSync(snapshot, { recursive: true, force: true }) }
  })
  const headings = [
    'This is a live result, run again on continuation, not a snapshot.',
    `SQL: ${JSON.stringify(page.sql)}`,
    `Columns: ${JSON.stringify(page.columns)}`,
    ...(source.startsWith('ssh://') ? ['The database and any WAL were copied here before the query ran; continuation transfers them again.'] : []),
  ]
  return readViewPage(request, page.privateCopy ? 'SQLite query · source-mode: private copy of leftover WAL' : 'SQLite query', headings, page.rows, window.offset + page.rows.length + (page.more ? 1 : 0), window)
}
