#!/usr/bin/env bun
import { getPlatform, type Platform } from '../../src/utils/platform.js'

type Stand = { name: string; node: NodeJS.Platform; house: Platform }

type Row = {
  name: string
  stands?: readonly Stand[]
  answers: (stand: Stand) => unknown
  old?: (stand: Stand) => unknown
  recorded?: Record<string, unknown>
}

const STANDS: readonly Stand[] = [
  { name: 'win32', node: 'win32', house: 'windows' },
  { name: 'darwin', node: 'darwin', house: 'macos' },
  { name: 'linux', node: 'linux', house: 'linux' },
  { name: 'win32 by process.platform alone', node: 'win32', house: 'linux' },
  { name: 'win32 by getPlatform() alone', node: 'linux', house: 'windows' },
]

const PATHS: Row[] = [
]

const PROGRAMS: Row[] = [
]

import {
  commandShellArgv,
  commandShellOption,
  editorInvocationOf,
  editorShellCommandLine,
  executableNeedsVerbatimArgs,
  guiEditorSpawnSpec,
  hostScriptDialect,
  hostShellHint,
  isBatchShim,
  parseEditorCommandLine,
  promptEditorSpawnSpec,
  shellBinarySpec,
  shellCommandSpec,
  shimShellOption,
  terminalEditorSpawnSpec,
} from '../../src/utils/platform/spawn.js'
const SPAWN: Row[] = [
  {
    name: 'spawn.commandShellOption',
    answers: () => commandShellOption(),
    recorded: {"win32":true,"darwin":"/bin/sh","linux":"/bin/sh","win32 by process.platform alone":true,"win32 by getPlatform() alone":"/bin/sh"},
  },
  {
    name: 'spawn.shellCommandSpec',
    answers: () => [
      shellCommandSpec(['winget', 'upgrade', 'Mercury'], undefined),
      shellCommandSpec(['brew', 'upgrade', 'mercury'], 'C:\\Windows\\System32\\cmd.exe'),
      shellCommandSpec([], undefined),
    ],
    recorded: {"win32":[{"file":"cmd.exe","args":["/d","/s","/c","\"winget upgrade Mercury\""],"windowsVerbatimArguments":true},{"file":"C:\\Windows\\System32\\cmd.exe","args":["/d","/s","/c","\"brew upgrade mercury\""],"windowsVerbatimArguments":true},{"file":"cmd.exe","args":["/d","/s","/c","\"\""],"windowsVerbatimArguments":true}],"darwin":[{"file":"winget","args":["upgrade","Mercury"],"windowsVerbatimArguments":false},{"file":"brew","args":["upgrade","mercury"],"windowsVerbatimArguments":false},{"file":"","args":[],"windowsVerbatimArguments":false}],"linux":[{"file":"winget","args":["upgrade","Mercury"],"windowsVerbatimArguments":false},{"file":"brew","args":["upgrade","mercury"],"windowsVerbatimArguments":false},{"file":"","args":[],"windowsVerbatimArguments":false}],"win32 by process.platform alone":[{"file":"cmd.exe","args":["/d","/s","/c","\"winget upgrade Mercury\""],"windowsVerbatimArguments":true},{"file":"C:\\Windows\\System32\\cmd.exe","args":["/d","/s","/c","\"brew upgrade mercury\""],"windowsVerbatimArguments":true},{"file":"cmd.exe","args":["/d","/s","/c","\"\""],"windowsVerbatimArguments":true}],"win32 by getPlatform() alone":[{"file":"winget","args":["upgrade","Mercury"],"windowsVerbatimArguments":false},{"file":"brew","args":["upgrade","mercury"],"windowsVerbatimArguments":false},{"file":"","args":[],"windowsVerbatimArguments":false}]},
  },
  {
    name: 'spawn.shellBinarySpec',
    answers: () => [
      shellBinarySpec('C:\\Program Files\\Mercury\\mercury.cmd', ['--version'], undefined),
      shellBinarySpec('/usr/local/bin/mercury', ['--version'], 'C:\\cmd.exe'),
      shellBinarySpec('mercury', [], undefined),
    ],
    recorded: {"win32":[{"file":"cmd.exe","args":["/d","/s","/c","\"\"C:\\Program Files\\Mercury\\mercury.cmd\" --version\""],"windowsVerbatimArguments":true},{"file":"C:\\cmd.exe","args":["/d","/s","/c","\"\"/usr/local/bin/mercury\" --version\""],"windowsVerbatimArguments":true},{"file":"cmd.exe","args":["/d","/s","/c","\"\"mercury\"\""],"windowsVerbatimArguments":true}],"darwin":[{"file":"C:\\Program Files\\Mercury\\mercury.cmd","args":["--version"],"windowsVerbatimArguments":false},{"file":"/usr/local/bin/mercury","args":["--version"],"windowsVerbatimArguments":false},{"file":"mercury","args":[],"windowsVerbatimArguments":false}],"linux":[{"file":"C:\\Program Files\\Mercury\\mercury.cmd","args":["--version"],"windowsVerbatimArguments":false},{"file":"/usr/local/bin/mercury","args":["--version"],"windowsVerbatimArguments":false},{"file":"mercury","args":[],"windowsVerbatimArguments":false}],"win32 by process.platform alone":[{"file":"cmd.exe","args":["/d","/s","/c","\"\"C:\\Program Files\\Mercury\\mercury.cmd\" --version\""],"windowsVerbatimArguments":true},{"file":"C:\\cmd.exe","args":["/d","/s","/c","\"\"/usr/local/bin/mercury\" --version\""],"windowsVerbatimArguments":true},{"file":"cmd.exe","args":["/d","/s","/c","\"\"mercury\"\""],"windowsVerbatimArguments":true}],"win32 by getPlatform() alone":[{"file":"C:\\Program Files\\Mercury\\mercury.cmd","args":["--version"],"windowsVerbatimArguments":false},{"file":"/usr/local/bin/mercury","args":["--version"],"windowsVerbatimArguments":false},{"file":"mercury","args":[],"windowsVerbatimArguments":false}]},
  },
  {
    name: 'spawn.hostShellHint',
    answers: () => [
      hostShellHint({ PSModulePath: 'C:\\Mods', ComSpec: 'C:\\cmd.exe', SHELL: '/bin/zsh' }),
      hostShellHint({ ComSpec: 'C:\\cmd.exe' }),
      hostShellHint({ SHELL: '/bin/bash' }),
      hostShellHint({}),
      hostShellHint({ PSModulePath: '', ComSpec: 'C:\\cmd.exe', SHELL: '' }),
    ],
    recorded: {"win32":["powershell","cmd","unknown","unknown","cmd"],"darwin":["posix-sh","unknown","posix-sh","unknown","unknown"],"linux":["posix-sh","unknown","posix-sh","unknown","unknown"],"win32 by process.platform alone":["powershell","cmd","unknown","unknown","cmd"],"win32 by getPlatform() alone":["posix-sh","unknown","posix-sh","unknown","unknown"]},
  },
  {
    name: 'spawn.isBatchShim',
    answers: () => [
      isBatchShim('C:\\tools\\code.cmd'),
      isBatchShim('C:\\tools\\RUN.BAT'),
      isBatchShim('C:\\tools\\node.exe'),
      isBatchShim('/usr/bin/code.cmd'),
      isBatchShim(''),
    ],
    recorded: {"win32":[true,true,false,true,false],"darwin":[false,false,false,false,false],"linux":[false,false,false,false,false],"win32 by process.platform alone":[true,true,false,true,false],"win32 by getPlatform() alone":[false,false,false,false,false]},
  },
  {
    name: 'spawn.shimShellOption',
    answers: () => shimShellOption(),
    recorded: {"win32":{"shell":true},"darwin":{},"linux":{},"win32 by process.platform alone":{"shell":true},"win32 by getPlatform() alone":{}},
  },
  {
    name: 'spawn.commandShellArgv',
    answers: () => [commandShellArgv('echo hello'), commandShellArgv('')],
    recorded: {"win32":[["cmd.exe","/d","/s","/c","echo hello"],["cmd.exe","/d","/s","/c",""]],"darwin":[["/bin/sh","-c","echo hello"],["/bin/sh","-c",""]],"linux":[["/bin/sh","-c","echo hello"],["/bin/sh","-c",""]],"win32 by process.platform alone":[["cmd.exe","/d","/s","/c","echo hello"],["cmd.exe","/d","/s","/c",""]],"win32 by getPlatform() alone":[["/bin/sh","-c","echo hello"],["/bin/sh","-c",""]]},
  },
  {
    name: 'spawn.executableNeedsVerbatimArgs',
    answers: () => [
      executableNeedsVerbatimArgs('cmd.exe'),
      executableNeedsVerbatimArgs('C:\\Windows\\System32\\CMD.EXE'),
      executableNeedsVerbatimArgs('cmd'),
      executableNeedsVerbatimArgs('/bin/sh'),
      executableNeedsVerbatimArgs('mycmd.exe'),
    ],
    recorded: {"win32":[true,true,true,false,false],"darwin":[false,false,false,false,false],"linux":[false,false,false,false,false],"win32 by process.platform alone":[true,true,true,false,false],"win32 by getPlatform() alone":[false,false,false,false,false]},
  },
  {
    name: 'spawn.hostScriptDialect',
    answers: () => hostScriptDialect(),
    recorded: {"win32":"powershell","darwin":"posix-sh","linux":"posix-sh","win32 by process.platform alone":"powershell","win32 by getPlatform() alone":"posix-sh"},
  },
  {
    name: 'spawn.parseEditorCommandLine',
    answers: () => [
      parseEditorCommandLine('"C:\\Program Files\\Code\\code.exe" --wait', { platform: process.platform, path: '' }),
      parseEditorCommandLine("vim -u 'NONE'", { platform: process.platform, path: '' }),
      parseEditorCommandLine('nano', { platform: process.platform, path: '' }),
    ],
    recorded: {"win32":[{"executable":"C:\\Program Files\\Code\\code.exe","args":["--wait"]},{"executable":"vim","args":["-u","'NONE'"]},{"executable":"nano","args":[]}],"darwin":[{"executable":"C:\\Program Files\\Code\\code.exe","args":["--wait"]},{"executable":"vim","args":["-u","NONE"]},{"executable":"nano","args":[]}],"linux":[{"executable":"C:\\Program Files\\Code\\code.exe","args":["--wait"]},{"executable":"vim","args":["-u","NONE"]},{"executable":"nano","args":[]}],"win32 by process.platform alone":[{"executable":"C:\\Program Files\\Code\\code.exe","args":["--wait"]},{"executable":"vim","args":["-u","'NONE'"]},{"executable":"nano","args":[]}],"win32 by getPlatform() alone":[{"executable":"C:\\Program Files\\Code\\code.exe","args":["--wait"]},{"executable":"vim","args":["-u","NONE"]},{"executable":"nano","args":[]}]},
  },
  {
    name: 'spawn.editorInvocationOf',
    answers: () => [
      editorInvocationOf('C:\\Program Files\\ed.exe', 'C:\\Program Files\\ed.exe', { executable: 'C:\\Program Files\\ed.exe', args: ['--wait'] }),
      editorInvocationOf('code', 'code -w', { executable: 'code', args: [] }),
    ],
    recorded: {"win32":[{"executablePath":"C:\\Program Files\\ed.exe","args":["--wait"]},{"executablePath":"code","args":["-w"]}],"darwin":[{"executablePath":"C:Program","args":["Filesed.exe"]},{"executablePath":"code","args":["-w"]}],"linux":[{"executablePath":"C:Program","args":["Filesed.exe"]},{"executablePath":"code","args":["-w"]}],"win32 by process.platform alone":[{"executablePath":"C:\\Program Files\\ed.exe","args":["--wait"]},{"executablePath":"code","args":["-w"]}],"win32 by getPlatform() alone":[{"executablePath":"C:Program","args":["Filesed.exe"]},{"executablePath":"code","args":["-w"]}]},
  },
  {
    name: 'spawn.editorShellCommandLine',
    answers: () => [
      editorShellCommandLine('/usr/bin/vim', ['-n'], "/tmp/a'b.txt"),
      editorShellCommandLine('C:\\bin\\code.cmd', ['-w'], 'C:\\Users\\100%\\a.txt'),
    ],
    recorded: {"win32":["\"/usr/bin/vim\" \"-n\" \"%MERCURY_EDITOR_FILE%\"","\"C:\\bin\\code.cmd\" \"-w\" \"%MERCURY_EDITOR_FILE%\""],"darwin":["\"/usr/bin/vim\" \"-n\" '/tmp/a'\\''b.txt'","\"C:\\bin\\code.cmd\" \"-w\" 'C:\\Users\\100%\\a.txt'"],"linux":["\"/usr/bin/vim\" \"-n\" '/tmp/a'\\''b.txt'","\"C:\\bin\\code.cmd\" \"-w\" 'C:\\Users\\100%\\a.txt'"],"win32 by process.platform alone":["\"/usr/bin/vim\" \"-n\" \"%MERCURY_EDITOR_FILE%\"","\"C:\\bin\\code.cmd\" \"-w\" \"%MERCURY_EDITOR_FILE%\""],"win32 by getPlatform() alone":["\"/usr/bin/vim\" \"-n\" '/tmp/a'\\''b.txt'","\"C:\\bin\\code.cmd\" \"-w\" 'C:\\Users\\100%\\a.txt'"]},
  },
  {
    name: 'spawn.promptEditorSpawnSpec',
    answers: () => [
      promptEditorSpawnSpec('C:\\bin\\code.cmd', ['-w'], 'C:\\tmp\\p.txt', 'C:\\Windows\\System32\\cmd.exe'),
      promptEditorSpawnSpec('C:\\bin\\code.cmd', ['-w'], 'C:\\tmp\\p.txt', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'),
      promptEditorSpawnSpec('/usr/bin/vim', [], "/tmp/a'b.txt", undefined),
    ],
    recorded: {"win32":[{"shell":false,"file":"C:\\Windows\\System32\\cmd.exe","args":["/d","/v:off","/s","/c","\"\"C:\\bin\\code.cmd\" \"-w\" \"%MERCURY_EDITOR_FILE%\"\""],"windowsVerbatimArguments":true,"extraEnv":{"MERCURY_EDITOR_FILE":"C:\\tmp\\p.txt"}},{"shell":false,"file":"C:\\Program Files\\PowerShell\\7\\pwsh.exe","args":["-NoLogo","-NoProfile","-Command","& 'C:\\bin\\code.cmd' '-w' $env:MERCURY_EDITOR_FILE"],"windowsVerbatimArguments":false,"extraEnv":{"MERCURY_EDITOR_FILE":"C:\\tmp\\p.txt"}},{"shell":false,"file":"cmd.exe","args":["/d","/v:off","/s","/c","\"\"/usr/bin/vim\" \"%MERCURY_EDITOR_FILE%\"\""],"windowsVerbatimArguments":true,"extraEnv":{"MERCURY_EDITOR_FILE":"/tmp/a'b.txt"}}],"darwin":[{"shell":true,"commandLine":"\"C:\\bin\\code.cmd\" \"-w\" 'C:\\tmp\\p.txt'"},{"shell":true,"commandLine":"\"C:\\bin\\code.cmd\" \"-w\" 'C:\\tmp\\p.txt'"},{"shell":true,"commandLine":"\"/usr/bin/vim\" '/tmp/a'\\''b.txt'"}],"linux":[{"shell":true,"commandLine":"\"C:\\bin\\code.cmd\" \"-w\" 'C:\\tmp\\p.txt'"},{"shell":true,"commandLine":"\"C:\\bin\\code.cmd\" \"-w\" 'C:\\tmp\\p.txt'"},{"shell":true,"commandLine":"\"/usr/bin/vim\" '/tmp/a'\\''b.txt'"}],"win32 by process.platform alone":[{"shell":false,"file":"C:\\Windows\\System32\\cmd.exe","args":["/d","/v:off","/s","/c","\"\"C:\\bin\\code.cmd\" \"-w\" \"%MERCURY_EDITOR_FILE%\"\""],"windowsVerbatimArguments":true,"extraEnv":{"MERCURY_EDITOR_FILE":"C:\\tmp\\p.txt"}},{"shell":false,"file":"C:\\Program Files\\PowerShell\\7\\pwsh.exe","args":["-NoLogo","-NoProfile","-Command","& 'C:\\bin\\code.cmd' '-w' $env:MERCURY_EDITOR_FILE"],"windowsVerbatimArguments":false,"extraEnv":{"MERCURY_EDITOR_FILE":"C:\\tmp\\p.txt"}},{"shell":false,"file":"cmd.exe","args":["/d","/v:off","/s","/c","\"\"/usr/bin/vim\" \"%MERCURY_EDITOR_FILE%\"\""],"windowsVerbatimArguments":true,"extraEnv":{"MERCURY_EDITOR_FILE":"/tmp/a'b.txt"}}],"win32 by getPlatform() alone":[{"shell":true,"commandLine":"\"C:\\bin\\code.cmd\" \"-w\" 'C:\\tmp\\p.txt'"},{"shell":true,"commandLine":"\"C:\\bin\\code.cmd\" \"-w\" 'C:\\tmp\\p.txt'"},{"shell":true,"commandLine":"\"/usr/bin/vim\" '/tmp/a'\\''b.txt'"}]},
  },
  {
    name: 'spawn.guiEditorSpawnSpec',
    answers: () => [
      guiEditorSpawnSpec('C:\\Program Files\\Code\\code.exe', 'C:\\Program Files\\Code\\code.exe', [], ['-g', 'f.ts:10'], true),
      guiEditorSpawnSpec('code --reuse-window', 'code', ['--reuse-window'], ['-g', 'f.ts:10'], false),
    ],
    recorded: {"win32":[{"shell":true,"command":"\"C:\\Program Files\\Code\\code.exe\" \"-g\" \"f.ts:10\""},{"shell":true,"command":"\"code\" \"--reuse-window\" \"-g\" \"f.ts:10\""}],"darwin":[{"shell":false,"file":"C:\\Program Files\\Code\\code.exe","args":["-g","f.ts:10"]},{"shell":false,"file":"code","args":["--reuse-window","-g","f.ts:10"]}],"linux":[{"shell":false,"file":"C:\\Program Files\\Code\\code.exe","args":["-g","f.ts:10"]},{"shell":false,"file":"code","args":["--reuse-window","-g","f.ts:10"]}],"win32 by process.platform alone":[{"shell":true,"command":"\"C:\\Program Files\\Code\\code.exe\" \"-g\" \"f.ts:10\""},{"shell":true,"command":"\"code\" \"--reuse-window\" \"-g\" \"f.ts:10\""}],"win32 by getPlatform() alone":[{"shell":false,"file":"C:\\Program Files\\Code\\code.exe","args":["-g","f.ts:10"]},{"shell":false,"file":"code","args":["--reuse-window","-g","f.ts:10"]}]},
  },
  {
    name: 'spawn.terminalEditorSpawnSpec',
    answers: () => [
      terminalEditorSpawnSpec('vim -n', 'vim', ['-n'], ['+42'], '/tmp/a b.ts'),
      terminalEditorSpawnSpec('nano', 'nano', [], [], 'C:\\tmp\\a b.ts'),
    ],
    recorded: {"win32":[{"shell":true,"command":"vim -n +42 \"/tmp/a b.ts\""},{"shell":true,"command":"nano \"C:\\tmp\\a b.ts\""}],"darwin":[{"shell":false,"file":"vim","args":["-n","+42","/tmp/a b.ts"]},{"shell":false,"file":"nano","args":["C:\\tmp\\a b.ts"]}],"linux":[{"shell":false,"file":"vim","args":["-n","+42","/tmp/a b.ts"]},{"shell":false,"file":"nano","args":["C:\\tmp\\a b.ts"]}],"win32 by process.platform alone":[{"shell":true,"command":"vim -n +42 \"/tmp/a b.ts\""},{"shell":true,"command":"nano \"C:\\tmp\\a b.ts\""}],"win32 by getPlatform() alone":[{"shell":false,"file":"vim","args":["-n","+42","/tmp/a b.ts"]},{"shell":false,"file":"nano","args":["C:\\tmp\\a b.ts"]}]},
  },
]

const PROCESSES: Row[] = [
]

const FILES: Row[] = [
]

const TERMINAL: Row[] = [
]

const DESKTOP: Row[] = [
]

const ROWS = [...PATHS, ...PROGRAMS, ...SPAWN, ...PROCESSES, ...FILES, ...TERMINAL, ...DESKTOP]

const show = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v === undefined ? 'undefined' : v instanceof RegExp || typeof v === 'bigint' || typeof v === 'function' ? String(v) : v instanceof Map || v instanceof Set ? [...v] : v,
  )

