#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.argv.includes('--writer')) {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const tag = process.argv[process.argv.indexOf('--writer') + 1] as string
  const { initializeErrorLogSink } = await import('../../src/platform/logs/errorLogSink.js')
  const { logError } = await import('../../src/platform/logs/errorLog.js')
  const { runCleanupFunctions } = await import('../../src/platform/processes/cleanupRegistry.js')
  initializeErrorLogSink()
  for (let i = 0; i < 40; i++) {
    logError(new Error(`${tag}-${i}-${'p'.repeat(500)}`))
  }
  await runCleanupFunctions()
  process.exit(0)
}

if (!process.argv.includes('--child')) {
  const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'errlog-')))
  const HOME = join(SCRATCH, 'home')
  const CONFIG = join(SCRATCH, 'config')
  mkdirSync(HOME, { recursive: true })
  mkdirSync(CONFIG, { recursive: true })
  const { MERCURY_HOME: _home, MERCURY_ERROR_REPORTING: _reporting, NODE_ENV: _env, ...rest } = process.env
  const child = Bun.spawnSync([process.execPath, import.meta.path, '--child', SCRATCH], {
    env: { ...rest, HOME, USERPROFILE: HOME, XDG_CACHE_HOME: join(HOME, '.cache'), LOCALAPPDATA: join(HOME, 'AppData', 'Local'), MERCURY_CONFIG_DIR: CONFIG, DEBUG: '1' },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  rmSync(SCRATCH, { recursive: true, force: true })
  process.exit(child.exitCode ?? 1)
}

const SCRATCH = process.argv[process.argv.indexOf('--child') + 1] as string
const CONFIG = join(SCRATCH, 'config')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let fixAt = 'src/platform/logs/errorLogSink.ts (getErrorsPath, initializeErrorLogSink) and logError in src/platform/logs/errorLog.ts'
const check = (label: string, cond: boolean, detail = ''): void => {
  const hint = cond ? '' : ` | to fix, change ${fixAt}`
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${hint}`)
  if (!cond) failures++
}

const { getErrorsPath, initializeErrorLogSink } = await import('../../src/platform/logs/errorLogSink.js')
const { getInMemoryErrors, logError, logMCPError } = await import('../../src/platform/logs/errorLog.js')
const { runCleanupFunctions } = await import('../../src/platform/processes/cleanupRegistry.js')
const { getDebugLogPath } = await import('../../src/platform/logs/debugLog.js')
const { getSessionId } = await import('../../src/boot/process-state/processState.js')
const { CACHE_PATHS } = await import('../../src/platform/files/cachePaths.js')
const { getFsImplementation, setFsImplementation, setOriginalFsImplementation } = await import('../../src/platform/files/fsOperations.js')

const errorsPath = getErrorsPath()
if (!errorsPath.startsWith(SCRATCH) || !getDebugLogPath().startsWith(CONFIG)) {
  console.log(`  [FAIL] the errors file and the debug log must live under the scratch — ${errorsPath} · ${getDebugLogPath()} | to fix, check getErrorsPath in src/platform/logs/errorLogSink.ts and getDebugLogPath in src/platform/logs/debugLog.ts honour HOME and MERCURY_CONFIG_DIR`)
  process.exit(1)
}
check('the errors file lives under the scratch cache home', true, errorsPath)
check('…in the errors folder, named by the local day (<YYYY-MM-DD>.jsonl)', /[\\/]errors[\\/]\d{4}-\d{2}-\d{2}\.jsonl$/.test(errorsPath), errorsPath)

const readRecords = (): Array<Record<string, unknown>> =>
  existsSync(errorsPath)
    ? readFileSync(errorsPath, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
    : []
const debugLines = (): string[] => (existsSync(getDebugLogPath()) ? readFileSync(getDebugLogPath(), 'utf8').split('\n') : [])
const flush = async (): Promise<void> => {
  await runCleanupFunctions()
}

console.log('§1 a logged error lands as one JSONL record')
{
  fixAt = 'src/platform/logs/errorLogSink.ts (initializeErrorLogSink and its record writer) and logError in src/platform/logs/errorLog.ts'
  initializeErrorLogSink()
  logError(new Error('the first logged error'))
  check('nothing on disk before the writer flushes', !existsSync(errorsPath))
  await flush()
  const records = readRecords()
  check('one record after the flush', records.length === 1, String(records.length))
  const record = records[0] ?? {}
  check('…carrying the message (the stack)', typeof record.message === 'string' && (record.message as string).startsWith('Error: the first logged error'), String(record.message).slice(0, 60))
  check('…an ISO timestamp', typeof record.timestamp === 'string' && !Number.isNaN(Date.parse(record.timestamp as string)))
  check('…and the session id', record.sessionId === getSessionId())
  logError(new Error('the second logged error'))
  await flush()
  check('a later error appends a second record', readRecords().length === 2, String(readRecords().length))
}

console.log('\n§2 bounded')
{
  fixAt = 'the size limits in src/platform/logs/errorLogSink.ts (LOG_FILE_BYTE_CEILING, LOG_RECORD_MESSAGE_CEILING and the once-only closePath note) and getErrorsPath for the day file'
  let stats = 0
  const realFs = getFsImplementation()
  setFsImplementation({
    ...realFs,
    statSync(p: string) {
      if (p === errorsPath) stats++
      return realFs.statSync(p)
    },
  })
  try {
    logError(new Error('batch-one'))
    logError(new Error('batch-two'))
    logError(new Error('batch-three'))
    await flush()
  } finally {
    setOriginalFsImplementation()
  }
  check('the 8 MiB ceiling is read by stat on every record append', stats === 3, `stats=${stats}`)
  logError(new Error('x'.repeat(40_000)))
  await flush()
  const last = readRecords().at(-1) ?? {}
  const message = String(last.message)
  check('a 40k-character message is cut at the record ceiling', message.length < 17_000, String(message.length))
  check('…and says how long it was', /\(\d+ characters, cut at 16384\)$/.test(message), message.slice(-40))
}
{
  const before = readRecords().length
  const filler = 'f'.repeat(8 * 1024 * 1024 - readFileSync(errorsPath).length + 1)
  writeFileSync(errorsPath, filler, { flag: 'a' })
  logError(new Error('past the ceiling'))
  await flush()
  const text = readFileSync(errorsPath, 'utf8')
  check('a file at its byte ceiling takes no more records', !text.includes('past the ceiling'))
  const named = debugLines().filter(line => line.includes(errorsPath) && line.includes('byte ceiling'))
  check('…and the debug log names the ceiling once', named.length === 1, String(named.length))
  logError(new Error('still past the ceiling'))
  await flush()
  check('…once only, however many errors follow', debugLines().filter(line => line.includes('byte ceiling')).length === 1)
  check('the records before the ceiling stand', text.split('\n').filter(l => l.startsWith('{')).length === before, String(before))
}
{
  rmSync(CACHE_PATHS.errors(), { recursive: true, force: true })
  ;(await import('../../src/platform/logs/errorLogSink.js')).resetErrorLogSinkForTest()
  const RealDate = globalThis.Date
  const mockClock = (local: Date): void => {
    globalThis.Date = new Proxy(RealDate, {
      construct(_target, args) {
        return args.length === 0 ? new RealDate(local.getTime()) : new RealDate(...(args as [number]))
      },
      apply() {
        return local.toString()
      },
    }) as DateConstructor
  }
  try {
    mockClock(new RealDate(2026, 9, 19, 23, 59, 59, 900))
    const beforeMidnight = getErrorsPath()
    logError(new Error('before local midnight'))
    await flush()
    mockClock(new RealDate(2026, 9, 20, 0, 0, 0, 100))
    const afterMidnight = getErrorsPath()
    logError(new Error('after local midnight'))
    await flush()
    check('the day rolls at local midnight (2026-10-19.jsonl → 2026-10-20.jsonl)', beforeMidnight.endsWith('2026-10-19.jsonl') && afterMidnight.endsWith('2026-10-20.jsonl') && existsSync(beforeMidnight) && existsSync(afterMidnight) && readFileSync(beforeMidnight, 'utf8').includes('before local midnight') && readFileSync(afterMidnight, 'utf8').includes('after local midnight'), `${beforeMidnight} → ${afterMidnight}`)
  } finally {
    globalThis.Date = RealDate
  }
}
{
  const errorsDir = CACHE_PATHS.errors()
  rmSync(errorsDir, { recursive: true, force: true })
  const { resetErrorLogSinkForTest: resetSink } = await import('../../src/platform/logs/errorLogSink.js')
  resetSink()
  const p1 = Bun.spawn([process.execPath, import.meta.path, '--writer', 'sessA'], { env: process.env, stdout: 'ignore', stderr: 'ignore' })
  const p2 = Bun.spawn([process.execPath, import.meta.path, '--writer', 'sessB'], { env: process.env, stdout: 'ignore', stderr: 'ignore' })
  await Promise.all([p1.exited, p2.exited])
  const files = existsSync(errorsDir) ? readdirSync(errorsDir).filter(f => f.endsWith('.jsonl')) : []
  const lines = files.length === 1 ? readFileSync(join(errorsDir, files[0]!), 'utf8').split('\n').filter(Boolean) : []
  let parsedA = 0
  let parsedB = 0
  let intact = lines.length === 80
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as { message?: string }
      if (rec.message?.includes('sessA-')) parsedA++
      else if (rec.message?.includes('sessB-')) parsedB++
      else intact = false
    } catch {
      intact = false
    }
  }
  check('two sessions appending to the same day .jsonl at once share one file and never interleave a record', files.length === 1 && intact && parsedA === 40 && parsedB === 40, `files=${files.join(',')} lines=${lines.length} A=${parsedA} B=${parsedB}`)
}

console.log('\n§3 refusals: an unwritable errors path never throws, is named once')
{
  fixAt = 'the write-failure branch of src/platform/logs/errorLogSink.ts (closePath "cannot be written"); the MCP log is logMCPError in src/platform/logs/errorLog.ts'
  const serverDir = CACHE_PATHS.mcpLogs('fixture')
  const mcpBefore = existsSync(serverDir) ? readdirSync(serverDir).length : 0
  const errorsDir = CACHE_PATHS.errors()
  rmSync(errorsDir, { recursive: true, force: true })
  writeFileSync(errorsDir, 'a file where the errors folder should be\n')
  const { resetErrorLogSinkForTest } = await import('../../src/platform/logs/errorLogSink.js')
  resetErrorLogSinkForTest()
  let threw: unknown = null
  try {
    logError(new Error('refused one'))
    logError(new Error('refused two'))
    await flush()
    logError(new Error('refused three'))
    await flush()
  } catch (error) {
    threw = error
  }
  check('logError and the flush never throw', threw === null, String(threw))
  const refusals = debugLines().filter(line => line.includes('cannot be written') && line.includes(errorsDir))
  check('the refusal is named once in the debug log, with the errno', refusals.length === 1 && /\((ENOTDIR|EEXIST|EACCES|ENOENT)\)/.test(refusals[0] ?? ''), refusals.join(' | ').slice(0, 200))
  check('the regular file at the errors path is untouched', readFileSync(errorsDir, 'utf8') === 'a file where the errors folder should be\n')
  logMCPError('fixture', new Error('the mcp log still lands'))
  await flush()
  const mcpFiles = existsSync(serverDir) ? readdirSync(serverDir) : []
  check('the MCP log of the same process still lands', mcpFiles.length === mcpBefore + 1 && readFileSync(join(serverDir, mcpFiles[0] ?? ''), 'utf8').includes('the mcp log still lands'), mcpFiles.join(','))
}

console.log('\n§4 the control: the ring and the debug line are as before')
{
  fixAt = 'logError in src/platform/logs/errorLog.ts (getInMemoryErrors ring and the [ERROR] debug line)'
  const ring = getInMemoryErrors()
  check('the in-memory ring holds every logged error', ['the first logged error', 'the second logged error', 'past the ceiling', 'refused one', 'refused three'].every(words => ring.some(entry => entry.error.includes(words))), String(ring.length))
  check('the debug log carries each error line', debugLines().filter(line => line.includes('[ERROR] Error: Error: refused three')).length === 1)
}

console.log('\n§5 a failure the code passes over is written to the debug log, once a distinct message')
{
  fixAt = 'src/platform/errors/passedOver.ts (passedOver) and src/platform/errors/passedOverSink.ts (sendPassedOverToDebugLog)'
  const { passedOver } = await import('../../src/platform/errors/passedOver.js')
  const { sendPassedOverToDebugLog } = await import('../../src/platform/errors/passedOverSink.js')
  sendPassedOverToDebugLog()
  for (let turn = 0; turn < 3; turn++) passedOver(new Error('row five: a rename that was passed over (EPERM)'))
  passedOver(new Error('row five: another failure passed over'))
  passedOver('row five: a failure that is a plain string')
  await flush()
  const lines = debugLines().filter(line => line.includes('row five:'))
  check('each distinct failure passed over is in the debug log', ['a rename that was passed over (EPERM)', 'another failure passed over', 'a failure that is a plain string'].every(words => lines.some(line => line.includes(words))), lines.join(' | ').slice(0, 300) || 'no line')
  check('…once each, however often it is passed over', lines.length === 3, String(lines.length))
  check("…at the debug level, the log's floor", lines.length > 0 && lines.every(line => /\[DEBUG\] passed over \(\d+\): row five:/.test(line)), lines[0] ?? 'no line')
  const { mock } = await import('bun:test')
  const debug = await import('../../src/platform/logs/debugLog.js')
  const write = debug.logForDebugging
  const handed: Array<[string, string]> = []
  mock.module(join(import.meta.dir, '..', '..', 'src', 'platform', 'logs', 'debugLog.js'), () => ({
    ...debug,
    logForDebugging: (message: string, opts?: Parameters<typeof write>[1]) => {
      handed.push([opts?.level ?? 'debug', message])
      write(message, opts)
    },
  }))
  const coded = (code: string, words: string): Error => Object.assign(new Error(words), { code })
  const absent = "ENOENT: no such file or directory, open 'row six/MERCURY.md'"
  const through = "ENOTDIR: not a directory, open 'row six/a-file/child'"
  const held = "EACCES: permission denied, open 'row six/held.json'"
  const plain = 'row six: a failure that is no absence'
  for (let turn = 0; turn < 2; turn++) passedOver(coded('ENOENT', absent))
  passedOver(coded('ENOTDIR', through))
  passedOver(coded('EACCES', held))
  passedOver(new Error(plain))
  await flush()
  const six = debugLines().filter(line => line.includes('row six'))
  const at = (level: string, words: string): number => handed.filter(([said, message]) => said === level && message.includes(words)).length
  check('a file or a folder that is not there (ENOENT, ENOTDIR) is an answer: it reaches no line of the debug log', !six.some(line => line.includes(absent) || line.includes(through)), six.join(' | ').slice(0, 300))
  check('…and is handed on at verbose, under the floor, each time it is passed over, as before', at('verbose', absent) === 2 && at('verbose', through) === 1 && at('debug', absent) === 0 && at('debug', through) === 0, JSON.stringify(handed).slice(0, 300))
  check('a failure that is no absence (EACCES, a plain Error) still reaches one line at the debug level', [held, plain].every(words => six.filter(line => line.includes(words) && line.includes('[DEBUG] passed over (')).length === 1) && at('debug', held) === 1 && at('debug', plain) === 1, six.join(' | ').slice(0, 300))
}

console.log(failures === 0 ? '\nprove-error-log-file: all green' : `\nprove-error-log-file: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
