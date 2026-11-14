import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { vendoredNodeBeside, selfScriptPath } from '../../daemon/daemonBuild.js'

export interface SqliteQueryJob {
  file: string
  immutable: boolean
  sql?: string
  table?: string
  where?: string
  order?: string
  offset: number
  limit: number
  room: number
  artifactDirectory: string
}

export interface SqliteQueryPage {
  columns: string[]
  rows: string[]
  more: boolean
  sql: string
}

async function sqliteQueryChild() {
  const load = Function('name', 'return import(name)') as (name: string) => Promise<any>
  const { DatabaseSync, constants } = await load('node:sqlite')
  const { pathToFileURL } = await load('node:url')
  const { mkdirSync, mkdtempSync, writeFileSync } = await load('node:fs')
  const { join } = await load('node:path')
  let input = ''
  for await (const chunk of process.stdin) input += String(chunk)
  const job = JSON.parse(input) as SqliteQueryJob
  let db: any
  try {
    const url = pathToFileURL(job.file)
    url.search = job.immutable ? '?mode=ro&immutable=1' : '?mode=ro'
    db = new DatabaseSync(url.href, { readOnly: true, allowExtension: false, defensive: true, timeout: 3000 })
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY')
    const introspection = new Set(['table_info', 'table_xinfo', 'table_list', 'index_info', 'index_xinfo', 'index_list', 'foreign_key_list', 'foreign_key_check', 'integrity_check', 'quick_check'])
    db.setAuthorizer((action: number, first: string | null, second: string | null) => {
      if (action === constants.SQLITE_ATTACH || action === constants.SQLITE_DETACH) return constants.SQLITE_DENY
      if (action === constants.SQLITE_FUNCTION && second?.toLowerCase() === 'load_extension') return constants.SQLITE_DENY
      if (action === constants.SQLITE_PRAGMA && second !== null && !introspection.has(first?.toLowerCase() ?? '')) return constants.SQLITE_DENY
      return constants.SQLITE_OK
    })
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
    let sql = job.sql
    if (sql === undefined) {
      const table = job.table ?? ''
      const columns = db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all().map((row: { name: string }) => row.name)
      if (columns.length === 0) throw new Error(`no such table: ${table}`)
      let order = ''
      if (job.order) {
        order = ' ORDER BY ' + job.order.split(',').map(part => {
          const term = /^(.*?)(?:\s+(ASC|DESC))?$/i.exec(part.trim())!
          const written = term[1]!, column = columns.find((name: string) => name.toLowerCase() === written.toLowerCase())
          if (!column) throw new Error(`no such ordering column: ${written}`)
          return `${quote(column)}${term[2] ? ` ${term[2].toUpperCase()}` : ''}`
        }).join(', ')
      }
      const where = job.where ?? ''
      let depth = 0, quoted = ''
      for (let i = 0; i < where.length; i++) {
        const c = where[i]!
        if (quoted) {
          if (c === quoted) { if (where[i + 1] === quoted) i++; else quoted = '' }
          continue
        }
        if (c === "'" || c === '"' || c === '`') quoted = c
        else if (c === '[') quoted = ']'
        else if (c === '(') depth++
        else if (c === ')' && --depth < 0) throw new Error('The table predicate is an expression; use sql= for a complete statement.')
        else if (c === ';' || where.slice(i, i + 2) === '--' || where.slice(i, i + 2) === '/*') throw new Error('The table predicate is an expression; use sql= for a complete statement.')
      }
      if (depth || quoted) throw new Error('The table predicate has an unclosed quote or parenthesis.')
      sql = `SELECT * FROM ${quote(table)}${where ? ` WHERE (${where})` : ''}${order}`
    }
    const statement = db.prepare(sql)
    if (statement.sourceSQL !== statement.expandedSQL) throw new Error('SQL parameters have no values in this Read target; supply literal values in the statement.')
    const tail = sql.slice(statement.sourceSQL.length).replace(/\/\*[\s\S]*?\*\/|--[^\r\n]*/g, '').trim()
    if (tail) throw new Error('A SQL Read returns one statement; the supplied SQL has another statement after it.')
    statement.setReadBigInts(true)
    statement.setReturnArrays(true)
    const columns = statement.columns().map((column: { name: string }) => column.name)
    const valueText = (value: unknown): string => {
      if (typeof value === 'bigint') return String(value)
      if (value instanceof Uint8Array) return JSON.stringify({ blob: Buffer.from(value).toString('base64'), bytes: value.byteLength })
      if (typeof value === 'number' && !Number.isFinite(value)) return JSON.stringify({ float: String(value) })
      return JSON.stringify(value)
    }
    const iterator = statement.iterate()
    const rows: string[] = []
    let index = 0, used = 0, more = false
    try {
      for (const row of iterator) {
        if (index++ < job.offset) continue
        if (rows.length >= job.limit) { more = true; break }
        const text = `[${row.map(valueText).join(',')}]`
        if (rows.length > 0 && used + text.length > job.room) { more = true; break }
        let shown = `${index}\t${text}`
        if (text.length > job.room) {
          mkdirSync(job.artifactDirectory, { recursive: true, mode: 0o700 })
          const directory = mkdtempSync(join(job.artifactDirectory, 'sqlite-row-'))
          const file = join(directory, 'row.json')
          writeFileSync(file, text + '\n', { mode: 0o600 })
          shown = `${index}\t[complete generated row: ${text.length} characters; Read(file_path: ${JSON.stringify(file)}) for the full value]`
        }
        rows.push(shown)
        used += shown.length
      }
    } finally { iterator.return?.() }
    process.stdout.write(JSON.stringify({ columns, rows, more, sql }))
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    process.exitCode = 1
  } finally { db?.close() }
}

