import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(process.argv[2] ?? join(import.meta.dir, '../..'))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'own-secret-read-')))
const config = join(scratch, 'config')
const project = join(scratch, 'project')
for (const path of [config, project]) mkdirSync(path, { recursive: true })
process.env.MERCURY_CONFIG_DIR = config
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
process.env.BROWSER = '/usr/bin/true'
const before = process.cwd()
process.chdir(project)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const load = (file: string) => import(pathToFileURL(join(root, file)).href)
const { getEmptyToolPermissionContext } = await load('src/Tool.ts')
const { decideToolPermission } = await load('src/utils/permissions/decision/engine.ts')
const { FileReadTool } = await load('src/tools/FileReadTool/FileReadTool.ts')
const { InspectTool } = await load('src/tools/InspectTool/InspectTool.ts')
const { fileAdapter } = await load('src/services/resources/adapters/file.ts')
const { GrepTool } = await load('src/tools/GrepTool/GrepTool.ts')
const { GlobTool } = await load('src/tools/GlobTool/GlobTool.ts')
const { glob } = await load('src/utils/glob.ts')
const { BashTool } = await load('src/tools/BashTool/BashTool.tsx')
const { PowerShellTool } = await load('src/tools/PowerShellTool/PowerShellTool.tsx')
const { runWithCwdOverride } = await load('src/utils/cwd.ts')
const { setAuthScope, clearAuthScope } = await load('src/utils/envUtils.ts')
const { plainTextStorage } = await load('src/utils/secureStorage/plainTextStorage.ts')
const providerSecrets = await load('src/utils/router/providerSecrets.ts')
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = '') {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function context(mode: string, allow: string[] = [], ask: string[] = []) {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, alwaysAllowRules: { userSettings: allow }, alwaysAskRules: { userSettings: ask } }, tasks: {}, sessionHooks: new Map() }
  return { getAppState: () => state, setAppState: () => {}, abortController: new AbortController(), readFileState: new Map(), messages: [], options: { tools: [] } }
}
const modes = ['default', 'implement', 'sovereign']
const names = ['.credentials.json', '.provider-secrets.json', '.openai-auth.json', '.openrouter-auth.json', '.gemini-auth.json', '.huggingface-auth.json', '.moonshot-auth.json', '.xai-auth.json', '.meta-auth.json', '.nous-auth.json', '.future-auth.json', 'browser-secrets.json', '.credentials.json.corrupt.1']
const needle = 'fixture-private-value-not-a-real-token'
for (const name of names) writeFileSync(join(config, name), JSON.stringify({ value: needle }) + '\n', { mode: 0o600 })
symlinkSync(join(config, '.credentials.json'), join(project, 'alias.txt'))
symlinkSync(join(project, 'alias.txt'), join(project, 'alias-hop.txt'))
symlinkSync(config, join(project, 'linked-config'))
const secretPaths = [String.raw`C:\Users\Fixture\.mercury\.credentials.json`, '/mnt/c/Users/Fixture/.mercury/.provider-secrets.json', '/c/Users/Fixture/.mercury/.openai-auth.json', ...names.map(name => join(config, name)), join(project, 'alias.txt'), join(project, 'alias-hop.txt'), join(project, 'linked-config/.provider-secrets.json'), join(config, '../config/.credentials.json'), join(config, '.credentials.json:1-2'), join(config, '.credentials.json:1-'), join(config, '.credentials.json:1,-1'), ` ${join(config, '.credentials.json')} `, 'mercury://file/' + join(config, '.credentials.json'), ' mercury://file/' + join(config, '.credentials.json'), 'mercury://file//%ZZ/..' + join(config, '.credentials.json')]
try {
  console.log('refusals')
  for (const mode of modes) for (const path of secretPaths) {
    for (const [tool, input] of [[FileReadTool, { file_path: path }], [GrepTool, { path, pattern: 'value', output_mode: 'content' }]] as Array<[any, Record<string, unknown>]>) {
      const ctx = context(mode, [tool.name])
      const result = (await decideToolPermission(tool, input, ctx)).decision
      check(`${mode} ${tool.name} ${path}`, result.behavior === 'deny' && /credential|secret/i.test(result.message ?? ''), `${result.behavior}: ${result.message ?? ''}`)
      check(`${mode} refusal records no read evidence`, ctx.readFileState.size === 0)
    }
    const inspectRef = path.trim().startsWith('mercury://file/') ? path : 'mercury://file/' + path.trim()
    const inspectDecision = (await decideToolPermission(InspectTool, { ref: inspectRef }, context(mode, ['Inspect', 'Read']))).decision
    check(`${mode} Inspect ${inspectRef}`, inspectDecision.behavior === 'deny' && /credential|secret/i.test(inspectDecision.message ?? ''), `${inspectDecision.behavior}: ${inspectDecision.message ?? ''}`)
  }
  const adapterSecret = await fileAdapter.resolve({ raw: 'mercury://file/' + join(config, '.credentials.json'), canonical: 'mercury://file/' + join(config, '.credentials.json'), kind: 'file', id: join(config, '.credentials.json'), selectors: {} }, { owner: { kind: 'session', id: 's' }, cwd: project })
  check('fileAdapter.resolve refuses direct secret read', adapterSecret.state === 'unavailable' && !JSON.stringify(adapterSecret).includes(needle), JSON.stringify(adapterSecret))
  for (const mode of modes) {
    const result = await runWithCwdOverride(config, () => decideToolPermission(FileReadTool, { file_path: '.credentials.json' }, context(mode, ['Read'])))
    check(`${mode} relative credential path refuses`, result.decision.behavior === 'deny', result.decision.message)
    const asked = await decideToolPermission(FileReadTool, { file_path: join(config, '.credentials.json') }, context(mode, [], ['Read']))
    check(`${mode} a floor never becomes a whole-tool ask`, asked.decision.behavior === 'deny', asked.decision.message)
    const grep = await decideToolPermission(GrepTool, { path: config, glob: '.credentials.json', pattern: 'value' }, context(mode, ['Grep']))
    check(`${mode} explicit credential search refuses`, grep.decision.behavior === 'deny', grep.decision.message)
    const glob = await decideToolPermission(GlobTool, { path: config, pattern: '.credentials.json' }, context(mode, ['Glob']))
    check(`${mode} explicit credential glob refuses`, glob.decision.behavior === 'deny', glob.decision.message)
    for (const [tool, command] of [
      [BashTool, `cat '${config}/.credentials.json'`],
      [BashTool, `base64 '${config}/.provider-secrets.json'`],
      [BashTool, `xxd '${config}/.openai-auth.json'`],
      [BashTool, `cat < '${config}/.credentials.json'`],
      [BashTool, `cp '${config}/.credentials.json' copy.txt`],
      [BashTool, `cat '${project}/alias.txt'`],
      [BashTool, `node -e 'require("fs").readFileSync("${config}/.credentials.json")'`],
      [PowerShellTool, `[IO.File]::ReadAllText('${config}/.credentials.json')`],
      [BashTool, 'cat "$MERCURY_CONFIG_DIR/.credentials.json"'],
      [BashTool, 'cd "$MERCURY_CONFIG_DIR" && cat .credentials.json'],
      [BashTool, 'cd ~/.mercury && cat .provider-secrets.json'],
      [BashTool, 'd="$MERCURY_CONFIG_DIR"; cat "$d/.credentials.json"'],
      [BashTool, 'f=.credentials.json; cat ~/.mercury/$f'],
      [PowerShellTool, 'Set-Location "$env:MERCURY_CONFIG_DIR"; Get-Content .credentials.json'],
      [PowerShellTool, '$d="$env:MERCURY_CONFIG_DIR"; Get-Content "$d\\.credentials.json"'],
      [PowerShellTool, `Get-Content '${config}/.credentials.json'`],
      [PowerShellTool, `type '${config}/.provider-secrets.json'`],
      [PowerShellTool, `Copy-Item '${config}/.credentials.json' copy.txt`],
      [PowerShellTool, String.raw`Get-Content 'C:\Users\Fixture\.mercury\.credentials.json'`],
      [BashTool, 'cat /mnt/c/Users/Fixture/.mercury/.credentials.json'],
    ] as Array<[any, string]>) {
      const decision = (await decideToolPermission(tool, { command }, context(mode, [tool.name]))).decision
      check(`${mode} ${tool.name} named file read refuses`, decision.behavior === 'deny' && /credential|secret/i.test(decision.message ?? ''), `${command}: ${decision.behavior}: ${decision.message ?? ''}`)
    }
  }
  for (const mode of modes) {
    const exported = await decideToolPermission(BashTool, { command: "export OPENAI_API_KEY=fixture-value" }, context(mode, ['Bash']))
    check(mode + ' an environment export is not a credential-file read', exported.decision.behavior === 'allow', exported.decision.message)
  }
  console.log('search controls')
  writeFileSync(join(config, 'notes.json'), '{"value":"public-fixture"}\n')
  const { renderDirectoryTarget } = await load('src/tools/FileReadTool/readTarget.ts')
  const dirListing = renderDirectoryTarget(config)
  check('Read directory listing hides secret files and keeps ordinary files', dirListing.content.includes('notes.json') && !names.some(name => dirListing.content.includes(name)), dirListing.content)
  const inspectDir = await fileAdapter.resolve({ raw: 'mercury://file/' + config, canonical: 'mercury://file/' + config, kind: 'file', id: config, selectors: {} }, { owner: { kind: 'session', id: 's' }, cwd: project })
  const inspectChildren = JSON.stringify(inspectDir)
  check('Inspect directory listing hides secret files and keeps ordinary files', inspectDir.state === 'ok' && inspectChildren.includes('notes.json') && !names.some(name => inspectChildren.includes(name)), inspectChildren)
  for (const mode of modes) {
    const ctx = context(mode, ['Grep', 'Glob'])
    const single = await GrepTool.call({ path: join(config, 'notes.json'), pattern: 'public-fixture', output_mode: 'content' }, ctx)
    check(mode + ' ordinary single-file Grep still works', JSON.stringify(single.data).includes('public-fixture'))
    const searched = await GrepTool.call({ path: config, pattern: 'value', glob: '*.json', output_mode: 'content' }, ctx)
    const text = JSON.stringify(searched.data)
    check(`${mode} recursive Grep excludes credentials before content search`, !text.includes(needle) && text.includes('public-fixture'), text)
    const listed = await GlobTool.call({ path: config, pattern: '*' }, ctx)
    check(`${mode} Glob lists ordinary files, not credential stores`, listed.data.filenames.some((path: string) => path.endsWith('notes.json')) && !listed.data.filenames.some((path: string) => names.some(name => path.endsWith(name))), JSON.stringify(listed.data))
    for (const path of [join(project, '.credentials.json'), join(config, '.credentials.json.notes'), join(config, '.sign-ins.json')]) {
      const decision = (await decideToolPermission(FileReadTool, { file_path: path }, context(mode, ['Read']))).decision
      check(`${mode} ordinary or near-miss file remains readable`, decision.behavior === 'allow', decision.message)
    }
  }
  const alternateHome = join(scratch, 'alternate-config')
  mkdirSync(alternateHome)
  setAuthScope(alternateHome)
  for (const mode of modes) {
    const scoped = await decideToolPermission(FileReadTool, { file_path: join(alternateHome, '.credentials.json') }, context(mode, ['Read']))
    check(`${mode} auth-scope credential home is protected`, scoped.decision.behavior === 'deny', scoped.decision.message)
  }
  clearAuthScope()
  writeFileSync(join(project, '.credentials.json'), '{"value":"ordinary-project-fixture"}\n')
  for (const path of [scratch, join(project, 'linked-config')]) {
    const ctx = context('sovereign', ['Grep', 'Glob'])
    const answer = await GrepTool.call({ path, pattern: 'value', glob: '**/*.json', output_mode: 'content' }, ctx)
    check('search through parent or linked root excludes store contents', !JSON.stringify(answer.data).includes(needle) && JSON.stringify(answer.data).includes('public-fixture'), JSON.stringify(answer.data))
    const list = await GlobTool.call({ path, pattern: '**/*' }, ctx)
    check('listing through parent or linked root excludes stores', !list.data.filenames.some((file: string) => names.some(name => file.endsWith(name)) && resolve(project, file) !== join(project, '.credentials.json')), JSON.stringify(list.data))
  }
  mkdirSync(join(project, 'sub', 'deep'), { recursive: true })
  writeFileSync(join(project, 'sub', 'a.txt'), 'a\n')
  writeFileSync(join(project, 'sub', 'deep', 'b.txt'), 'b\n')
  const denyCtx = { ...context('sovereign', ['Glob']), getAppState: () => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'sovereign', alwaysAllowRules: { userSettings: ['Glob'] }, alwaysDenyRules: { userSettings: ['Read(sub/deep/**)'] } }, tasks: {}, sessionHooks: new Map() }) }
  const deepAnchored = await GlobTool.call({ path: join(project, 'sub'), pattern: 'deep/*.txt' }, denyCtx)
  const deepRecursive = await GlobTool.call({ path: join(project, 'sub'), pattern: '**/*.txt' }, denyCtx)
  check('anchored relative deny rule holds under a deeper search root', deepAnchored.data.filenames.length === 0, JSON.stringify(deepAnchored.data))
  check('recursive search under a deeper search root honours relative deny rule', JSON.stringify(deepRecursive.data.filenames.map((file: string) => resolve(project, file))) === JSON.stringify([join(project, 'sub', 'a.txt')]), JSON.stringify(deepRecursive.data))
  const fileTarget = await glob('*.json', join(config, 'notes.json'), { limit: 100, offset: 0 }, new AbortController().signal, getEmptyToolPermissionContext())
  check('file search root lists the file without ENOTDIR', JSON.stringify(fileTarget.files) === JSON.stringify([join(config, 'notes.json')]) && fileTarget.incomplete === undefined, JSON.stringify(fileTarget))
  console.log('Eval read_file helpers')
  const { EvalTool } = await load('src/tools/EvalTool/EvalTool.ts')
  for (const mode of modes) {
    for (const [language, code] of [
      ['py', "open(os.environ['MERCURY_CONFIG_DIR'] + '/.credentials.json').read()"],
      ['js', "require('fs').readFileSync(process.env.MERCURY_CONFIG_DIR + '/.credentials.json', 'utf8')"],
      ['js', "require('fs').writeFileSync(os.homedir() + '/.ssh/authorized_keys', 'x')"],
      ['js', "require('fs').unlinkSync(process.execPath)"],
    ] as const) {
      const verdict = (await decideToolPermission(EvalTool, { language, code }, context(mode, ['Eval']))).decision
      check(`${mode} EvalTool.checkPermissions refuses direct protected I/O (${language})`, verdict.behavior === 'deny' && /refused/i.test(verdict.message ?? ''), `${code}: ${verdict.behavior}: ${verdict.message ?? ''}`)
    }
  }
  const { makeContext } = await load('scripts/eval/lib.ts')
  const { makeEvalBridgeServer } = await load('src/services/eval/evalBridge.ts')
  const { evalKernelManager } = await load('src/services/eval/kernelManager.ts')
  try {
    for (const mode of modes) for (const language of ['js', 'py']) {
      const ctx = await makeContext({ mode, tools: [FileReadTool] })
      const cellAbort = new AbortController()
      const serveBridge = makeEvalBridgeServer({ context: ctx, cellAbort, canUseTool: async (tool: any, input: any, context: any) => (await decideToolPermission(tool, input, context)).decision })
      const path = JSON.stringify(join(config, '.credentials.json'))
      const code = language === 'js'
        ? 'let answer; try { await read_file(' + path + '); answer = "unexpected read" } catch (error) { answer = String(error.message) }\nanswer'
        : 'try:\n    read_file(' + path + ')\n    result = "unexpected read"\nexcept Exception as error:\n    result = str(error)\nresult'
      const result = await evalKernelManager.runCell({ owner: 'secret-' + mode + '-' + language, cwd: project, input: { language, code, timeoutSeconds: 30 }, abortSignal: cellAbort.signal, serveBridge })
      check(mode + ' ' + language + ' read_file refuses through the real bridge', result.status === 'ok' && /credential|refused/i.test(result.resultRepr ?? '') && !JSON.stringify(result).includes(needle), JSON.stringify(result))
      const directCode = language === 'js'
        ? 'let direct; try { require("node:fs").readFileSync(' + path + ', "utf8"); direct = "unexpected direct read" } catch (error) { direct = String(error.message) }\ndirect'
        : 'try:\n    open(' + path + ').read()\n    direct = "unexpected direct read"\nexcept Exception as error:\n    direct = str(error)\ndirect'
      const directResult = await evalKernelManager.runCell({ owner: 'secret-' + mode + '-' + language, cwd: project, input: { language, code: directCode, timeoutSeconds: 30 }, abortSignal: cellAbort.signal, serveBridge })
      check(mode + ' ' + language + ' direct kernel file read refuses', directResult.status === 'ok' && /credential|refused/i.test(directResult.resultRepr ?? '') && !JSON.stringify(directResult).includes(needle), JSON.stringify(directResult))
      cellAbort.abort()
    }
  } finally { await evalKernelManager.disposeAll() }
  console.log('product readers and writers')
  const stored = { claudeAiOauth: { accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'] } }
  check('the product credential writer still publishes', plainTextStorage.update(stored).success)
  check('the product credential reader still reads its own sign-in', plainTextStorage.read()?.claudeAiOauth?.accessToken === stored.claudeAiOauth.accessToken)
  providerSecrets.writeStoredOpenaiApiKey('sk-fixture-only-not-a-real-key')
  check('the product provider writer and reader still agree', providerSecrets.readStoredOpenaiApiKey() === 'sk-fixture-only-not-a-real-key')
  const { hasStoredOAuthToken } = await load('src/utils/auth.ts')
  check('sign-in presence still comes from the product store', hasStoredOAuthToken())
  for (const file of ['src/utils/router/providerSecrets.ts', 'src/utils/secureStorage/plainTextStorage.ts', 'src/utils/auth.ts', 'src/utils/accounts', 'src/services/providers', 'src/utils/healthReport.ts', 'src/tools/RecordConventionTool', 'src/tools/JourneyTool', 'src/tools/ServiceTool', 'src/cli/update.ts']) {
    let same = execFileSync('git', ['ls-files', '--', file], { cwd: root, encoding: 'utf8' }).trim() !== ''
    try { execFileSync('git', ['diff', '--exit-code', '56946be6d5bedc71576dbd4123635e0e817bd560', '--', file], { cwd: root, stdio: 'pipe' }) } catch { same = false }
    check(`${file} byte-identical to base`, same)
  }
} finally {
  clearAuthScope()
  process.chdir(before)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`own secret read floor: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
