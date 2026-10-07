import { getPlatform } from '../../src/utils/platform.js'
import { getFsImplementation, setFsImplementation } from '../../src/utils/fsOperations.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.js')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.js')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.js')
const { GlobTool } = await import('../../src/tools/GlobTool/GlobTool.js')
const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.js')
const { ChangeSetTool } = await import('../../src/tools/ChangeSetTool/ChangeSetTool.js')
const { TransactionTool } = await import('../../src/tools/TransactionTool/TransactionTool.js')
const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { checkReadPermissionForTool, checkWritePermissionForTool } = await import('../../src/utils/permissions/filesystem.js')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
const { powershellToolHasPermission } = await import('../../src/tools/PowerShellTool/powershellPermissions.js')
const fs = getFsImplementation()
let touches = 0
setFsImplementation(new Proxy(fs, { get(target, key) {
  const value = Reflect.get(target, key)
  if (typeof value !== 'function') return value
  return (...args: unknown[]) => { if (args.some(a => typeof a === 'string' && /127\.0\.0\.1|localhost|\[::1\]/.test(a))) { touches++; throw new Error('remote filesystem probe') }; return value.apply(target, args) }
} }))
const context = { getAppState: () => ({ toolPermissionContext: { mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} } }), options: {}, abortController: new AbortController() } as never
let failed = 0
function check(name: string, ok: boolean) { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++ }
const remote = String.raw`/\127.0.0.1/share/file.txt`
getPlatform.cache.set(undefined, 'windows')
const roads = [
  ['Read', FileReadTool, { file_path: remote }],
  ['Write', FileWriteTool, { file_path: remote, content: 'new' }],
  ['Edit', FileEditTool, { file_path: remote, old_string: 'old', new_string: 'new' }],
  ['Glob path', GlobTool, { path: remote, pattern: '*' }],
  ['Glob pattern', GlobTool, { pattern: remote + '/*' }],
  ['Grep path', GrepTool, { path: remote, pattern: 'text' }],
  ['ChangeSet preview', ChangeSetTool, { op: 'preview', changes: [{ file_path: remote, old_string: 'old', new_string: 'new' }] }],
  ['ChangeSet apply', ChangeSetTool, { op: 'apply', changes: [{ file_path: remote, old_string: 'old', new_string: 'new' }] }],
  ['ChangeSet move', ChangeSetTool, { op: 'preview', patch: `file local.txt fa:0123456789ab\nmove-to ${remote}` }],
] as const
for (const [name, tool, input] of roads) {
  const before = touches
  const verdict = await tool.checkPermissions(input as never, context)
  check(`${name} asks with the shared credential-risk sentence before probing`, verdict.behavior === 'ask' && verdict.message.includes('SMB/WebDAV') && touches === before)
}
for (const [name, tool, input] of roads.slice(0, 6)) {
  const local = String.raw`\\?\C:\project\file.txt`
  const value = 'file_path' in input ? { ...input, file_path: local } : { ...input, path: local }
  const valid = await tool.validateInput!(value as never, context)
  check(`${name} device namespace defers I/O to permission`, valid.result)
}
const tx = await runWithCwdOverride(remote, () => TransactionTool.checkPermissions({ op: 'status' }, context))
check('Transaction root asks before probing', tx.behavior === 'ask' && tx.message.includes('SMB/WebDAV'))
const project = mkdtempSync(join(tmpdir(), 'unc-record-'))
try {
  writeFileSync(join(project, 'pyproject.toml'), '[project]\nname = "unc-proof"\n')
  const { openTransaction } = await import('../../src/services/ide/ideTransaction.js')
  const { projectHomeStore } = await import('../../src/utils/projectHomeStores.js')
  const record = await openTransaction({ from: project, owner: 'unc-proof' as never, intent: 'record path check' })
  const dir = projectHomeStore(record.projectRoot, 'ide-transactions')
  record.projectRoot = remote
  writeFileSync(join(dir, record.id + '.json'), JSON.stringify(record))
  const before = touches
  const verdict = await runWithCwdOverride(project, () => TransactionTool.checkPermissions({ op: 'finish', verdict: 'completed' }, context))
  check('Transaction persisted path asks before probing', verdict.behavior === 'ask' && verdict.message.includes('SMB/WebDAV') && touches === before)
} finally { rmSync(project, { recursive: true, force: true }) }
if (!process.argv.includes('--file-roads')) {
  for (const mode of ['default', 'implement'] as const) {
    const ctx = { mode, alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: false }
    const shim = { name: 'Read', getPath: () => '//localhost/share/file' }
    const result = runWithCwdOverride('//localhost/share', () => checkReadPermissionForTool(shim, {}, ctx))
    check(`${mode} share workspace has no implicit exemption`, result.behavior === 'ask' && result.message.includes('SMB/WebDAV'))
    for (const blanket of ['Read(**)', 'Read(//**)', 'Read(//*/share/**)']) check(`${mode} ${blanket} does not name the host, so it still asks`, checkReadPermissionForTool(shim, {}, { ...ctx, alwaysAllowRules: { session: [blanket] } }).behavior === 'ask')
    for (const [operation, decide] of [['Read', checkReadPermissionForTool], ['Edit', checkWritePermissionForTool]] as const) {
      const granted = { ...ctx, alwaysAllowRules: { session: [`${operation}(//localhost/share/**)`] } }
      check(`${mode} explicit ${operation} share grant works`, decide(shim, {}, granted as never).behavior === 'allow')
      const denied = { ...granted, alwaysDenyRules: { session: [`${operation}(//localhost/share/**)`] } }
      check(`${mode} ${operation} deny beats the grant`, decide(shim, {}, denied as never).behavior === 'deny')
    }
  }
  check('Glob keeps an authorized wildcard out of its directory root', !GlobTool.getPath!({ pattern: '//localhost/share/*.txt' }).includes('*'))
  const shellContext = { mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} } as never
  const command = `cat '${remote}'`
  const bash = await bashToolHasPermission({ command }, shellContext)
  check('Bash uses the shared warning', bash.behavior === 'ask' && bash.message.includes('SMB/WebDAV'))
  const psCommand = `Get-Content '${remote}'`
  const ps = await powershellToolHasPermission({ command: psCommand }, context)
  check('PowerShell uses the shared warning', ps.behavior === 'ask' && ps.message.includes('SMB/WebDAV'))
  const { uncPathRisk } = await import('../../src/utils/permissions/uncPath.js')
  const forms = [
    ['backslash', String.raw`\\localhost\share`],
    ['slash', '//localhost/share'],
    ['mixed left', String.raw`\/localhost/share`],
    ['mixed right', remote],
    ['mixed repeated', String.raw`/\\localhost/share`],
    ['mixed trailing', String.raw`\\/localhost/share`],
    ['WebDAV', String.raw`\\localhost@SSL@443\DavWWWRoot\file`],
    ['port SSL', 'localhost@443@SSL'],
    ['bare SSL', '@SSL@443'],
    ['bare root marker', 'DavWWWRoot'],
    ['marker case', 'davwwwroot'],
    ['IPv4', '//127.0.0.1/share'],
    ['IPv6', '//[::1]/share'],
    ['extended UNC', String.raw`\\?\uNc\localhost\share`],
    ['NT UNC', String.raw`\??\UNC\localhost\share`],
    ['device UNC', String.raw`\\.\UNC\localhost\share`],
    ['MUP', String.raw`\\?\GLOBALROOT\Device\Mup\localhost\share`],
    ['file URL', 'file://localhost/share'],
    ['SMB URL', 'smb://localhost/share'],
    ['file encoded', 'file:%2f%2flocalhost/share'],
    ['quoted command', `cat '${remote}'`],
    ['concatenated host', String.raw`cat '\'\'localhost\share'`],
    ['flag value', '--path=//localhost/share'],
    ['host alone', '//localhost'],
  ] as const
  for (const [form, input] of forms) check(`Windows ${form}`, uncPathRisk(input).risky)
  for (const input of ['C:\\project\\file.txt', '/usr/local/file', './file', 'https://localhost/page', String.raw`\\?\C:\project\file`, String.raw`\\.\C:\project\file`]) check(`local or web ${input}`, !uncPathRisk(input).risky)
  const { windowsPathNeedsPermission } = await import('../../src/utils/permissions/windowsPath.js')
  const inherited = [
    ['host then separator', String.raw`\\server\share`],
    ['host at the end', String.raw`\\server`],
    ['host then whitespace', String.raw`type \\server\share\file.txt`],
    ['host with a port', String.raw`\\server@443\share`],
    ['host with ssl', String.raw`\\server@SSL\share`],
    ['slash host', '//server/share'],
    ['slash host with ssl', '//server@ssl/share'],
    ['slash then backslashes', String.raw`/\\server`],
    ['backslashes then slash', String.raw`\\\/server`],
    ['ssl then port', '@SSL@443'],
    ['port then ssl', '@443@SSL'],
    ['root marker', 'DavWWWRoot'],
    ['IPv4 host', String.raw`\\127.0.0.1\share`],
    ['IPv6 host', String.raw`\\[::1]\share`],
    ['host starting with ;', String.raw`\\;server\share`],
    ['host in parentheses', String.raw`\\(server)\share`],
    ['host in angle brackets', String.raw`\\<server>\share`],
    ['host starting with |', String.raw`\\|server\share`],
    ['device namespace drive', String.raw`\\?\C:\project\file`],
    ['device namespace pipe', String.raw`\\.\pipe\x`],
    ['device namespace slashes', '//?/x/y'],
    ['bare device prefix', String.raw`\\.`],
    ['bare long-path prefix', String.raw`\\?`],
    ['NT object prefix', String.raw`\\??\share`],
  ] as const
  for (const [form, input] of inherited) check(`old check refused ${form}, still refused`, windowsPathNeedsPermission(input))
  for (const platform of ['macos', 'linux', 'wsl'] as const) { getPlatform.cache.set(undefined, platform); for (const [form, input] of forms) check(`${platform} does not apply ${form}`, !uncPathRisk(input).risky) }
}
setFsImplementation(fs)
getPlatform.cache.delete(undefined)
console.log(`unc-path: ${failed ? 'FAIL' : 'PASS'} (${failed} failures)`)
process.exit(failed ? 1 : 0)