export async function runSqliteQuery(job: SqliteQueryJob, signal: AbortSignal): Promise<SqliteQueryPage> {
  signal.throwIfAborted()
  const executable = process.versions.bun
    ? vendoredNodeBeside(dirname(selfScriptPath())) ?? vendoredNodeBeside(join(import.meta.dirname, '../../..', 'dist')) ?? 'node'
    : process.execPath
  mkdirSync(job.artifactDirectory, { recursive: true, mode: 0o700 })
  const artifactDirectory = mkdtempSync(join(job.artifactDirectory, 'result-'))
  job = { ...job, artifactDirectory }
  const child = spawn(executable, ['--input-type=module', '-e', `(${sqliteQueryChild.toString()})()`], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  let output = '', diagnostic = '', completed = false
  const kill = () => { child.kill('SIGKILL') }
  process.once('exit', kill)
  signal.addEventListener('abort', kill, { once: true })
  try {
    return await new Promise<SqliteQueryPage>((resolve, reject) => {
      child.stdout.on('data', chunk => { output += String(chunk) })
      child.stderr.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-4000) })
      child.once('error', reject)
      child.stdin.on('error', error => { if (!signal.aborted) reject(error) })
      child.once('close', code => {
        if (signal.aborted) { reject(signal.reason ?? new Error('SQLite query cancelled.')); return }
        try {
          const answer = JSON.parse(output)
          if (answer.error) reject(new Error(answer.error))
          else if (code !== 0) reject(new Error(diagnostic || `SQLite query exited ${code}.`))
          else { completed = true; resolve(answer) }
        } catch { reject(new Error(diagnostic || 'SQLite query ended without a result.')) }
      })
      child.stdin.end(JSON.stringify(job))
      if (signal.aborted) kill()
    })
  } finally {
    if (child.exitCode === null && child.signalCode === null) kill()
    await closed
    signal.removeEventListener('abort', kill)
    process.removeListener('exit', kill)
    if (!completed || readdirSync(artifactDirectory).length === 0) rmSync(artifactDirectory, { recursive: true, force: true })
  }
}
