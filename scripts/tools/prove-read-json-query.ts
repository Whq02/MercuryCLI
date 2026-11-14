import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const given = process.env.READ_JSON_PROOF_HOME
if (!given) {
  const base = process.env.RP_SCRATCH ?? process.env.MERCURY_TMPDIR ?? process.env.MERCURY_CONFIG_DIR
  if (!base) throw new Error('The proof needs its scratch root')
  const home = realpathSync(mkdtempSync(join(base, 'json-match-')))
  try {
    const result = spawnSync(process.execPath, [import.meta.filename], { stdio: 'inherit', timeout: 30000, killSignal: 'SIGKILL', env: { ...process.env, HOME: home, USERPROFILE: home, READ_JSON_PROOF_HOME: home, MERCURY_CONFIG_DIR: join(home, '.mercury'), MERCURY_TMPDIR: join(home, 'tmp') } })
    process.exitCode = result.status ?? 1
  } finally { rmSync(home, { recursive: true, force: true }) }
} else {
  if (homedir() !== given) throw new Error('The runtime did not take the proof home')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  process.env.MERCURY_BARE = '1'
  mkdirSync(join(given, 'tmp'), { recursive: true })
  const src = process.env.PROVE_SRC ?? resolve(import.meta.dir, '../../src')
  const { setCwdState, setOriginalCwd } = await import(`${src}/bootstrap/state.ts`)
  setCwdState(given); setOriginalCwd(given)
  const { FileReadTool } = await import(`${src}/tools/FileReadTool/FileReadTool.ts`)
  const { getEmptyToolPermissionContext } = await import(`${src}/Tool.ts`)
  const { createFileStateCacheWithSizeLimit } = await import(`${src}/utils/fileStateCache.ts`)
  let passed = 0, failed = 0
  const check = (name: string, ok: boolean, detail = '') => { ok ? passed++ : failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` ${detail.slice(0, 1200)}`}`) }
  const context = (rules = getEmptyToolPermissionContext()) => ({ readFileState: createFileStateCacheWithSizeLimit(100), fileReadingLimits: undefined as { maxTokens: number; maxSizeBytes: number } | undefined, messages: [], abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: rules }), userModified: false, updateFileHistoryState: () => {}, dynamicSkillDirTriggers: new Set<string>(), nestedMemoryAttachmentTriggers: new Set<string>() })
  const file = (name: string, text: string) => { const path = join(given, name); writeFileSync(path, text); return path }
  const invoke = async (file_path: string, extra: Record<string, unknown> = {}, ctx = context()) => {
    const input = { file_path, ...extra }
    try {
      const valid = await FileReadTool.validateInput(input, ctx)
      if (!valid.result) return { body: valid.message, ctx, error: true }
      const permission = await FileReadTool.checkPermissions(input, ctx)
      if (permission.behavior === 'deny') return { body: permission.message, ctx, error: true }
      const reply = await FileReadTool.call(input, ctx)
      const body = String(FileReadTool.mapToolResultToToolResultBlockParam(reply.data, 'json').content)
      return { body, ctx, data: reply.data, error: false }
    } catch (error) { return { body: String(error), ctx, error: true } }
  }
  const ask = (path: string, query: string, modifiers = '', extra: Record<string, unknown> = {}, ctx = context()) => invoke(`${path}#read?${modifiers}${modifiers ? '&' : ''}q=${query}`, extra, ctx)
  const next = (body: string): string | null => {
    const match = /\[values [^\n]+?Read\(file_path: ("(?:\\.|[^"\\])*")\) continues from there\]/.exec(body)
    return match ? JSON.parse(match[1]!) : null
  }
  const rows = file('rows.jsonl', '\ufeff{"n":1,"s":"no"}\n{"n":2,"s":"yes","big":9007199254740993123456789}\n{"n":3,"s":"yes"}\n{"n":4,"s":"yes"}\n')
  const projected = await ask(rows, 'select(.s == "yes") | {n:(.n+1),r:(.n%2),big}', 'compact=1&limit=2')
  check('M01 projection, pipes, selection, construction and arithmetic use embedded jq', projected.body.includes('{"n":3,"r":0,"big":9007199254740993123456789}') && projected.body.includes('{"n":4,"r":1,"big":null}'), projected.body)
  check('M04 a stream page contains whole values only', projected.body.includes('results: 1-2') && !projected.body.includes('{"n":5,'), projected.body)
  const continued = next(projected.body)
  check('M05 continuation preserves the filter verbatim', continued !== null && continued.endsWith('q=select(.s == "yes") | {n:(.n+1),r:(.n%2),big}'), projected.body)
  if (continued) {
    const read = await invoke(continued)
    check('M04 a followed stream page begins at the next value', read.body.includes('{"n":5,"r":0,"big":null}') && read.body.includes('state: complete'), read.body)
  }
  check('M09 query output has neither anchor nor source coverage', !projected.body.includes('(anchor:') && !projected.ctx.readFileState.has(rows))
  const arrayFile = file('array.json', '[{"a":1,"b":2},{"a":3,"b":4},{"a":5,"b":6}]')
  const array = await ask(arrayFile, '.', 'offset=1&limit=1&compact=1')
  check('M04 one array is paged by elements without losing object members', array.body.includes('[{"a":3,"b":4}]') && array.body.includes('results: 2-2'), array.body)
  const arrayNext = next(array.body)
  if (arrayNext) check('M04 array continuation retains its array shape', (await invoke(arrayNext)).body.includes('[{"a":5,"b":6}]'))
  else check('M04 array continuation exists', false, array.body)
  const text = file('text.json', '"a  \\n"')
  const raw = await ask(text, '.', 'raw=1')
  check('M06 raw output retains meaningful trailing spaces and newlines', raw.body.includes('\na  \n\n'), raw.body)
  const large = file('large.json', '[9007199254740993123456789,9007199254740993123456791]')
  for (const format of ['compact=1', 'compact=0']) {
    const got = await ask(large, '.', `offset=1&limit=1&${format}`)
    check(`M06 numeric literals survive array paging (${format})`, got.body.includes('9007199254740993123456791') && !got.body.includes('9007199254740993000000000'), got.body)
  }
  const operators = await ask(file('operators.json', '{"count":25,"x":"a&b%3F+?#read?q=x"}'), '.count%10, .count+1, .x # literal %20 & ? +', 'compact=1')
  check('M05 modulo, plus, percent, ampersand and comments stay literal', operators.body.includes('\n5\n26\n"a&b%3F+?#read?q=x"\n'), operators.body)
  const scalar = file('scalar.json', '{"n":7}')
  for (const name of ['saved.json.bak', 'saved.jsonl.old', 'rows.ndjson', 'no-extension', 'book.ipynb', 'payload.data']) {
    const got = await ask(file(name, '{"n":7}'), '.n')
    check(`M02 query target admission: ${name}`, got.body.includes('\n7\n') && got.body.includes('target: JSON query'), got.body)
  }
  const ordinary = await invoke(scalar)
  check('M02 a whole ordinary JSON read is unchanged and offers no discovery', ordinary.body.includes('1\t{"n":7}') && ordinary.body.includes('(anchor:') && !ordinary.body.includes('To ask a question'), ordinary.body)
  const partial = await invoke(rows, { offset: 2, limit: 1 })
  check('discovery appears only on a partial JSON read and names that file', partial.body.includes(`To ask a question of it instead: Read(file_path: ${JSON.stringify(`${rows}#read?q=<jq filter>`)})`), partial.body)
  const long = await invoke(file('one-line.json', JSON.stringify({ text: 'z'.repeat(2500) })))
  check('discovery also appears after a clipped JSON source line', long.body.includes('truncated') && long.body.includes('To ask a question'), long.body)
  const rangedSource = await invoke(rows, { ranges: ['1', '3'] })
  check('discovery follows a disjoint ordinary JSON line view', rangedSource.body.includes('To ask a question'), rangedSource.body)
  const smallBudget = { ...context(), fileReadingLimits: { maxTokens: 25000, maxSizeBytes: 4 } }
  const overSize = await invoke(scalar, {}, smallBudget)
  check('discovery follows the existing JSON size remedy', overSize.error && overSize.body.includes('To ask a question'), overSize.body)
  const ordinaryText = await invoke(file('plain.txt', 'one\ntwo\n'), { limit: 1 })
  check('a partial non-JSON answer gains no discovery line', !ordinaryText.body.includes('To ask a question'))
  if (process.platform !== 'win32') {
    const literal = `${scalar}#read?q=.n`
    writeFileSync(literal, 'literal file\n')
    const got = await invoke(literal)
    check('M03 an existing literal pathname wins', got.body.includes('1\tliteral file') && !got.body.includes('target: JSON query'), got.body)
    rmSync(literal)
  }
  const media = file('image.png', 'not an image')
  const mediaRaw = await invoke(media), mediaQuery = await ask(media, '.')
  check('M03 an image keeps its original road', !mediaQuery.body.includes('target: JSON query') && mediaQuery.error === mediaRaw.error, mediaQuery.body)
  const resource = await ask(`mercury://file/${scalar}`, '.n')
  check('M10 a file resource keeps its public identity', resource.body.includes(`source: mercury://file/${scalar}`) && resource.body.includes('\n7\n'), resource.body)
  const { storeArtifact } = await import(`${src}/utils/artifacts/store.ts`)
  const artifact = await storeArtifact({ scope: 'query-proof', name: 'values.json', content: '[10,20,30]' })
  const artifactSource = `mercury://artifact/query-proof/${artifact.id}`
  const artifactPage = await ask(artifactSource, '.', 'limit=1&compact=1')
  const artifactNext = next(artifactPage.body)
  check('M10 stored artifact identity survives a query and continuation', artifact.id !== null && artifactPage.body.includes(`source: ${artifactSource}`) && artifactNext !== null && (await invoke(artifactNext)).body.includes('[20]'), artifactPage.body)
  const { zipSync, strToU8 } = await import('fflate')
  const archive = join(given, 'values.zip')
  writeFileSync(archive, zipSync({ 'values.json': strToU8('[10,20,30]') }))
  const archivePage = await ask(`${archive}:values.json`, '.', 'limit=1&compact=1')
  const archiveNext = next(archivePage.body)
  check('M10 an archive entry retains its target and follows the same page', archivePage.body.includes(`source: ${archive}:values.json`) && archiveNext !== null && (await invoke(archiveNext)).body.includes('[20]'), archivePage.body)
  const wide = await ask(file('wide.json', JSON.stringify({ text: 'w'.repeat(200000) })), '.text', 'raw=1', {}, { ...context(), fileReadingLimits: { maxTokens: 600, maxSizeBytes: 4 } })
  const spilled = /complete result page \(\d+ bytes\) is at (.+?); Read/.exec(wide.body)?.[1]
  check('output room spills a complete value instead of imposing a capture ceiling', spilled !== undefined && readFileSync(spilled, 'utf8') === `${'w'.repeat(200000)}\n` && wide.body.includes('Only part of the generated output'), wide.body)
  const resourceOwn = await invoke(`mercury://file/${scalar}?q=n`)
  check('M03 resource-owned q keeps its original interpretation', resourceOwn.body.includes('target: resource') && !resourceOwn.body.includes('target: JSON query'), resourceOwn.body)
  for (const selector of ['compact=1', 'q=', 'query=']) {
    const got = await invoke(`${scalar}#read?${selector}`)
    check(`M07 identity is implicit for ${selector}`, got.body.includes('7') && got.body.includes('state: complete'), got.body)
  }
  const invalid = await ask(scalar, '. | !')
  check('M07 a malformed filter is a bounded query error', invalid.body.includes('state: partial-error') && invalid.body.includes('syntax error') && invalid.body.length < 12000, invalid.body)
  const mixed = await ask(file('invalid.jsonl', '{"n":1}\n{bad}\n'), '.n')
  check('M07 valid values before a parse error are marked partial', mixed.body.includes('\n1\n') && mixed.body.includes('state: partial-error') && mixed.body.includes('parse error'), mixed.body)
  const bom = await ask(file('bom.json', '\ufeff{"s":"a\ufeffb"}'), '.s')
  check('M08 one leading BOM is accepted and string-internal BOM is data', bom.body.includes('"a\ufeffb"') && bom.body.includes('state: complete'), bom.body)
  for (const [name, content] of [['double', '\ufeff\ufeff{}'], ['middle', '{}\n\ufeff{}']]) {
    const got = await ask(file(`${name}.jsonl`, content), '.')
    check(`M08 ${name} BOM is not repaired`, got.body.includes('state: partial-error') && got.body.includes('parse error'), got.body)
  }
  const minus = await ask(scalar, '-1')
  check('M01 a minus-leading filter is data rather than a flag', minus.body.includes('\n-1\n') && minus.body.includes('state: complete'), minus.body)
  const definition = await ask(file('regex.json', '"word42"'), 'def digits: capture("(?<n>[0-9]+)").n; digits')
  check('M01 definitions and jq regex are available', definition.body.includes('"42"'), definition.body)
  const aggregate = await ask(rows, '[., inputs] | map(.n) | sort | reduce .[] as $n (0; . + $n)')
  check('M01 input streams, sorting and reduction retain jq semantics', aggregate.body.includes('\n10\n'), aggregate.body)
  const generated = await ask(arrayFile, '.', 'limit=3', { ranges: ['2-3'] })
  check('M09 ranges address generated lines without source anchors', generated.body.includes('Generated output lines 2-3') && generated.body.includes('2\t') && !generated.body.includes('(anchor:'), generated.body)
  const secret = file('hidden.json', '{"secret":"outside-source"}')
  const imports = await ask(scalar, `import ${JSON.stringify(secret)} as $x; $x`)
  check('M11 a jq module cannot read host files beyond the named source', imports.body.includes('module not found') && !imports.body.includes('outside-source'), imports.body)
  process.env.READ_QUERY_SECRET_WITNESS = 'host-environment-secret'
  const env = await ask(scalar, 'env')
  check('M11 jq env has no host credentials', !env.body.includes('host-environment-secret') && !env.body.includes('READ_QUERY_SECRET_WITNESS'), env.body)
  const deniedFile = file('denied.json', '{"n":1}')
  const denied = await ask(deniedFile, '.n', '', {}, context({ ...getEmptyToolPermissionContext(), alwaysDenyRules: { session: ['Read(denied.json)'] } }))
  check('M11 source deny rules apply before the query', denied.error && !denied.body.includes('target: JSON query'), denied.body)
  const absoluteRules = { ...getEmptyToolPermissionContext(), alwaysDenyRules: { session: [`Read(/${deniedFile})`] } }
  check('M11 the absolute source rule denies an ordinary read', (await invoke(deniedFile, {}, context(absoluteRules))).error)
  process.env.MERCURY_READ_TARGETS = '0'
  const disabledTarget = await ask(`mercury://file/${deniedFile}`, '.n', '', {}, context(absoluteRules))
  delete process.env.MERCURY_READ_TARGETS
  check('M11 a disabled resource route cannot bypass source permissions through a query', !disabledTarget.body.includes('target: JSON query'), disabledTarget.body)
  process.env.MERCURY_REFS = '0'
  const disabledRef = await ask(`mercury://file/${scalar}`, '.n')
  delete process.env.MERCURY_REFS
  check('M03 a disabled resource owner retains its own answer', !disabledRef.body.includes('target: JSON query'), disabledRef.body)
  const url = await ask('https://example.invalid/data.json?own=value', '.n')
  check('M03 URL targets still delegate to WebFetch without fetching', url.body.includes('owner: WebFetch') && !url.body.includes('target: JSON query'), url.body)
  for (const selector of ['sql=SELECT 1', 'view=profile']) {
    process.env.MERCURY_READ_TARGETS = '0'
    const offSource = await invoke(`mercury://file/${deniedFile}`, {}, context(absoluteRules))
    const offQuery = await invoke(`mercury://file/${deniedFile}#read?${selector}`, {}, context(absoluteRules))
    delete process.env.MERCURY_READ_TARGETS
    check(`shared dispatch preserves the disabled target owner for ${selector}`, offSource.body === offQuery.body, offQuery.body)
    process.env.MERCURY_REFS = '0'
    const refSource = await invoke(`mercury://file/${scalar}`)
    const refQuery = await invoke(`mercury://file/${scalar}#read?${selector}`)
    delete process.env.MERCURY_REFS
    check(`shared dispatch preserves the disabled references owner for ${selector}`, refSource.body === refQuery.body, refQuery.body)
    const urlSource = await invoke('https://example.invalid/data.json?own=value')
    const urlQuery = await invoke(`https://example.invalid/data.json?own=value#read?${selector}`)
    check(`shared dispatch preserves URL delegation for ${selector}`, urlSource.body === urlQuery.body, urlQuery.body)
  }
  if (process.platform !== 'win32') {
    const folder = join(given, 'mercury:')
    mkdirSync(folder)
    const hidden = join(folder, 'denied.json')
    writeFileSync(hidden, '{"private":91}')
    const rules = { ...getEmptyToolPermissionContext(), alwaysDenyRules: { session: [`Read(/${hidden})`] } }
    const invalidRef = await ask('mercury:///denied.json', '.private', '', {}, context(rules))
    check('M11 a malformed resource URI cannot become a local file alias', !invalidRef.body.includes('target: JSON query'), invalidRef.body)
  }
  const abortContext = context()
  const timer = setTimeout(() => abortContext.abortController.abort(new Error('proof cancellation')), 150)
  const started = performance.now()
  const aborted = await ask(scalar, 'until(false; .)', '', {}, abortContext)
  clearTimeout(timer)
  check('M11 a computation with no output is cancellable', aborted.error && aborted.body.includes('proof cancellation') && performance.now() - started < 5000, aborted.body)
  const queryTemp = join(process.env.MERCURY_TMPDIR!, 'json-queries')
  check('M11 error and cancellation leave no owned query temp files', !existsSync(queryTemp) || readdirSync(queryTemp).length === 0)
  check('queries leave every source byte unchanged', readFileSync(rows, 'utf8').startsWith('\ufeff{"n":1') && readFileSync(scalar, 'utf8') === '{"n":7}')
  console.log(`${passed}/${passed + failed} checks`)
  process.exitCode = failed ? 1 : 0
}
