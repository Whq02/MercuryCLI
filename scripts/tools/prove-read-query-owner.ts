import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const given = process.env.READ_OWNER_PROOF_HOME
if (!given) {
  const base = process.env.RP_SCRATCH ?? process.env.MERCURY_TMPDIR ?? process.env.MERCURY_CONFIG_DIR
  if (!base) throw new Error('The proof needs its scratch root')
  const home = realpathSync(mkdtempSync(join(base, 'query-owner-')))
  try {
    const run = spawnSync(process.execPath, [script], { stdio: 'inherit', timeout: 20000, killSignal: 'SIGKILL', env: { ...process.env, HOME: home, USERPROFILE: home, READ_OWNER_PROOF_HOME: home, MERCURY_CONFIG_DIR: join(home, '.mercury'), MERCURY_TMPDIR: join(home, 'tmp') } })
    process.exitCode = run.status ?? 1
  } finally { rmSync(home, { recursive: true, force: true }) }
} else {
  if (homedir() !== given) throw new Error('The runtime did not take the proof home')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  process.env.MERCURY_BARE = '1'
  const src = process.env.PROVE_SRC ?? resolve(dirname(script), '../../src')
  const { FileReadTool } = await import(`${src}/tools/FileReadTool/FileReadTool.ts`)
  const { setCwdState, setOriginalCwd } = await import(`${src}/bootstrap/state.ts`)
  const { getEmptyToolPermissionContext } = await import(`${src}/Tool.ts`)
  const { createFileStateCacheWithSizeLimit } = await import(`${src}/utils/fileStateCache.ts`)
  setCwdState(given); setOriginalCwd(given)
  let passed = 0, failed = 0
  const check = (name: string, ok: boolean, detail = '') => { ok ? passed++ : failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` ${detail.slice(0, 500)}`}`) }
  const source = join(given, 'denied.json')
  writeFileSync(source, '{"private":91}')
  let rules = { ...getEmptyToolPermissionContext(), alwaysDenyRules: { session: [`Read(/${source})`] } }
  const read = async (file_path: string) => {
    const input = { file_path }
    const context = { messages: [], readFileState: createFileStateCacheWithSizeLimit(100), abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: rules }) }
    try {
      const valid = await FileReadTool.validateInput(input, context)
      if (!valid.result) return `REFUSED ${valid.message}`
      const permission = await FileReadTool.checkPermissions(input, context)
      if (permission.behavior === 'deny') return `REFUSED ${permission.message}`
      const result = await FileReadTool.call(input, context)
      return String(FileReadTool.mapToolResultToToolResultBlockParam(result.data, 'owner').content)
    } catch (error) { return String(error) }
  }
  check('the exact absolute rule denies the ordinary source', (await read(source)).startsWith('REFUSED'))
  for (const selector of ['q=.private', 'sql=SELECT private FROM secrets', 'view=profile']) {
    process.env.MERCURY_READ_TARGETS = '0'
    const named = `mercury://file/${source}`
    const before = await read(named)
    const after = await read(`${named}#read?${selector}`)
    delete process.env.MERCURY_READ_TARGETS
    check(`${selector}: the disabled target owner keeps its original answer`, before === after && !after.includes('target: JSON query'), after)
    rules = getEmptyToolPermissionContext()
    process.env.MERCURY_REFS = '0'
    const refBefore = await read(named), refAfter = await read(`${named}#read?${selector}`)
    delete process.env.MERCURY_REFS
    check(`${selector}: the disabled references owner keeps its original answer`, refBefore === refAfter && !refAfter.includes('target: JSON query'), refAfter)
    const url = 'https://example.invalid/file.json?original=value'
    const urlBefore = await read(url), urlAfter = await read(`${url}#read?${selector}`)
    check(`${selector}: URL delegation stays with WebFetch`, urlBefore === urlAfter && urlAfter.includes('owner: WebFetch'), urlAfter)
    const visible = { file_path: `${url}#read?${selector}` }
    FileReadTool.backfillObservableInput(visible)
    check(`${selector}: observable input keeps the URL owner`, visible.file_path === `${url}#read?${selector}`, visible.file_path)
    if (process.platform !== 'win32') {
      mkdirSync(join(given, 'mercury:'), { recursive: true })
      const literal = join(given, 'mercury:', 'denied.json')
      writeFileSync(literal, '{"private":92}')
      rules = { ...getEmptyToolPermissionContext(), alwaysDenyRules: { session: [`Read(/${literal})`] } }
      check(`${selector}: the malformed URI's literal fallback is actually denied`, (await read(literal)).startsWith('REFUSED'))
    }
    const malformed = 'mercury:///denied.json'
    const badBefore = await read(malformed), badAfter = await read(`${malformed}#read?${selector}`)
    check(`${selector}: malformed references never become local file aliases`, badBefore === badAfter && !badAfter.includes('target: JSON query'), badAfter)
    rules = { ...getEmptyToolPermissionContext(), alwaysDenyRules: { session: [`Read(/${source})`] } }
  }
  console.log(`${passed}/${passed + failed} checks`)
  process.exitCode = failed ? 1 : 0
}
