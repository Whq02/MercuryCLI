#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORLD = realpathSync(mkdtempSync(join(tmpdir(), 'jev-shapes-')))
const HOME = join(WORLD, 'home')
const PROJECT = join(WORLD, 'project')
const DIR = join(PROJECT, 'evidence')
for (const dir of [HOME, DIR]) mkdirSync(dir, { recursive: true })
process.chdir(PROJECT)
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const key of ['TYPESAFE_API_KEY', 'NODE_ENV', 'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'MERCURY_API_UNIX_SOCKET']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://example.invalid/mercury' }

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const PROOF_KEY = 'proof-key-jev-not-a-real-key-0007'
const ROOT = join(import.meta.dir, '..', '..')

writeFileSync(join(HOME, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 3 }))
const { startJevStandin } = await import('./lib/jevStandin.ts')
const standin = await startJevStandin()
process.env.MERCURY_JEV_BASE = standin.base

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setJevEnabled, setJevPacePerMinute } = await import('../../src/services/jev/jevSetting.ts')
const { storeJevApiKey } = await import('../../src/services/jev/jevKey.ts')
const { jevLedgerSnapshot, resetJevLedger } = await import('../../src/services/jev/jevLedger.ts')
const { JEV_TOOL_NAME } = await import('../../src/services/jev/jevContract.ts')
const { formatZodValidationError } = await import('../../src/utils/toolErrors.ts')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
const { JevEvalTool, jevEvalCall } = await import('../../src/tools/JevEvalTool/JevEvalTool.ts')
const { JEV_EVAL_PROMPT } = await import('../../src/tools/JevEvalTool/prompt.ts')
const constants = (await import('../../src/tools/JevEvalTool/constants.ts')) as Record<string, unknown>
const MAX_ROWS = typeof constants.JEV_EVAL_MAX_ROWS === 'number' ? constants.JEV_EVAL_MAX_ROWS : NaN
const MAX_FILE_BYTES = typeof constants.JEV_EVAL_MAX_FILE_BYTES === 'number' ? constants.JEV_EVAL_MAX_FILE_BYTES : NaN

setJevEnabled(true)
storeJevApiKey(PROOF_KEY)
resetJevLedger()

const schema = JevEvalTool.inputSchema
const parse = (input: unknown) => schema.safeParse(input)
const refusal = (input: unknown): string => {
  const r = parse(input)
  return r.success ? 'ok' : formatZodValidationError(JEV_TOOL_NAME, r.error, zodToJsonSchema(schema as never))
}
const questions = [
  { id: 'killed', kind: 'noul' as const, ask: 'Does `tail` name a kill from outside (rc 137, a signal, a kill line)?' },
  { id: 'starved', kind: 'noul' as const, ask: 'Does `tail` name a starved capture?' },
]
const call = (evidence: unknown[], qs: unknown[] = questions) => ({ goal: 'sort the reds in a file', evidence, questions: qs })
const context = { abortController: new AbortController() } as never
const stateOf = (index: number): string => JSON.stringify((standin.received[index]?.body as { state?: unknown } | undefined)?.state)
const statesSent = (): string[] => standin.received.map((_, index) => stateOf(index))
const rowsOf = (text: string): string[] => text.split('\n').filter(line => / \| /.test(line) && !line.startsWith('JEV ') && !line.startsWith('item | '))
const fresh = (): void => {
  standin.reset()
  resetJevLedger()
}
const file = (name: string, content: string): string => {
  const path = join(DIR, name)
  writeFileSync(path, content)
  return path
}

const TSV = file('reds.tsv', 'id\ttail\trc\nui\trc 137 — killed by the runner after the deadline\t137\napi\tcapture deadline exceeded; the last frame is empty\t1\nx\texpected the row "settled", the frame reads "settling"\t1\n')
const TSV_STATES = [
  JSON.stringify({ tail: 'rc 137 — killed by the runner after the deadline', rc: '137' }),
  JSON.stringify({ tail: 'capture deadline exceeded; the last frame is empty', rc: '1' }),
  JSON.stringify({ tail: 'expected the row "settled", the frame reads "settling"', rc: '1' }),
]

