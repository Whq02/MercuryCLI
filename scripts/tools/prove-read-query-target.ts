import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const given = process.env.READ_QUERY_PROOF_HOME
if (!given) {
  const base = process.env.RP_SCRATCH ?? process.env.MERCURY_TMPDIR ?? process.env.MERCURY_CONFIG_DIR
  if (!base) throw new Error('The proof needs its scratch home')
  mkdirSync(base, { recursive: true })
  const home = realpathSync(mkdtempSync(join(base, 'read-query-')))
  try {
    const child = spawnSync(process.execPath, [import.meta.filename], { stdio: 'inherit', env: { ...process.env, HOME: home, USERPROFILE: home, READ_QUERY_PROOF_HOME: home, MERCURY_CONFIG_DIR: join(home, '.mercury'), MERCURY_TMPDIR: join(home, 'tmp') } })
    process.exitCode = child.status ?? 1
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
} else {
  if (homedir() !== given) throw new Error('The runtime did not take the proof home')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  process.env.MERCURY_BARE = '1'
  const src = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
  const { FileReadTool } = await import(`${src}/tools/FileReadTool/FileReadTool.ts`)
  const { getEmptyToolPermissionContext } = await import(`${src}/Tool.ts`)
  const { createFileStateCacheWithSizeLimit } = await import(`${src}/utils/fileStateCache.ts`)
  const { setCwdState, setOriginalCwd } = await import(`${src}/bootstrap/state.ts`)
  setCwdState(given)
  setOriginalCwd(given)
  let passed = 0, failed = 0
  const check = (name: string, ok: boolean, detail = '') => { ok ? passed++ : failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` ${detail}`}`) }
  let rules = getEmptyToolPermissionContext()
  const context = {
    readFileState: createFileStateCacheWithSizeLimit(100), userModified: false, updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(), nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(), messages: [], getAppState: () => ({ toolPermissionContext: rules }),
  }
  const file = join(given, 'rows.jsonl')
  writeFileSync(file, '{"n":1}\n{"n":2}\n')
  const invoke = async (file_path: string) => {
    try {
      const input = { file_path }
      const valid = await FileReadTool.validateInput(input, context)
      if (!valid.result) return valid.message
      const permission = await FileReadTool.checkPermissions(input, context)
      if (permission.behavior === 'deny') return permission.message
      const reply = await FileReadTool.call(input, context)
      return String(FileReadTool.mapToolResultToToolResultBlockParam(reply.data, 'query').content)
    } catch (error) { return String(error) }
  }
  const routeFile = join(src, 'tools/FileReadTool/readQueryTarget.ts')
  check('shared query target module exists', existsSync(routeFile))
  if (existsSync(routeFile)) {
    const { parseReadQueryTarget, formatReadQueryTarget } = await import(routeFile)
    const parsed = parseReadQueryTarget(`${file}#read?raw=1&q=.n+1 % 2`)
    check('filter preserves plus and modulo verbatim', parsed?.parameters.q === '.n+1 % 2')
    check('source is separate from selector', parsed?.source === file)
    const query = '.x | select(. == "a&b%3F+?#read?q=x")'
    const encoded = formatReadQueryTarget(file, { q: query, compact: '1', offset: '2' })
    check('continuation keeps the terminal filter verbatim', parseReadQueryTarget(encoded)?.parameters.q === query && encoded.endsWith(`q=${query}`))
    check('unknown selector stays ordinary', parseReadQueryTarget(`${file}#read?unrelated=1`) === null)
    check('ordinary resource q retains its owner', parseReadQueryTarget('mercury://file/a.json?q=needle&lines=1-5') === null)
    const resource = parseReadQueryTarget('mercury://file/a.json?q=needle#read?q=.rows')
    check('resource query remains in source', resource?.source === 'mercury://file/a.json?q=needle')
    check('remote source peels without decoding path bytes', parseReadQueryTarget('ssh://host/a%3Fb.json#read?q=.x')?.source === 'ssh://host/a%3Fb.json')
    check('modifier-only selects query identity', parseReadQueryTarget(`${file}#read?compact=1`)?.parameters.compact === '1')
    check('Windows drive remains in source', parseReadQueryTarget('C:\\data\\rows.json#read?q=.x')?.source === 'C:\\data\\rows.json')
    check('archive entry remains in source', parseReadQueryTarget('/a.zip:rows.json#read?q=.x')?.source === '/a.zip:rows.json')
  }
  const response = await invoke(`${file}#read?q=.n`)
  check('Read dispatches JSON query entry', response.includes('target: JSON query'), response)
  check('entry identifies generated output', response.includes('not the file\'s bytes') && response.includes('no edit anchor') && response.includes('does not count as reading the file'), response)
  check('query creates no source read state', !context.readFileState.has(file))
  check('query emits no source anchor', !response.includes('(anchor:'))
  const raw = await invoke(file)
  check('ordinary JSON read keeps its original numbered bytes', raw.includes('1\t{"n":1}\n2\t{"n":2}'), raw)
  check('ordinary JSON read still grants read evidence', context.readFileState.has(file))
  if (process.platform !== 'win32') {
    const literal = `${file}#read?q=.literal`
    writeFileSync(literal, 'literal punctuation wins\n')
    const text = await invoke(literal)
    check('existing literal filename beats query punctuation', text.includes('1\tliteral punctuation wins') && !text.includes('target: JSON query'), text)
  }
  rules = { ...rules, alwaysDenyRules: { session: ['Read(rows.jsonl)'] } }
  const denied = await invoke(`${file}#read?q=.n`)
  check('query cannot evade a source deny rule', denied.includes('den') && !denied.includes('target: JSON query'), denied)
  const tool = readFileSync(join(src, 'tools/FileReadTool/FileReadTool.ts'), 'utf8')
  check('query routing remains lazy', tool.includes("import('./readQuery") && !/^import .*from ['"]\.\/readJson/m.test(tool))
  console.log(`${passed}/${passed + failed} checks`)
  process.exitCode = failed ? 1 : 0
}