async function standIn(stand: Stand, read: (stand: Stand) => unknown): Promise<string> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...real, value: stand.node })
  getPlatform.cache.set(undefined, stand.house)
  try {
    return show(await read(stand))
  } catch (error) {
    return show(`threw ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    Object.defineProperty(process, 'platform', real)
    getPlatform.cache.delete(undefined)
  }
}

console.log('============================================================')
console.log(' platform modules — each function answers as the inline code it replaced')
console.log('============================================================')

const record = process.argv.includes('--record')
let failed = 0
for (const row of ROWS) {
  const recording: Record<string, unknown> = {}
  for (const stand of row.stands ?? STANDS) {
    const got = await standIn(stand, row.answers)
    recording[stand.name] = JSON.parse(got)
    if (record) continue
    const want = row.old ? await standIn(stand, row.old) : row.recorded && stand.name in row.recorded ? show(row.recorded[stand.name]) : undefined
    const ok = got === want
    if (!ok) failed++
    const against = want === undefined ? 'the row holds neither the old code nor a recorded answer' : `${row.old ? 'the old code' : 'the recording'} answers ${want}`
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${row.name} · ${stand.name}${ok ? '' : ` — the function answers ${got}, ${against}`}`)
  }
  if (record) console.log(`${row.name}\n    recorded: ${JSON.stringify(recording)},`)
}

console.log(failed === 0 ? `\nALL PLATFORM-MODULE CHECKS PASS (${ROWS.length} rows)` : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