section('§1 a TSV file of three rows is three items named by the header, keyed by the id column, one request each')
fresh()
const fileInput = call([{ file: { path: TSV } }])
const parsedFile = parse(fileInput)
check('RED WHERE THE SCHEMA REFUSES A FILE ITEM: {file:{path}} parses as an evidence item', parsedFile.success, refusal(fileInput))
const tsv = await JevEvalTool.call(fileInput as never, context)
check('the call answers: status ok', tsv.data.status === 'ok', tsv.data.text)
console.log(tsv.data.text.split('\n').map(l => `    ${l}`).join('\n'))
check('three requests reached the stand-in, one per row', standin.received.length === 3, String(standin.received.length))
check('each state is the row under the header\'s names, the id column left out', TSV_STATES.every(state => statesSent().includes(state)), statesSent().join(' / '))
check('no state carries the id column', !statesSent().some(state => state.includes('"id"')))
check('the header counts three items', /^JEV jev-1\.13\.0 \| 3 items × 2 questions \| /.test(tsv.data.text), tsv.data.text.split('\n')[0])
const tsvLines = tsv.data.text.split('\n')
check('the rows are keyed by the id column, in file order', tsvLines[2]?.startsWith('ui | ') === true && tsvLines[3]?.startsWith('api | ') === true && tsvLines[4]?.startsWith('x | ') === true, tsvLines.slice(2, 5).join(' // '))
check('the ledger counted three attempts and three calls — every row counts', jevLedgerSnapshot().attempts === 3 && jevLedgerSnapshot().calls === 3, JSON.stringify(jevLedgerSnapshot()))
const sourceLine = tsvLines.find(line => line.startsWith('from '))
check('one source line after the rows names the file, the format, the id column, the row count and the bytes', sourceLine === `from ${TSV} (tsv, ids from column id): 3 rows, ${Buffer.byteLength(readFileSync(TSV, 'utf8'), 'utf8')} bytes`, sourceLine)
check('six lines: the header, the columns, three rows, the source', tsvLines.length === 6, String(tsvLines.length))

