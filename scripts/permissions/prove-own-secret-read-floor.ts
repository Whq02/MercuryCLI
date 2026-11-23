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
const { getEmptyToolPermissionContext } = await load('src/tools/kit/tool.ts')
const { decideToolPermission } = await load('src/permissions/rules/decision/engine.ts')
const { FileReadTool } = await load('src/tools/read/ReadTool.ts')
const { InspectTool } = await load('src/tools/inspect/InspectTool.ts')
const { fileAdapter } = await load('src/integrations/resources/adapters/file.ts')
const { GrepTool } = await load('src/tools/grep/GrepTool.ts')
const { GlobTool } = await load('src/tools/glob/GlobTool.ts')
const { glob } = await load('src/tools/glob/glob.ts')
const { BashTool } = await load('src/tools/shell/BashTool.tsx')
const { PowerShellTool } = await load('src/tools/powershell/PowerShellTool.tsx')
const { runWithCwdOverride } = await load('src/platform/files/cwd.ts')
const { setAuthScope, clearAuthScope } = await load('src/platform/environment/envUtils.ts')
const { plainTextStorage } = await load('src/platform/secure-storage/plainTextStorage.ts')
const providerSecrets = await load('src/models/sign-in/account-ledger/providerSecrets.ts')
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = '', hint = '') {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!ok && hint ? ' — ' + hint : ''}`)
}
const READ_HINT = 'fix mercurySecretPath in src/permissions/rules/protectedPaths.ts or checkReadPermissionForTool in src/permissions/rules/filesystem.ts so a read of a Mercury credential file is denied'
const SHELL_HINT = 'fix the credential-file refusal in src/permissions/rules/shellProtectedPaths.ts (and secretReach.ts beside it) so a command that names a credential file is denied'
const LISTING_HINT = 'fix readDenialFilter in src/permissions/rules/filesystem.ts, renderDirectoryTarget in src/tools/read/readTarget.ts or the file adapter in src/integrations/resources/adapters/file.ts so credential stores are hidden and ordinary files stay visible'
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
      check(`${mode} ${tool.name} ${path}`, result.behavior === 'deny' && /credential|secret/i.test(result.message ?? ''), `${result.behavior}: ${result.message ?? ''}`, READ_HINT)
      check(`${mode} refusal records no read evidence`, ctx.readFileState.size === 0, '', 'a refused read of a credential file must leave readFileState empty')
    }
    const inspectRef = path.trim().startsWith('mercury://file/') ? path : 'mercury://file/' + path.trim()
    const inspectDecision = (await decideToolPermission(InspectTool, { ref: inspectRef }, context(mode, ['Inspect', 'Read']))).decision
    check(`${mode} Inspect ${inspectRef}`, inspectDecision.behavior === 'deny' && /credential|secret/i.test(inspectDecision.message ?? ''), `${inspectDecision.behavior}: ${inspectDecision.message ?? ''}`, 'fix resolve in src/integrations/resources/adapters/file.ts so an Inspect of a credential file is refused')
  }
  const adapterSecret = await fileAdapter.resolve({ raw: 'mercury://file/' + join(config, '.credentials.json'), canonical: 'mercury://file/' + join(config, '.credentials.json'), kind: 'file', id: join(config, '.credentials.json'), selectors: {} }, { owner: { kind: 'session', id: 's' }, cwd: project })
  check('fileAdapter.resolve refuses direct secret read', adapterSecret.state === 'unavailable' && !JSON.stringify(adapterSecret).includes(needle), JSON.stringify(adapterSecret), 'fix resolve in src/integrations/resources/adapters/file.ts so a credential path returns state unavailable without its content')
  for (const mode of modes) {
    const result = await runWithCwdOverride(config, () => decideToolPermission(FileReadTool, { file_path: '.credentials.json' }, context(mode, ['Read'])))
    check(`${mode} relative credential path refuses`, result.decision.behavior === 'deny', result.decision.message, READ_HINT)
    const asked = await decideToolPermission(FileReadTool, { file_path: join(config, '.credentials.json') }, context(mode, [], ['Read']))
    check(`${mode} a floor never becomes a whole-tool ask`, asked.decision.behavior === 'deny', asked.decision.message, READ_HINT + ', so the denial holds even when an ask rule covers Read')
    const grep = await decideToolPermission(GrepTool, { path: config, glob: '.credentials.json', pattern: 'value' }, context(mode, ['Grep']))
    check(`${mode} explicit credential search refuses`, grep.decision.behavior === 'deny', grep.decision.message, READ_HINT)
    const glob = await decideToolPermission(GlobTool, { path: config, pattern: '.credentials.json' }, context(mode, ['Glob']))
    check(`${mode} explicit credential glob refuses`, glob.decision.behavior === 'deny', glob.decision.message, READ_HINT)
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
      check(`${mode} ${tool.name} named file read refuses`, decision.behavior === 'deny' && /credential|secret/i.test(decision.message ?? ''), `${command}: ${decision.behavior}: ${decision.message ?? ''}`, SHELL_HINT)
    }
  }
  for (const mode of modes) {
    const exported = await decideToolPermission(BashTool, { command: "export OPENAI_API_KEY=fixture-value" }, context(mode, ['Bash']))
    check(mode + ' an environment export is not a credential-file read', exported.decision.behavior === 'allow', exported.decision.message, 'narrow the credential-file refusal in src/permissions/rules/shellProtectedPaths.ts so an environment export that names no file is allowed')
  }
  console.log('search controls')
  writeFileSync(join(config, 'notes.json'), '{"value":"public-fixture"}\n')
  const { renderDirectoryTarget } = await load('src/tools/read/readTarget.ts')
  const dirListing = renderDirectoryTarget(config)
  check('Read directory listing hides secret files and keeps ordinary files', dirListing.content.includes('notes.json') && !names.some(name => dirListing.content.includes(name)), dirListing.content, 'fix renderDirectoryTarget in src/tools/read/readTarget.ts so the listing hides credential stores and keeps ordinary files')
  const inspectDir = await fileAdapter.resolve({ raw: 'mercury://file/' + config, canonical: 'mercury://file/' + config, kind: 'file', id: config, selectors: {} }, { owner: { kind: 'session', id: 's' }, cwd: project })
  const inspectChildren = JSON.stringify(inspectDir)
  check('Inspect directory listing hides secret files and keeps ordinary files', inspectDir.state === 'ok' && inspectChildren.includes('notes.json') && !names.some(name => inspectChildren.includes(name)), inspectChildren, 'fix resolve in src/integrations/resources/adapters/file.ts so a directory listing hides credential stores and keeps ordinary files')
  for (const mode of modes) {
    const ctx = context(mode, ['Grep', 'Glob'])
    const single = await GrepTool.call({ path: join(config, 'notes.json'), pattern: 'public-fixture', output_mode: 'content' }, ctx)
    check(mode + ' ordinary single-file Grep still works', JSON.stringify(single.data).includes('public-fixture'), '', 'an ordinary single file must stay searchable by Grep; check readDenialFilter in src/permissions/rules/filesystem.ts')
    const searched = await GrepTool.call({ path: config, pattern: 'value', glob: '*.json', output_mode: 'content' }, ctx)
    const text = JSON.stringify(searched.data)
    check(`${mode} recursive Grep excludes credentials before content search`, !text.includes(needle) && text.includes('public-fixture'), text, LISTING_HINT)
    const listed = await GlobTool.call({ path: config, pattern: '*' }, ctx)
    check(`${mode} Glob lists ordinary files, not credential stores`, listed.data.filenames.some((path: string) => path.endsWith('notes.json')) && !listed.data.filenames.some((path: string) => names.some(name => path.endsWith(name))), JSON.stringify(listed.data), LISTING_HINT)
    for (const path of [join(project, '.credentials.json'), join(config, '.credentials.json.notes'), join(config, '.sign-ins.json')]) {
      const decision = (await decideToolPermission(FileReadTool, { file_path: path }, context(mode, ['Read']))).decision
      check(`${mode} ordinary or near-miss file remains readable`, decision.behavior === 'allow', decision.message, 'an ordinary or near-miss file name must stay readable; narrow mercurySecretPath in src/permissions/rules/protectedPaths.ts')
    }
  }
  const alternateHome = join(scratch, 'alternate-config')
  mkdirSync(alternateHome)
  setAuthScope(alternateHome)
  for (const mode of modes) {
    const scoped = await decideToolPermission(FileReadTool, { file_path: join(alternateHome, '.credentials.json') }, context(mode, ['Read']))
    check(`${mode} auth-scope credential home is protected`, scoped.decision.behavior === 'deny', scoped.decision.message, READ_HINT + ', including for the credential home of an auth scope')
  }
  clearAuthScope()
  writeFileSync(join(project, '.credentials.json'), '{"value":"ordinary-project-fixture"}\n')
  for (const path of [scratch, join(project, 'linked-config')]) {
    const ctx = context('sovereign', ['Grep', 'Glob'])
    const answer = await GrepTool.call({ path, pattern: 'value', glob: '**/*.json', output_mode: 'content' }, ctx)
    check('search through parent or linked root excludes store contents', !JSON.stringify(answer.data).includes(needle) && JSON.stringify(answer.data).includes('public-fixture'), JSON.stringify(answer.data), LISTING_HINT)
    const list = await GlobTool.call({ path, pattern: '**/*' }, ctx)
    check('listing through parent or linked root excludes stores', !list.data.filenames.some((file: string) => names.some(name => file.endsWith(name)) && resolve(project, file) !== join(project, '.credentials.json')), JSON.stringify(list.data), LISTING_HINT)
  }
  mkdirSync(join(project, 'sub', 'deep'), { recursive: true })
  writeFileSync(join(project, 'sub', 'a.txt'), 'a\n')
  writeFileSync(join(project, 'sub', 'deep', 'b.txt'), 'b\n')
  const denyCtx = { ...context('sovereign', ['Glob']), getAppState: () => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'sovereign', alwaysAllowRules: { userSettings: ['Glob'] }, alwaysDenyRules: { userSettings: ['Read(sub/deep/**)'] } }, tasks: {}, sessionHooks: new Map() }) }
  const deepAnchored = await GlobTool.call({ path: join(project, 'sub'), pattern: 'deep/*.txt' }, denyCtx)
  const deepRecursive = await GlobTool.call({ path: join(project, 'sub'), pattern: '**/*.txt' }, denyCtx)
  check('anchored relative deny rule holds under a deeper search root', deepAnchored.data.filenames.length === 0, JSON.stringify(deepAnchored.data), 'fix how readDenialFilter in src/permissions/rules/filesystem.ts roots a relative deny rule under a deeper search root')
  check('recursive search under a deeper search root honours relative deny rule', JSON.stringify(deepRecursive.data.filenames.map((file: string) => resolve(project, file))) === JSON.stringify([join(project, 'sub', 'a.txt')]), JSON.stringify(deepRecursive.data), 'fix how readDenialFilter in src/permissions/rules/filesystem.ts roots a relative deny rule under a deeper search root')
  const fileTarget = await glob('*.json', join(config, 'notes.json'), { limit: 100, offset: 0 }, new AbortController().signal, getEmptyToolPermissionContext())
  check('file search root lists the file without ENOTDIR', JSON.stringify(fileTarget.files) === JSON.stringify([join(config, 'notes.json')]) && fileTarget.incomplete === undefined, JSON.stringify(fileTarget), 'fix glob in src/tools/glob/glob.ts so a search root that is a file lists that file and reports no error')
  console.log('Eval read_file helpers')
  const { EvalTool } = await load('src/tools/eval/EvalTool.ts')
  for (const mode of modes) {
    for (const [language, code] of [
      ['py', "open(os.environ['MERCURY_CONFIG_DIR'] + '/.credentials.json').read()"],
      ['js', "require('fs').readFileSync(process.env.MERCURY_CONFIG_DIR + '/.credentials.json', 'utf8')"],
      ['js', "require('fs').writeFileSync(os.homedir() + '/.ssh/authorized_keys', 'x')"],
      ['js', "require('fs').unlinkSync(process.execPath)"],
    ] as const) {
      const verdict = (await decideToolPermission(EvalTool, { language, code }, context(mode, ['Eval']))).decision
      check(`${mode} EvalTool.checkPermissions refuses direct protected I/O (${language})`, verdict.behavior === 'deny' && /refused/i.test(verdict.message ?? ''), `${code}: ${verdict.behavior}: ${verdict.message ?? ''}`, 'fix the permission check of src/tools/eval/EvalTool.ts so direct protected file I/O in a cell is refused')
    }
  }
  const { makeContext } = await load('scripts/eval/lib.ts')
  const { makeEvalBridgeServer } = await load('src/tools/engines/eval-kernels/evalBridge.ts')
  const { evalKernelManager } = await load('src/tools/engines/eval-kernels/kernelManager.ts')
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
      check(mode + ' ' + language + ' read_file refuses through the real bridge', result.status === 'ok' && /credential|refused/i.test(result.resultRepr ?? '') && !JSON.stringify(result).includes(needle), JSON.stringify(result), 'fix read_file in src/tools/engines/eval-kernels/evalBridge.ts so a credential read through the bridge is refused')
      const directCode = language === 'js'
        ? 'let direct; try { require("node:fs").readFileSync(' + path + ', "utf8"); direct = "unexpected direct read" } catch (error) { direct = String(error.message) }\ndirect'
        : 'try:\n    open(' + path + ').read()\n    direct = "unexpected direct read"\nexcept Exception as error:\n    direct = str(error)\ndirect'
      const directResult = await evalKernelManager.runCell({ owner: 'secret-' + mode + '-' + language, cwd: project, input: { language, code: directCode, timeoutSeconds: 30 }, abortSignal: cellAbort.signal, serveBridge })
      check(mode + ' ' + language + ' direct kernel file read refuses', directResult.status === 'ok' && /credential|refused/i.test(directResult.resultRepr ?? '') && !JSON.stringify(directResult).includes(needle), JSON.stringify(directResult), 'the kernel must refuse a direct file read of a credential file; the permission check of src/tools/eval/EvalTool.ts is the first place to look')
      cellAbort.abort()
    }
  } finally { await evalKernelManager.disposeAll() }
  console.log('product readers and writers')
  const stored = { claudeAiOauth: { accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'] } }
  check('the product credential writer still publishes', plainTextStorage.update(stored).success, '', 'the credential floor must not block the product writer; check src/platform/secure-storage/plainTextStorage.ts')
  check('the product credential reader still reads its own sign-in', plainTextStorage.read()?.claudeAiOauth?.accessToken === stored.claudeAiOauth.accessToken, '', 'the credential floor must not block the product reader; check src/platform/secure-storage/plainTextStorage.ts')
  providerSecrets.writeStoredOpenaiApiKey('sk-fixture-only-not-a-real-key')
  check('the product provider writer and reader still agree', providerSecrets.readStoredOpenaiApiKey() === 'sk-fixture-only-not-a-real-key', '', 'check src/models/sign-in/account-ledger/providerSecrets.ts')
  const { hasStoredOAuthToken } = await load('src/models/sign-in/credentials/auth.ts')
  check('sign-in presence still comes from the product store', hasStoredOAuthToken(), '', 'check hasStoredOAuthToken in src/models/sign-in/credentials/auth.ts')
} finally {
  clearAuthScope()
  process.chdir(before)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`own secret read floor: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
