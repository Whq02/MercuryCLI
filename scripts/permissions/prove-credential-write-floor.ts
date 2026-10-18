import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(process.argv[2] ?? join(import.meta.dir, '../..'))
const workerScratch = process.argv[3]
const scratch = workerScratch ?? realpathSync(mkdtempSync(join(tmpdir(), 'credential-write-')))
if (workerScratch === undefined) {
  mkdirSync(join(scratch, 'home'), { recursive: true })
  const child = spawnSync(process.execPath, [import.meta.filename, root, scratch], {
    stdio: 'inherit', env: { ...process.env, HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home') },
  })
  rmSync(scratch, { recursive: true, force: true })
  process.exit(child.status ?? 1)
}
const previous = process.cwd()
const home = join(scratch, 'home')
const project = join(scratch, 'project')
for (const path of [home, project, join(home, '.ssh'), join(home, '.aws')]) mkdirSync(path, { recursive: true })
process.env.HOME = home
process.env.USERPROFILE = home
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
process.env.BROWSER = '/usr/bin/true'
process.chdir(project)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const load = (file: string) => import(pathToFileURL(join(root, file)).href)
const { getEmptyToolPermissionContext } = await load('src/Tool.ts')
const { decideToolPermission } = await load('src/utils/permissions/decision/engine.ts')
const { FileWriteTool } = await load('src/tools/FileWriteTool/FileWriteTool.ts')
const { FileEditTool } = await load('src/tools/FileEditTool/FileEditTool.ts')
const { NotebookEditTool } = await load('src/tools/NotebookEditTool/NotebookEditTool.ts')
const { ChangeSetTool } = await load('src/tools/ChangeSetTool/ChangeSetTool.ts')
const { FileReadTool } = await load('src/tools/FileReadTool/FileReadTool.ts')
const { BashTool } = await load('src/tools/BashTool/BashTool.tsx')
const { PowerShellTool } = await load('src/tools/PowerShellTool/PowerShellTool.tsx')
const { runWithCwdOverride } = await load('src/utils/cwd.ts')
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = '') {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function context(mode: string, rules: { allow?: string[]; deny?: string[]; ask?: string[] } = {}) {
  const state = { toolPermissionContext: {
    ...getEmptyToolPermissionContext(), mode,
    alwaysAllowRules: { userSettings: rules.allow ?? [] },
    alwaysDenyRules: { userSettings: rules.deny ?? [] },
    alwaysAskRules: { userSettings: rules.ask ?? [] },
  }, tasks: {}, sessionHooks: new Map() }
  return { getAppState: () => state, setAppState: () => {}, abortController: new AbortController(), readFileState: new Map(), messages: [], options: { tools: [] } }
}
async function decide(tool: any, input: Record<string, unknown>, mode: string, rules = {}) {
  return (await decideToolPermission(tool, input, context(mode, rules))).decision
}
const modes = ['default', 'implement', 'sovereign']
const paths = [
  '~/.ssh/id_rsa', '~/.ssh/config', '~/.ssh/authorized_keys', '~/.ssh/../.ssh/id_rsa',
  '~/.aws/config', '~/.gnupg/key', '~/.kube/config', '~/.docker/config.json', '~/.azure/token',
  '~/.config/gh/hosts.yml', '~/.config/gcloud/token', '~/.netrc', '~/.pgpass', '~/.npmrc', '~/.pypirc', '~/.git-credentials',
  '/etc/sudoers', '/etc/sudoers.d/rule', '/etc/passwd', '/etc/shadow', '/etc/systemd/user/unit',
  String.raw`%USERPROFILE%\.ssh\id_rsa`, String.raw`$env:USERPROFILE\.aws\config`,
  String.raw`C:\Users\Fixture\.aws\credentials`, '/mnt/c/Users/Fixture/.ssh/id_rsa', '/c/Users/Fixture/.aws/config',
  '/Users/fixture/.ssh/id_rsa', '/home/fixture/.aws/config', '/root/.ssh/config',
]
symlinkSync(join(home, '.aws'), join(project, 'linked-store'))
symlinkSync(join(home, '.ssh/config'), join(project, 'linked-config'))
paths.push(join(project, 'linked-store/new-file'), join(project, 'linked-config'))
const bodies = (path: string): Array<[any, Record<string, unknown>]> => [
  [FileWriteTool, { file_path: path, content: 'new' }],
  [FileEditTool, { file_path: path, append: 'new' }],
  [NotebookEditTool, { notebook_path: path, new_source: 'new' }],
  [ChangeSetTool, { op: 'apply', changes: [{ file_path: path, expected_anchor: 'fa:0123456789ab', hunks: [{ lines: '1', replace: 'new' }] }] }],
]
try {
  console.log('refusals')
  for (const mode of modes) for (const path of paths) for (const [tool, input] of bodies(path)) {
    const verdict = await decide(tool, input, mode)
    check(`${mode} ${tool.name} ${path}`, verdict.behavior === 'deny' && /protected.*credential|credential.*protected/i.test(verdict.message ?? ''), `${verdict.behavior}: ${verdict.message ?? ''}`)
  }
  for (const mode of modes) {
    const result = await runWithCwdOverride(join(home, '.ssh'), () => decide(FileWriteTool, { file_path: 'new-key', content: 'x' }, mode))
    check(`${mode} relative path inside store`, result.behavior === 'deny', result.message)
    for (const rules of [{ allow: ['Write'] }, { allow: ['Edit(//**)'] }, { ask: ['Write'] }]) {
      const verdict = await decide(FileWriteTool, { file_path: join(home, '.ssh/key'), content: 'x' }, mode, rules)
      check(`${mode} broad grant or whole-tool ask cannot replace refusal`, verdict.behavior === 'deny', `${verdict.behavior}: ${verdict.message ?? ''}`)
    }
    const rule = 'Edit(~/.ssh/config)'
    const explicit = await decide(FileEditTool, { file_path: '~/.ssh/config', append: 'x' }, mode, { allow: [rule] })
    check(`${mode} named allow exception`, explicit.behavior === (mode === 'sovereign' ? 'deny' : 'allow'), `${explicit.behavior}: ${explicit.message ?? ''}`)
    const denied = await decide(FileEditTool, { file_path: '~/.ssh/config', append: 'x' }, mode, { allow: [rule], deny: [rule] })
    check(`${mode} deny wins named allow`, denied.behavior === 'deny', denied.message)
  }
  console.log('shell permission road')
  const shellRows: Array<[any, string, string]> = [
    [BashTool, 'printf x > ~/.ssh/config', '.ssh'],
    [BashTool, 'printf x | tee ~/.aws/config', '.aws'],
    [BashTool, 'cp source ~/.ssh/config', '.ssh'],
    [BashTool, 'mv source ~/.aws/config', '.aws'],
    [BashTool, "sed -i '' 's/a/b/' ~/.ssh/config", '.ssh'],
    [BashTool, 'chmod 777 ~/.ssh/config', '.ssh'],
    [BashTool, 'cp -t ~/.aws source', '.aws'],
    [BashTool, 'printf x | tee ~/.ssh/*', '.ssh'],
    [BashTool, "env LANG=C cp source ~/.ssh/config", '.ssh'],
    [BashTool, "bash -c 'printf x > ~/.aws/config'", '.aws'],
    [BashTool, 'printf x > ' + join(project, 'linked-store/new-file'), 'linked-store'],
    [PowerShellTool, String.raw`Copy-Item source -Destination "$env:USERPROFILE\.ssh\config"`, '.ssh'],
    [PowerShellTool, String.raw`Set-Content -Path "$env:USERPROFILE\.aws\config" -Value x`, '.aws'],
    [PowerShellTool, String.raw`icacls "%USERPROFILE%\.ssh\config" /grant Everyone:F`, '.ssh'],
  ]
  for (const mode of modes) for (const [tool, command, named] of shellRows) {
    const verdict = await decide(tool, { command }, mode, { allow: [tool.name] })
    check(`${mode} ${tool.name} credential write asks or runs`, verdict.behavior === (mode === 'sovereign' ? 'allow' : 'ask') && (mode === 'sovereign' || verdict.message?.includes(named)), `${command}: ${verdict.behavior}: ${verdict.message ?? ''}`)
    const denied = await decide(tool, { command }, mode, { deny: [tool.name] })
    check(`${mode} shell deny rule still wins`, denied.behavior === 'deny', denied.message)
  }
  for (const mode of modes) {
    for (const command of ['echo chmod 777 ~/.ssh/config', "printf '%s' 'cp source ~/.aws/config'", 'cat ~/.aws/config', "echo bash -c 'cp source ~/.aws/config'"]) {
      const verdict = await decide(BashTool, { command }, mode, { allow: ['Bash'] })
      check(mode + ' shell read or quoted data is not a write', verdict.behavior === 'allow', verdict.message)
    }
  }
  console.log('controls')
  for (const path of [join(home, '.sshd-notes'), join(home, '.awsome/note'), join(project, 'etc/passwd.bak'), join(project, '.aws/config')]) {
    const verdict = await decide(FileWriteTool, { file_path: path, content: 'x' }, 'sovereign')
    check(`near miss is not a store: ${path}`, verdict.behavior === 'allow', verdict.message)
  }
  for (const path of ['~/.ssh/config', '~/.aws/config']) for (const mode of modes) {
    const verdict = await decide(FileReadTool, { file_path: path }, mode, { allow: ['Read'] })
    check(`${mode} configuration stays readable`, verdict.behavior === 'allow', verdict.message)
  }
  const sentinel = join(home, '.ssh/config')
  writeFileSync(sentinel, 'fixture-original\n')
  for (const mode of modes) for (const [tool, input] of bodies(sentinel)) {
    const verdict = await decide(tool, input, mode)
    check(`${mode} ${tool.name} refused before any mutation`, verdict.behavior === 'deny' && readFileSync(sentinel, 'utf8') === 'fixture-original\n', verdict.message)
  }
} finally {
  process.chdir(previous)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`credential write floor: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
