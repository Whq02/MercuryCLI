import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const root = resolve(process.argv[2] ?? join(import.meta.dir, '../..'))
const workerScratch = process.argv[3]
const scratch = workerScratch ?? realpathSync(mkdtempSync(join(tmpdir(), 'runtime-floor-')))
if (workerScratch === undefined) {
  mkdirSync(join(scratch, 'home'), { recursive: true })
  const child = spawnSync(process.execPath, [import.meta.filename, root, scratch], {
    stdio: 'inherit', env: { ...process.env, HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home') },
  })
  rmSync(scratch, { recursive: true, force: true })
  process.exit(child.status ?? 1)
}
const previous = process.cwd()
const realExe = process.execPath
const realArgv = [...process.argv]
const home = join(scratch, 'home')
const project = join(scratch, 'project')
const config = join(scratch, 'config')
const dist = join(scratch, 'installed/dist')
const exe = join(scratch, 'interpreter/bin/node')
const runtime = join(config, 'runtime')
for (const path of [project, runtime, dist, dirname(exe), join(config, 'daemon')]) mkdirSync(path, { recursive: true })
process.env.MERCURY_CONFIG_DIR = config
process.env.MERCURY_DAEMON_DIR = join(config, 'daemon')
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
const { getProcessStartTokenAsync } = await load('src/daemon/ownerWatch.ts')
let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = '') {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
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
const pathBefore = process.env.PATH
const fixtureBin = join(scratch, 'fixture-bin')
mkdirSync(fixtureBin, { recursive: true })
const daemon = spawn(realExe, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
await new Promise<void>((resolve, reject) => { daemon.once('spawn', resolve); daemon.once('error', reject) })
writeFileSync(join(fixtureBin, 'ps'), `#!/bin/sh\n/bin/ps "$@" 2>/dev/null && exit 0\ncase "$*" in\n  *lstart=*) echo "Sun Oct 18 07:00:00 2026"; exit 0 ;;\n  *ppid=*) echo "${process.pid}"; exit 0 ;;\nesac\nexit 1\n`)
chmodSync(join(fixtureBin, 'ps'), 0o755)
writeFileSync(join(fixtureBin, 'launchctl'), '#!/bin/sh\ncase "$2" in */fixture.mercury.daemon) echo "pid = ' + daemon.pid + '";; *) echo "pid = 2147480000";; esac\n')
chmodSync(join(fixtureBin, 'launchctl'), 0o755)
process.env.PATH = fixtureBin + ':' + pathBefore
const daemonState = { pid: daemon.pid!, startedAt: Date.now(), startToken: await getProcessStartTokenAsync(daemon.pid!) }
writeFileSync(join(config, 'daemon/daemon.json'), JSON.stringify(daemonState))
writeFileSync(join(dist, 'manifest.json'), JSON.stringify({ buildTree: 'fixture-runtime-build', buildTime: 'fixture' }))
writeFileSync(join(dist, 'mercury.mjs'), 'fixture-original\n')
writeFileSync(exe, 'fixture-interpreter\n')
symlinkSync(dist, join(runtime, 'current'), process.platform === 'win32' ? 'junction' : 'dir')
symlinkSync(runtime, join(project, 'linked-runtime'), process.platform === 'win32' ? 'junction' : 'dir')
symlinkSync(join(dist, 'missing.mjs'), join(project, 'linked-missing'))
symlinkSync(join(project, 'linked-missing'), join(project, 'linked-missing-two'))
Object.defineProperty(process, 'execPath', { value: exe, configurable: true })
process.argv[1] = join(dist, 'mercury.mjs')
const bodies = (path: string): Array<[any, Record<string, unknown>]> => [
  [FileWriteTool, { file_path: path, content: 'replacement' }],
  [FileEditTool, { file_path: path, append: 'replacement' }],
  [NotebookEditTool, { notebook_path: path, new_source: 'replacement' }],
  [ChangeSetTool, { op: 'apply', changes: [{ file_path: path, expected_anchor: 'fa:0123456789ab', hunks: [{ lines: '1', replace: 'replacement' }] }] }],
]
try {
  console.log('refusals')
  const paths = [
    join(runtime, 'current'), join(runtime, 'current/mercury.mjs'), join(runtime, 'new-build/part'),
    join(project, 'linked-runtime/current/mercury.mjs'), join(project, 'linked-missing'),
    join(project, 'linked-missing-two'), ` ${join(dist, 'mercury.mjs')} `,
    join(dist, 'mercury.mjs'), dirname(dist), exe, join(dirname(exe), 'sibling'),
    '~/.mercury/runtime/current', '~/.mercury/runtime/../runtime/current',
    String.raw`%USERPROFILE%\.mercury\runtime\current`, String.raw`$env:USERPROFILE\.mercury\runtime\current`,
    String.raw`C:\Users\Fixture\.mercury\runtime\current`, '/mnt/c/Users/Fixture/.mercury/runtime/current', '/c/Users/Fixture/.mercury/runtime/current',
  ]
  for (const mode of modes) for (const path of paths) for (const [tool, input] of bodies(path)) {
    const verdict = await decide(tool, input, mode, { allow: ['Write', 'Edit(//**)', 'NotebookEdit', 'ChangeSet'] })
    check(`${mode} ${tool.name} runtime write`, verdict.behavior === 'deny' && /runtime/.test(verdict.message ?? ''), `${path}: ${verdict.behavior}: ${verdict.message ?? ''}`)
  }
  for (const mode of modes) {
    const result = await runWithCwdOverride(dist, () => decide(FileWriteTool, { file_path: 'next.mjs', content: 'x' }, mode))
    check(mode + ' relative write inside deployed dist', result.behavior === 'deny', result.message)
    const ask = await decide(FileWriteTool, { file_path: exe, content: 'x' }, mode, { ask: ['Write'] })
    check(mode + ' whole-tool ask cannot replace runtime floor', ask.behavior === 'deny', ask.message)
  }
  const shellRows: Array<[any, string]> = [
    [BashTool, 'rm -rf ~/.mercury/runtime'],
    [BashTool, 'rsync /tmp/evil ~/.mercury/runtime/current/mercury.mjs'],
    [BashTool, 'find ~/.mercury/runtime -exec rm -rf {} +'],
    [BashTool, 'echo ~/.mercury/runtime | xargs rm -rf'],
    [BashTool, 'cd "$HOME/.mercury/runtime" && rm -rf current'],
    [BashTool, `python3 -c "open('${dist}/mercury.mjs','w').write('x')"`],
    [BashTool, `rm -f '${dist}/mercury.mjs'`],
    [BashTool, `rm -rf '${dirname(dist)}'`],
    [BashTool, `mv '${dist}' '${project}/moved'`],
    [BashTool, `cp source '${exe}'`],
    [BashTool, `printf x > '${runtime}/current/mercury.mjs'`],
    [BashTool, `printf x >> '${runtime}/current/mercury.mjs'`],
    [BashTool, `printf x | tee '${dist}/mercury.mjs'`],
    [BashTool, `truncate -s 0 '${dist}/mercury.mjs'`],
    [BashTool, `dd if=/dev/zero of='${exe}'`],
    [BashTool, `sed -i '' 's/a/b/' '${dist}/mercury.mjs'`],
    [BashTool, `env LANG=C rm '${exe}'`],
    [BashTool, `bash -c "rm '${exe}'"`],
    [BashTool, `eval "rm '${exe}'"`],
    [BashTool, `bash <<'END'\nrm '${exe}'\nEND`],
    [BashTool, `cd '${dist}' && rm mercury.mjs`],
    [BashTool, `node -e "require('fs').unlinkSync('${exe}')"`],
    [BashTool, `target='${dist}/mercury.mjs'; rm "$target"`],
    [BashTool, `cat <<END\n$(rm '${exe}')\nEND`],
    [PowerShellTool, `[IO.File]::WriteAllText('${dist}/mercury.mjs','x')`],
    [PowerShellTool, `$target='${dist}/mercury.mjs'; Set-Content $target x`],
    [PowerShellTool, String.raw`cmd /c "del C:\Users\Fixture\.mercury\runtime\current"`],
    [PowerShellTool, String.raw`Remove-Item -LiteralPath:"C:\Users\Fixture\.mercury\runtime\current"`],
    [PowerShellTool, String.raw`Remove-Item -Recurse "$env:USERPROFILE\.mercury\runtime"`],
    [PowerShellTool, `Move-Item -Path '${dist}' -Destination '${project}/moved'`],
    [PowerShellTool, `Copy-Item source -Destination '${exe}'`],
    [PowerShellTool, `Clear-Content '${dist}/mercury.mjs'`],
    [PowerShellTool, `Set-Content '${dist}/mercury.mjs' -Value x`],
    [PowerShellTool, `Set-Location '${dist}'; Remove-Item mercury.mjs`],
    [BashTool, 'pkill mercury'], [BashTool, 'pkill -f mercury'], [BashTool, 'pkill -9 node'],
    [BashTool, 'pkill --full mercury'], [BashTool, 'kill $(pgrep -f mercury)'],
    [BashTool, 'command pkill -f mercury'], [BashTool, "bash -c 'killall node'"],
    [BashTool, 'killall node'], [BashTool, 'killall -9 mercury'], [BashTool, 'killall -r "^no.*"'],
    [BashTool, 'kill -9 -1'], [BashTool, 'kill 0'],
    [PowerShellTool, `taskkill /F /FI "PID eq ${process.pid}"`],
    [PowerShellTool, 'taskkill /F /FI "IMAGENAME eq node.exe"'],
    [PowerShellTool, `Get-Process -Id ${process.pid} | Stop-Process -Force`],
    [PowerShellTool, `Stop-Process -Id:${process.pid} -Force`],
    [BashTool, 'pgrep -f mercury | xargs kill'], [BashTool, 'pgrep node | xargs -r kill -9'],
    [BashTool, `kill -9 ${process.pid}`], [BashTool, `kill -- ${daemon.pid}`],
    [PowerShellTool, 'taskkill /F /IM node.exe'], [PowerShellTool, 'taskkill /F /IM mercury.exe'],
    [PowerShellTool, 'Stop-Process -Name node'], [PowerShellTool, 'Stop-Process -Name mercury'],
    [PowerShellTool, 'Get-Process -Name node | Stop-Process -Force'],
    [PowerShellTool, `Stop-Process -Id ${process.pid} -Force`], [PowerShellTool, `taskkill /F /PID ${daemon.pid}`],
  ]
  const plist = join(scratch, 'fixture-daemon.plist')
  writeFileSync(plist, `<plist><dict><key>Label</key><string>fixture.mercury.daemon</string><key>ProgramArguments</key><array><string>${exe}</string><string>${dist}/mercury.mjs</string><string>daemon</string></array></dict></plist>`)
  shellRows.push([BashTool, `launchctl unload '${plist}'`], [BashTool, `launchctl bootout gui/501 '${plist}'`])
  if (process.platform === 'darwin') shellRows.push([BashTool, 'launchctl bootout gui/501/fixture.mercury.daemon'])
  for (const mode of modes) for (const [tool, command] of shellRows) {
    const verdict = await decide(tool, { command }, mode, { allow: [tool.name] })
    check(`${mode} ${tool.name} runtime/process refusal`, verdict.behavior === 'deny' && /Mercury/.test(verdict.message ?? ''), `${command}: ${verdict.behavior}: ${verdict.message ?? ''}`)
  }
  console.log('controls')
  const controls: Array<[any, string]> = [
    [BashTool, 'kill 2147480000'], [BashTool, 'kill %1'], [BashTool, `kill -0 ${process.pid}`],
    [PowerShellTool, 'taskkill /F /PID 2147480000'], [PowerShellTool, 'Stop-Process -Id 2147480000'],
    [BashTool, 'pkill fixture-unrelated'], [BashTool, 'killall fixture-unrelated'],
    [BashTool, 'pgrep node'], [BashTool, 'pgrep fixture-unrelated | xargs kill'],
    [BashTool, 'pkill -P 2147480000 node'], [BashTool, 'pkill -x nod'],
    [PowerShellTool, `Get-Process -Id ${process.pid}`],
    [PowerShellTool, 'taskkill /F /IM node.exe /FI "PID eq 2147480000"'],
    [PowerShellTool, `Write-Output '[IO.File]::Delete("${exe}")'`],
    [PowerShellTool, `$target='${exe}'; Write-Output $target`],
    [BashTool, 'echo pkill mercury'], [BashTool, "printf '%s' 'killall node'"],
    [BashTool, `cat <<'END'\nrm '${exe}'\nEND`],
    [BashTool, `cat '${exe}'`], [BashTool, `cp '${exe}' '${project}/copy'`],
    [BashTool, `rm '${project}/runtime-notes'`], [BashTool, 'rm ~/.mercury/runtime-notes/file'],
    [PowerShellTool, 'Stop-Process -Name node -WhatIf'], [PowerShellTool, `Remove-Item '${exe}' -WhatIf`],
    [BashTool, 'mercury update'], [BashTool, 'launchctl bootout gui/501/fixture.unrelated'],
  ]
  for (const mode of modes) for (const [tool, command] of controls) {
    const verdict = await decide(tool, { command }, mode, { allow: [tool.name] })
    check(mode + ' ordinary shell behavior remains', verdict.behavior === (command.includes('runtime-notes/file') && mode !== 'sovereign' ? 'ask' : 'allow'), `${command}: ${verdict.behavior}: ${verdict.message ?? ''}`)
  }
  for (const mode of modes) {
    const denied = await decide(BashTool, { command: 'kill 2147480000' }, mode, { deny: ['Bash'] })
    check(mode + ' unrelated pid still obeys deny rule', denied.behavior === 'deny', denied.message)
    for (const path of [join(project, 'dist/file'), join(project, 'runtime/file'), join(home, '.mercury/runtime-notes/file')]) {
      const verdict = await decide(FileWriteTool, { file_path: path, content: 'x' }, mode, { allow: ['Write'] })
      check(mode + ' near-miss is not the running runtime', verdict.behavior === (path.includes('.mercury/runtime-notes') && mode !== 'sovereign' ? 'ask' : 'allow'), verdict.message)
    }
    const read = await decide(FileReadTool, { file_path: exe }, mode, { allow: ['Read'] })
    check(mode + ' runtime remains readable', read.behavior === 'allow', read.message)
  }
  writeFileSync(join(config, 'daemon/daemon.json'), JSON.stringify({ ...daemonState, startToken: 'fixture-not-the-live-process' }))
  const reused = await decide(BashTool, { command: `kill ${daemon.pid}` }, 'sovereign')
  check('reused daemon pid is not Mercury', reused.behavior === 'allow', reused.message)
  Object.defineProperty(process, 'execPath', { value: String.raw`C:\Program Files\Mercury\node.exe`, configurable: true })
  for (const path of [String.raw`C:\Program Files\Mercury\node.exe`, '/mnt/c/Program Files/Mercury/node.exe', '/c/Program Files/Mercury/other']) {
    const verdict = await decide(FileWriteTool, { file_path: path, content: 'x' }, 'sovereign')
    check('Windows running interpreter folder', verdict.behavior === 'deny', verdict.message)
  }
  check('fixture runtime bytes survived every refused command', readFileSync(exe, 'utf8') === 'fixture-interpreter\n' && readFileSync(join(dist, 'mercury.mjs'), 'utf8') === 'fixture-original\n')
  for (const path of ['src/cli/update.ts', 'src/tools/JourneyTool/JourneyTool.ts', 'src/tools/ServiceTool/ServiceTool.ts']) {
    const before = spawnSync('git', ['-C', root, 'show', '56946be6d5:' + path], { encoding: 'utf8' })
    check(path + ' unchanged from base', before.status === 0 && before.stdout === readFileSync(join(root, path), 'utf8'), before.stderr)
  }
} finally {
  Object.defineProperty(process, 'execPath', { value: realExe, configurable: true })
  process.argv.splice(0, process.argv.length, ...realArgv)
  daemon.kill()
  await new Promise<void>(resolve => { if (daemon.exitCode !== null || daemon.signalCode !== null) resolve(); else daemon.once('exit', () => resolve()) })
  process.chdir(previous)
}
console.log(`runtime self-protection: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
