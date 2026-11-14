import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, loadavg } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const given = process.env.READ_STREAM_PROOF_HOME
if (!given) {
  const base = process.env.RP_SCRATCH ?? process.env.MERCURY_TMPDIR ?? process.env.MERCURY_CONFIG_DIR
  if (!base) throw new Error('The proof needs its scratch root')
  const home = realpathSync(mkdtempSync(join(base, 'json-stream-')))
  try {
    const run = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: 'inherit', timeout: 180000, killSignal: 'SIGKILL', env: { ...process.env, HOME: home, USERPROFILE: home, READ_STREAM_PROOF_HOME: home, MERCURY_CONFIG_DIR: join(home, '.mercury'), MERCURY_TMPDIR: join(home, 'tmp') } })
    process.exitCode = run.status ?? 1
  } finally { rmSync(home, { recursive: true, force: true }) }
} else {
  if (homedir() !== given) throw new Error('The runtime did not take the proof home')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  process.env.MERCURY_BARE = '1'
  mkdirSync(join(given, 'tmp'), { recursive: true })
  const src = process.env.PROVE_SRC ?? resolve(dirname(script), '../../src')
  const { setCwdState, setOriginalCwd } = await import(`${src}/bootstrap/state.ts`)
  setCwdState(given); setOriginalCwd(given)
  const { FileReadTool } = await import(`${src}/tools/FileReadTool/FileReadTool.ts`)
  const { getEmptyToolPermissionContext } = await import(`${src}/Tool.ts`)
  const { createFileStateCacheWithSizeLimit } = await import(`${src}/utils/fileStateCache.ts`)
  const { runJsonQuery } = await import(`${src}/tools/FileReadTool/jsonQueryRuntime.ts`)
  let passed = 0, failed = 0
  const check = (name: string, ok: boolean, detail = '') => { ok ? passed++ : failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` ${detail.slice(0, 1000)}`}`) }
  const context = () => ({ messages: [], readFileState: createFileStateCacheWithSizeLimit(100), abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) })
  const read = async (file_path: string, maxTokens?: number) => {
    const ctx = { ...context(), ...(maxTokens === undefined ? {} : { fileReadingLimits: { maxTokens, maxSizeBytes: 4 * 1024 * 1024 * 1024 } }) }
    try {
      const input = { file_path }
      const valid = await FileReadTool.validateInput(input, ctx)
      if (!valid.result) return { body: valid.message, ctx }
      const permission = await FileReadTool.checkPermissions(input, ctx)
      if (permission.behavior === 'deny') return { body: permission.message, ctx }
      const result = await FileReadTool.call(input, ctx)
      return { body: String(FileReadTool.mapToolResultToToolResultBlockParam(result.data, 'stream').content), ctx }
    } catch (error) { return { body: String(error), ctx } }
  }
  const continuation = (body: string): string | null => {
    const match = /Read\(file_path: ("(?:\\.|[^"\\])*")\) continues from there/.exec(body)
    return match ? JSON.parse(match[1]!) : null
  }
  const records = ['\ufeff{"keep":false,"n":0}\n', '{"keep":true,"n":9007199254740993123456789,"label":"é"}\n', '{"keep":false,"n":0}\n', '{"keep":true,"n":4}\r\n', '{"keep":true,"n":5}\n']
  const rows = join(given, 'origins.jsonl')
  writeFileSync(rows, records.join(''))
  const page = await read(`${rows}#read?limit=2&compact=1&q=select(.keep) | {n}`)
  const pageOut = process.argv.indexOf('--page-out')
  if (pageOut >= 0) writeFileSync(process.argv[pageOut + 1]!, page.body)
  const explicitLine = await read(`${rows}#read?limit=2&compact=1&q=select(.keep) | {line:input_line_number,n}`)
  check('input_line_number remains the original JSONL record line inside a value', explicitLine.body.includes('{"line":2,"n":9007199254740993123456789}') && explicitLine.body.includes('{"line":4,"n":4}'), explicitLine.body)
  check('B01 one bracket names BOM-aware UTF-8 and CRLF source lines in value order', page.body.includes('[source lines of values 1-2, in order (- = no single line): 2, 4]'), page.body)
  check('B01 no byte spans or metadata prose appear in the answer', !/bytes \d+-\d+/.test(page.body) && !page.body.includes('Provenance is the input context'), page.body)
  check('B01 tracing preserves numeric literals and no source edit coverage', page.body.includes('9007199254740993123456789') && !page.ctx.readFileState.has(rows) && !page.body.includes('(anchor:'))
  const next = continuation(page.body)
  check('B01 continued result metadata keeps original source lines', next !== null && (await read(next)).body.includes('[source lines of values 3-3, in order (- = no single line): 5]'), page.body)
  const aggregate = await read(`${rows}#read?limit=2&compact=1&q=[.,inputs] | sort_by(.n)`)
  check('B01 cross-input aggregation uses a dash for every returned value', aggregate.body.includes('[source lines of values 1-2, in order (- = no single line): -, -]'), aggregate.body)
  check('the ruled result has no work or heap commentary', !aggregate.body.includes('Work:') && !aggregate.body.includes('engine heap:'), aggregate.body)
  const constant = await read(`${rows}#read?limit=1&q=42`)
  check('B01 a source-independent value is not assigned invented row lineage', constant.body.includes('[source lines of values 1-1, in order (- = no single line): -]'), constant.body)
  const multiline = join(given, 'multiline.json')
  writeFileSync(multiline, '{\n "n": 1\n}\n')
  const multi = await read(`${multiline}#read?q=.n`)
  check('B01 one JSON document receives no source-line bracket', !multi.body.includes('[source lines of values') && multi.body.includes('state: complete'), multi.body)
  const sameLine = join(given, 'two-values.jsonl')
  writeFileSync(sameLine, '{"n":1} {"n":2}\n')
  check('B01 values from the same input line do not invent a second line', (await read(`${sameLine}#read?q=.n`)).body.includes('[source lines of values 1-2, in order (- = no single line): 1, 1]'))
  const openEnd = join(given, 'open-end.jsonl')
  writeFileSync(openEnd, '{"n":1}\n{"n":2}\n{"n":3}')
  const lastRecord = await read(`${openEnd}#read?compact=1&q=.n, input_line_number`)
  check('B01 a last record without a final newline is named by its own line', lastRecord.body.includes('[source lines of values 1-6, in order (- = no single line): 1, 1, 2, 2, 3, 3]') && lastRecord.body.includes('\n3\n3\n'), lastRecord.body)
  check('B01 the source byte count stays the file size when its last line has no newline', lastRecord.body.includes('Query input: 23 of 23 bytes consumed'), lastRecord.body)
  const loneRecord = join(given, 'lone.jsonl')
  writeFileSync(loneRecord, '{"n":1}')
  check('B01 a single record without a newline is on line 1', (await read(`${loneRecord}#read?q=.n`)).body.includes('[source lines of values 1-1, in order (- = no single line): 1]'))
  const sharedEnd = join(given, 'shared-end.jsonl')
  writeFileSync(sharedEnd, '{"n":1}\r\n{"n":2} {"n":3}')
  check('B01 two records on an unterminated last line are not given the line before', (await read(`${sharedEnd}#read?q=.n`)).body.includes('[source lines of values 1-3, in order (- = no single line): 1, 2, 2]'))
  const cutEnd = join(given, 'cut-end.jsonl')
  writeFileSync(cutEnd, '{"n":1}\n{"n":')
  const cutRecord = await read(`${cutEnd}#read?q=.n`)
  check('B01 a last record cut short keeps the position the engine reports', cutRecord.body.includes('Unfinished JSON term at EOF at line 2, column 5') && cutRecord.body.includes('[source lines of values 1-1, in order (- = no single line): 1]'), cutRecord.body)

  const late = join(given, 'late.jsonl')
  const lateFd = openSync(late, 'w')
  try {
    for (let n = 0; n < 90000; n++) writeSync(lateFd, `${JSON.stringify({ n, padding: 'x'.repeat(80) })}\n`)
  } finally { closeSync(lateFd) }
  const lateRead = await read(`${late}#read?offset=80000&limit=2&compact=1&q=.`)
  check('B02 a page after more than five MiB of skipped output is reached', statSync(late).size > 5 * 1024 * 1024 && lateRead.body.includes('"n":80000') && lateRead.body.includes('"n":80001') && !lateRead.body.includes('"n":79999'), lateRead.body)
  check('B02 a late page retains exact source-row provenance', lateRead.body.includes('[source lines of values 80001-80002, in order (- = no single line): 80001, 80002]'), lateRead.body)
  const roomy = await read(`${late}#read?limit=100000&compact=1&q=.n`, 3000)
  const bracket = /\[source lines of values (\d+)-(\d+), in order \(- = no single line\): ([^\n]*)\]/.exec(roomy.body)
  check('B01 metadata covers the actual page without a metadata artifact or a fixed page ceiling', bracket !== null && bracket[3]!.split(', ').length === Number(bracket[2]) - Number(bracket[1]) + 1 && roomy.body.length < 15000 && continuation(roomy.body) !== null, roomy.body)

  const mutable = join(given, 'mutable.jsonl')
  writeFileSync(mutable, '{"n":1}\n{"n":2}\n{"n":3}\n')
  utimesSync(mutable, 1600000000, 1600000000)
  const before = await read(`${mutable}#read?limit=1&q=.n`)
  const saved = statSync(mutable)
  const follow = continuation(before.body)
  writeFileSync(mutable, '{"n":9}\n{"n":2}\n{"n":3}\n')
  utimesSync(mutable, 1600000000, 1600000000)
  check('B04 the same-size/mtime mutation fixture is real', statSync(mutable).size === saved.size && statSync(mutable).mtimeMs === saved.mtimeMs)
  check('B04 a continuation detects changed source rather than mixing pages', follow !== null && (await read(follow)).body.includes('state: changed'), before.body)

  const large = join(given, 'large.jsonl')
  const row = `{"n":1,"pad":"${'x'.repeat(4096 - Buffer.byteLength('{"n":1,"pad":""}\n'))}"}\n`
  const block = Buffer.from(row.repeat(256))
  const size = (process.argv.includes('--large') ? 2048 : 32) * 1024 * 1024
  const writing = openSync(large, 'w')
  try { for (let n = 0; n < size; n += block.length) writeSync(writing, block) } finally { closeSync(writing) }
  const directory = join(given, 'runtime')
  mkdirSync(directory)
  const fd = openSync(large, 'r')
  try {
    const started = performance.now(), load = loadavg()
    const run = await runJsonQuery({ fd, directory, query: '.n', offset: 0, limit: 2, raw: false, compact: true }, new AbortController().signal)
    console.log(`large source: ${size} bytes; consumed ${run.sourceBytes}; physically read ${run.sourceReadBytes}; wasm heap ${run.memoryBytes}; ${(performance.now() - started).toFixed(1)} ms; load ${load.join(',')}`)
    check('B03 a large valid JSONL first page does not read the whole source', statSync(large).size === size && run.shown === 2 && run.sourceBytes < 1024 * 1024 && run.sourceReadBytes < 1024 * 1024)
    check('B03 the large-source engine stays bounded by current values, not file size', run.memoryBytes <= 64 * 1024 * 1024 && readFileSync(run.outputPath, 'utf8') === '1\n1\n')
  } finally { closeSync(fd) }
  const largePage = await read(`${large}#read?limit=2&compact=1&q=.n`)
  check('B03 the Read entry also serves an early large-source page with exact lines', largePage.body.includes('[source lines of values 1-2, in order (- = no single line): 1, 2]') && !largePage.body.includes(' · sha256:'), largePage.body)
  console.log(`${passed}/${passed + failed} checks`)
  process.exitCode = failed ? 1 : 0
}