section('§2 the other table forms give the same three states: a markdown pipe table, a CRLF TSV, a CSV with quoting, JSONL, an inline table')
fresh()
const MD = file('reds.md', '# the reds\n\nsome prose first\n\n| id | tail | rc |\n|:---|------|---:|\n| ui | rc 137 — killed by the runner after the deadline | 137 |\n| api | capture deadline exceeded; the last frame is empty | 1 |\n| x | expected the row "settled", the frame reads "settling" | 1 |\n\nprose after\n')
const md = await JevEvalTool.call(call([{ file: { path: MD } }]) as never, context)
check('a markdown pipe table: three requests with the same states, keyed by the id column', md.data.status === 'ok' && standin.received.length === 3 && TSV_STATES.every(state => statesSent().includes(state)) && rowsOf(md.data.text).map(r => r.split(' | ')[0]).join(',') === 'ui,api,x', md.data.text)
fresh()
const CRLF = file('reds-crlf.tsv', 'id\ttail\trc\r\nui\trc 137 — killed by the runner after the deadline\t137\r\napi\tcapture deadline exceeded; the last frame is empty\t1\r\nx\texpected the row "settled", the frame reads "settling"\t1\r\n')
const crlf = await JevEvalTool.call(call([{ file: { path: CRLF } }]) as never, context)
check('a CRLF TSV parses the same (no \\r in any cell)', crlf.data.status === 'ok' && standin.received.length === 3 && TSV_STATES.every(state => statesSent().includes(state)) && !statesSent().some(state => state.includes('\\r')), statesSent().join(' / '))
fresh()
const CSV = file('reds.csv', 'id,tail,rc\nui,"rc 137, killed by the runner\nafter the deadline",137\napi,"she said ""settled""",1\n')
const csv = await JevEvalTool.call(call([{ file: { path: CSV } }]) as never, context)
check('a CSV: a quoted comma and newline stay in the cell, a doubled quote is one quote', csv.data.status === 'ok' && standin.received.length === 2 && statesSent().includes(JSON.stringify({ tail: 'rc 137, killed by the runner\nafter the deadline', rc: '137' })) && statesSent().includes(JSON.stringify({ tail: 'she said "settled"', rc: '1' })), statesSent().join(' / '))
fresh()
const JSONL = file('reds.jsonl', '{"id":"ui","tail":"rc 137 — killed by the runner after the deadline","rc":137}\n\n{"id":"api","tail":"capture deadline exceeded; the last frame is empty","rc":"1","flaky":false}\n')
const jsonl = await JevEvalTool.call(call([{ file: { path: JSONL } }]) as never, context)
check('JSONL: one item per line, blank lines skipped, numbers and booleans spelled out, the id key the row key', jsonl.data.status === 'ok' && standin.received.length === 2 && statesSent().includes(TSV_STATES[0]!) && statesSent().includes(JSON.stringify({ tail: 'capture deadline exceeded; the last frame is empty', rc: '1', flaky: 'false' })) && rowsOf(jsonl.data.text).map(r => r.split(' | ')[0]).join(',') === 'ui,api', jsonl.data.text)
fresh()
const inlineTable = { table: { columns: ['id', 'tail', 'rc'], rows: [['ui', 'rc 137 — killed by the runner after the deadline', '137'], ['api', 'capture deadline exceeded; the last frame is empty', '1'], ['x', 'expected the row "settled", the frame reads "settling"', '1']] } }
const table = await JevEvalTool.call(call([inlineTable]) as never, context)
check('an inline table: one request per row, the columns the fact names, the id column the row key', table.data.status === 'ok' && standin.received.length === 3 && TSV_STATES.every(state => statesSent().includes(state)) && rowsOf(table.data.text).map(r => r.split(' | ')[0]).join(',') === 'ui,api,x', table.data.text)
check('its source line names the inline table and its rows', table.data.text.split('\n').at(-1) === 'from the inline table at evidence[0] (ids from column id): 3 rows', table.data.text.split('\n').at(-1))
fresh()
const explicit = await JevEvalTool.call(call([{ table: { columns: ['key', 'tail'], rows: [['a1', 'rc 137'], ['b2', 'rc 0']], id_column: 'key' } }]) as never, context)
check('id_column names another column as the key; it is left out of the state', explicit.data.status === 'ok' && statesSent().join(',') === '{"tail":"rc 137"},{"tail":"rc 0"}' && rowsOf(explicit.data.text).map(r => r.split(' | ')[0]).join(',') === 'a1,b2', explicit.data.text)
fresh()
const noId = await JevEvalTool.call(call([{ table: { columns: ['tail'], rows: [['rc 137'], ['rc 0']] } }, 'a paragraph', { fact: 'a record' }]) as never, context)
check('without an id column the rows are keyed by position over the whole expanded list', rowsOf(noId.data.text).map(r => r.split(' | ')[0]).join(',') === '#1,#2,#3,#4' && standin.received.length === 4, noId.data.text)

section('§3 a text file is one item; format "paragraphs" splits it; the format is the extension\'s unless said')
fresh()
const TXT = file('report.txt', 'first paragraph\nstill the first\n\nsecond paragraph\n\n\nthird\n')
const txt = await JevEvalTool.call(call([{ file: { path: TXT } }]) as never, context)
check('a .txt file is ONE request whose state is the whole file as the fact text, keyed #1', txt.data.status === 'ok' && standin.received.length === 1 && stateOf(0) === JSON.stringify({ text: readFileSync(TXT, 'utf8') }) && rowsOf(txt.data.text)[0]?.startsWith('#1 | ') === true, txt.data.text)
fresh()
const paragraphs = await JevEvalTool.call(call([{ file: { path: TXT, format: 'paragraphs' } }]) as never, context)
check('format paragraphs: three requests, one per blank-line-separated paragraph', paragraphs.data.status === 'ok' && standin.received.length === 3 && statesSent().join(',') === '{"text":"first paragraph\\nstill the first"},{"text":"second paragraph"},{"text":"third"}', statesSent().join(' / '))
fresh()
const asText = await JevEvalTool.call(call([{ file: { path: TSV, format: 'text' } }]) as never, context)
check('an explicit format wins over the extension: the TSV as text is one item', asText.data.status === 'ok' && standin.received.length === 1 && stateOf(0) === JSON.stringify({ text: readFileSync(TSV, 'utf8') }), asText.data.text)
fresh()
const DAT = file('reds.dat', 'id\ttail\nui\trc 137\n')
const dat = await JevEvalTool.call(call([{ file: { path: DAT, format: 'tsv' } }]) as never, context)
check('an unknown extension with an explicit format parses as that format', dat.data.status === 'ok' && standin.received.length === 1 && stateOf(0) === '{"tail":"rc 137"}', dat.data.text)

section('§4 refusals: each names the file and the row; nothing is read past the fault and nothing is sent')
const refused = async (label: string, evidence: unknown[], words: RegExp): Promise<void> => {
  fresh()
  const out = await JevEvalTool.call(call(evidence) as never, context)
  check(`${label}: refused with the words`, out.data.status === 'refused' && out.data.text.startsWith('JEV — | status=refused | ') && words.test(out.data.text), out.data.text)
  check(`${label}: nothing sent, nothing counted`, standin.received.length === 0 && jevLedgerSnapshot().attempts === 0)
}
const RAGGED = file('ragged.tsv', 'id\ttail\trc\nui\trc 137\t137\napi\tonly two\n')
await refused('a ragged row', [{ file: { path: RAGGED } }], /evidence\[0\] \(ragged\.tsv line 3\) has 2 cells where the header has 3; a row is never padded or cut/)
await refused('a duplicate id between a file row and an inline record', [{ id: 'api', tail: 'inline' }, { file: { path: TSV } }], /evidence\[1\] \(reds\.tsv line 3\) id "api" is already the row key of evidence\[0\]/)
await refused('a duplicate id between two file rows', [{ file: { path: file('dup.tsv', 'id\ttail\nsame\ta\nsame\tb\n') } }], /evidence\[0\] \(dup\.tsv line 3\) id "same" is already the row key of evidence\[0\] \(dup\.tsv line 2\)/)
const BIG = file('big.tsv', `id\ttail\n${'x'.repeat(MAX_FILE_BYTES + 1)}`)
await refused('a file over the byte cap, measured before reading', [{ file: { path: BIG } }], new RegExp(`evidence\\[0\\]\\.file\\.path .*big\\.tsv is ${MAX_FILE_BYTES + 9} bytes; a file of evidence is at most ${MAX_FILE_BYTES} bytes \\(measured before reading\\); nothing was read`))
const MANY = file('many.tsv', `id\ttail\n${Array.from({ length: MAX_ROWS + 1 }, (_, i) => `r${i}\ttail ${i}`).join('\n')}\n`)
await refused('an expansion over the row cap names the count and the cap', [{ file: { path: MANY } }], new RegExp(`the files and tables expand to ${MAX_ROWS + 1} rows \\(many\\.tsv ${MAX_ROWS + 1}\\); a call takes at most ${MAX_ROWS} rows from files and tables; nothing was read further and nothing was sent`))
await refused('the row cap counts every file and table together', [{ file: { path: TSV } }, { table: { columns: ['tail'], rows: Array.from({ length: MAX_ROWS - 2 }, (_, i) => [`t${i}`]) } }], new RegExp(`the files and tables expand to ${MAX_ROWS + 1} rows \\(reds\\.tsv 3, the inline table at evidence\\[1\\] ${MAX_ROWS - 2}\\); a call takes at most ${MAX_ROWS} rows`))
await refused('a missing path', [{ file: { path: join(DIR, 'absent.tsv') } }], /evidence\[0\]\.file\.path .*absent\.tsv does not exist/)
mkdirSync(join(DIR, 'a-dir'))
await refused('a directory', [{ file: { path: join(DIR, 'a-dir') } }], /evidence\[0\]\.file\.path .*a-dir is a directory, not a file/)
await refused('a path with a NUL byte', [{ file: { path: `${TSV}\0` } }], /evidence\[0\]\.file\.path contains a NUL byte/)
await refused('a file holding a NUL byte', [{ file: { path: file('binary.tsv', 'id\ttail\nui\tr\0c\n') } }], /evidence\[0\] \(binary\.tsv\) holds a NUL byte; a file of evidence is text/)
await refused('an empty file', [{ file: { path: file('empty.txt', '') } }], /evidence\[0\] \(empty\.txt\) is empty/)
await refused('a markdown file without a pipe table', [{ file: { path: file('prose.md', '# title\n\njust prose\n') } }], /evidence\[0\] \(prose\.md\) has no pipe table[^;]*; pass format "text" to send it as one item/)
await refused('a JSONL line that is not an object', [{ file: { path: file('bad.jsonl', '{"tail":"ok"}\n[1,2]\n') } }], /evidence\[0\] \(bad\.jsonl line 2\) is not a JSON object/)
await refused('a JSONL value that is nested', [{ file: { path: file('nested.jsonl', '{"tail":{"deep":1}}\n') } }], /evidence\[0\] \(nested\.jsonl line 1\) key "tail" holds an object; a fact is a string/)
await refused('an id cell that is not a valid id', [{ file: { path: file('badid.tsv', 'id\ttail\nu i\trc\n') } }], /evidence\[0\] \(badid\.tsv line 2\) id "u i" is not letters, digits, _ and - of at most 64 characters/)
await refused('an explicit id_column the header lacks', [{ file: { path: TSV, id_column: 'key' } }], /evidence\[0\] \(reds\.tsv\) has no column "key"/)
await refused('a table with only an id column', [{ file: { path: file('idonly.tsv', 'id\nui\n') } }], /evidence\[0\] \(idonly\.tsv\) needs a fact column besides "id"/)
await refused('an empty header name', [{ file: { path: file('blankcol.tsv', 'id\t\nui\tx\n') } }], /evidence\[0\] \(blankcol\.tsv\) header column 2 is empty/)
await refused('a header that names a column twice', [{ file: { path: file('dupcol.tsv', 'id\ttail\ttail\nui\tx\ty\n') } }], /evidence\[0\] \(dupcol\.tsv\) header names "tail" twice/)
await refused('id_column on a text file', [{ file: { path: TXT, id_column: 'id' } }], /evidence\[0\] \(report\.txt\) format text has no columns; drop id_column/)
const relative = await JevEvalTool.call(call([{ file: { path: 'reds.tsv' } }]) as never, context)
check('a relative path resolves against the working directory, as Read resolves it (here: not found there)', relative.data.status === 'refused' && new RegExp(`evidence\\[0\\]\\.file\\.path ${process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/reds\\.tsv does not exist`).test(relative.data.text), relative.data.text)
const inlineRagged = call([{ table: { columns: ['id', 'tail'], rows: [['ui', 'x'], ['api']] } }])
check('an inline ragged table is refused at the schema, naming the row', !parse(inlineRagged).success && /evidence\[0\]/.test(refusal(inlineRagged)) && /table row 2\) has 1 cell where the header has 2/.test(refusal(inlineRagged)), refusal(inlineRagged))
const inlineDup = call([{ id: 'ui', tail: 'x' }, { table: { columns: ['id', 'tail'], rows: [['ui', 'y']] } }])
check('an inline table id that repeats a record id is refused at the schema', !parse(inlineDup).success && /evidence\[1\]/.test(refusal(inlineDup)) && /id "ui" is already the row key of evidence\[0\]/.test(refusal(inlineDup)), refusal(inlineDup))
const badShape = call([{ file: 'reds.tsv' }])
check('{file:"<string>"} is a named fact called file, not a file item (the value of file is an object)', parse(badShape).success && standin.received.length === 0)
const notAnItem = call([42])
check('a non-item refusal names all four forms', /paragraph/.test(refusal(notAnItem)) && /named facts/.test(refusal(notAnItem)) && /"file"/.test(refusal(notAnItem)) && /"table"/.test(refusal(notAnItem)), refusal(notAnItem))

section('§5 the pace and the budget count every row as today: rows past the pace read not sent')
fresh()
setJevPacePerMinute(2)
const paced = await JevEvalTool.call(call([{ file: { path: TSV } }]) as never, context)
const pacedRows = rowsOf(paced.data.text)
check('with a pace of 2 the first two rows are sent and the third reads not sent — pace hit', paced.data.status === 'ok' && standin.received.length === 2 && pacedRows.length === 3 && / \| not sent — pace hit/.test(pacedRows[2]!) && pacedRows[2]!.startsWith('x | '), paced.data.text)
setJevPacePerMinute(100)

section('§6 a file item passes the Read rules before anything is read: deny rules, ask rules and the working-directory boundary')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const ctxWith = (extra: Record<string, unknown>): unknown => ({ getAppState: () => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), ...extra } }) })
const denied = await JevEvalTool.checkPermissions(call([{ file: { path: TSV } }]) as never, ctxWith({ alwaysDenyRules: { session: [`Read(/${DIR}/**)`] } }) as never)
check('a Read deny rule on the file\'s directory denies the call, naming the path', denied.behavior === 'deny' && /Permission to read .*reds\.tsv has been denied/.test((denied as { message?: string }).message ?? ''), JSON.stringify(denied))
const asked = await JevEvalTool.checkPermissions(call([{ file: { path: TSV } }]) as never, ctxWith({ alwaysAskRules: { session: [`Read(/${DIR}/**)`] } }) as never)
check('a Read ask rule asks, naming the path', asked.behavior === 'ask' && /reds\.tsv requires confirmation/.test((asked as { message?: string }).message ?? ''), JSON.stringify(asked))
const outsidePath = join(WORLD, 'outside.tsv')
writeFileSync(outsidePath, readFileSync(TSV))
const outside = await JevEvalTool.checkPermissions(call([{ file: { path: outsidePath } }]) as never, ctxWith({}) as never)
check('a file outside the starting folder asks (the boundary Read keeps)', outside.behavior === 'ask', JSON.stringify(outside))
const inside = await JevEvalTool.checkPermissions(call([{ file: { path: TSV } }]) as never, ctxWith({}) as never)
check('a file inside the starting folder is allowed', inside.behavior === 'allow', JSON.stringify(inside))
const inlineOnly = await JevEvalTool.checkPermissions(call([{ id: 'ui', tail: 'rc 137' }, inlineTable, 'a paragraph']) as never, ctxWith({ alwaysDenyRules: { session: [`Read(/${DIR}/**)`] } }) as never)
check('a call without a file item is the default allow: no path, no rule read', inlineOnly.behavior === 'allow')
const second = await JevEvalTool.checkPermissions(call([{ id: 'ui', tail: 'rc 137' }, { file: { path: MD } }, { file: { path: TSV } }]) as never, ctxWith({ alwaysDenyRules: { session: [`Read(/${TSV})`] } }) as never)
check('every file item is checked: the second file\'s deny rule denies the call', second.behavior === 'deny' && /reds\.tsv/.test((second as { message?: string }).message ?? ''), JSON.stringify(second))
const source = readFileSync(join(ROOT, 'src/tools/JevEvalTool/JevEvalTool.ts'), 'utf8')
check('the only permission call in the tool source is the Read ladder; it answers no permission request itself', /checkReadPermissionForTool/.test(source) && !/validateInput/.test(source) && !/classifierDecision/.test(source))

section('§7 the wire schema and the prompt say the shapes and the size rule; the inline-only result is unchanged')
const jsonSchema = JSON.stringify(zodToJsonSchema(schema as never))
check('the evidence item union still opens with the paragraph string', /"anyOf":\[\{"type":"string"/.test(jsonSchema))
check('the record arm with its string values and row id is still there', /"additionalProperties":\{"type":"string"\}/.test(jsonSchema) && /"id":\{"description":"[^"]*row/.test(jsonSchema))
check('a file arm with path, format and id_column', /"file":\{/.test(jsonSchema) && /"path":\{/.test(jsonSchema) && /"format":\{/.test(jsonSchema) && /"id_column":\{/.test(jsonSchema))
check('a table arm with columns and rows', /"table":\{/.test(jsonSchema) && /"columns":\{/.test(jsonSchema) && /"rows":\{/.test(jsonSchema))
check('the format enum names the six formats', ['tsv', 'csv', 'markdown', 'jsonl', 'text', 'paragraphs'].every(f => jsonSchema.includes(`"${f}"`)))
const evidenceDescription = (zodToJsonSchema(schema as never) as { properties: { evidence: { description: string } } }).properties.evidence.description
check(`the evidence description states the size rule with its numbers (${MAX_ROWS} rows, ${MAX_FILE_BYTES} bytes) and the refusal`, evidenceDescription.includes(String(MAX_ROWS)) && evidenceDescription.includes(String(MAX_FILE_BYTES)) && /refus/.test(evidenceDescription), evidenceDescription)
check('the evidence description names the four forms', /paragraph/.test(evidenceDescription) && /named facts/.test(evidenceDescription) && /file/.test(evidenceDescription) && /table/.test(evidenceDescription))
check('the prompt names the file and the table shapes with the per-row rule and the id column', /"file"/.test(JEV_EVAL_PROMPT) && /"table"/.test(JEV_EVAL_PROMPT) && /one item per row/.test(JEV_EVAL_PROMPT) && /id/.test(JEV_EVAL_PROMPT))
check('the prompt states the caps with the same numbers', JEV_EVAL_PROMPT.includes(`${MAX_ROWS} rows`) && JEV_EVAL_PROMPT.includes(`${MAX_FILE_BYTES} bytes`))
check('the prompt still forbids a whole source file and the transcript, now beside a file of filtered rows', /a file of filtered rows/.test(JEV_EVAL_PROMPT) && /never a whole source file, never the transcript/.test(JEV_EVAL_PROMPT))
check('the prompt keeps exactly one complete example line', JEV_EVAL_PROMPT.split('\n').filter(line => line.startsWith('{"goal":')).length === 1)
check('the prompt still says what leaves the machine', /leaves the machine under the selected road's data policy/.test(JEV_EVAL_PROMPT))
fresh()
standin.next({ status: 200, body: { model: 'jev-1.13.0', answers: { skew: { type: 'noul', noul: 0.88 } }, usage: { input_tokens: 412, output_tokens: 20 } } })
const inlineResult = await jevEvalCall({ goal: 'a bounded decision', evidence: [{ fact: 'the lease released early on 3 of 40 runs' }], questions: [{ id: 'skew', kind: 'noul', ask: 'Is `fact` enough on its own?' }] })
check('an inline-only result is the same three lines as before: header, columns, the row — no source line', inlineResult.text === 'JEV jev-1.13.0 | 1 item × 1 question | in 412 tok | $0.000017 | floor 0.6 | ok\nitem | skew (noul)\n#1 | .88', inlineResult.text)

await standin.close()
resetJevLedger()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
