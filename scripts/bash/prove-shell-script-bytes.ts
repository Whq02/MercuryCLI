#!/usr/bin/env bun
import { plugin } from 'bun'
import '../lib/hermetic.ts'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const name of ['MERCURY_SHELL_ENGINE', 'MERCURY_SHELL_PREFIX']) delete process.env[name]

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const note = (text: string): void => console.log(`        note: ${text}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const show = (text: string, limit = 80): string => JSON.stringify(text.length > limit ? text.slice(0, limit) + '…' : text)

console.log('============================================================')
console.log(' The Bash tool script — what bash runs is what the model sent')
console.log('============================================================')

const { locateGitBash } = await import('../../src/utils/windowsPaths.ts')
const gitBash = process.platform === 'win32' ? locateGitBash() : null
if (gitBash !== null && 'path' in gitBash) process.env.SHELL = gitBash.path
else if (!(process.env.SHELL ?? '').includes('bash') && existsSync('/bin/bash')) process.env.SHELL = '/bin/bash'

const { exec, setCwd, getShellConfig } = await import('../../src/utils/Shell.ts')
const { getCwd } = await import('../../src/utils/cwd.ts')
const { getPlatform } = await import('../../src/utils/platform.ts')
const { createBashShellProvider } = await import('../../src/utils/shell/bashProvider.ts')
const { createPowerShellProvider } = await import('../../src/utils/shell/powershellProvider.ts')

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'shell-script-bytes-')))
setCwd(SCRATCH)

const siblingsOf = (shell: string): string[] => {
  const root = /[\\/]usr[\\/]bin[\\/]bash\.exe$/i.test(shell) ? dirname(dirname(dirname(shell))) : dirname(dirname(shell))
  return [join(root, 'bin', 'bash.exe'), join(root, 'usr', 'bin', 'bash.exe')].filter(path => existsSync(path) && path.toLowerCase() !== shell.toLowerCase())
}

const primary = (await getShellConfig()).provider.shellPath
const shells = [primary, ...(getPlatform() === 'windows' ? siblingsOf(primary) : [])]
note(`platform ${getPlatform()}; shells under proof: ${shells.join(' · ')}`)

const BS = '\\'
const printing = (content: string): string => `printf %s '${content.split("'").join(`'\\''`)}'`

let seed = 20260515
const nextRandom = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 0x100000000
}
const NASTY = ['\\', '\\', '\\', '"', "'", ' ', '\n', '\t', 'a', 'z', '0', '*', '?', '[', '{', '(', '$', '|', ';', '<', 'é', '日', '😀']
const randomContent = (): string => {
  let text = ''
  const length = 1 + Math.floor(nextRandom() * 90)
  for (let i = 0; i < length; i++) text += NASTY[Math.floor(nextRandom() * NASTY.length)]
  return text
}

const NAMED: Array<[string, string]> = [
  ['the reported pairs and fours between words', String.raw`a\\b c\\\\d`],
  ['a UNC path and a drive path with doubled separators', String.raw`\\server\share\dir C:\\Users\\me\\x.txt`],
  ['sed-style expressions', String.raw`s/\\\\/\\//g /\\\\/ \\`],
  ['runs right before a double quote', String.raw`"a\\\\" "b\\\\\"c" "d\\\"e" "f\\"`],
  ['lines of pairs and fours with a lone backslash', 'line\\\\one\n\\\\\\\\two \\three\nend'],
  ['non-ASCII text next to pairs', String.raw`é\\日本\\\\😀\\ß`],
  ['tabs and newlines between runs', 'x\\\\\n\\\\\\\t\\\\\\\\\n\\\\ y\t\\\\\n'],
  ['single quotes next to pairs', String.raw`it's \\ ok 'a\\b' ''\\''`],
  ['a run of nine and a run of three before a letter', String.raw`x\\\\\\\\\y z\\\q`],
  ['a long line: two thousand pairs', 'a\\\\'.repeat(2000)],
]

const contexts = ['a', ' ', '"', "'", '\n', '\t', '[', '*', 'é', '']
const GENERATED: string[] = []
for (let run = 1; run <= 9; run++) for (const after of contexts) GENERATED.push(`x${BS.repeat(run)}${after}`)
const RANDOM: string[] = Array.from({ length: 60 }, randomContent)

type Shot = { out: string; code: number | null }
function runShell(shell: string, args: string[]): Promise<Shot> {
  return new Promise(resolveShot => {
    const child = spawn(shell, args, { cwd: SCRATCH, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => child.kill(), 30_000)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', () => {
      clearTimeout(timer)
      resolveShot({ out: '', code: null })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolveShot({ out: Buffer.concat(chunks).toString('utf8'), code })
    })
  })
}

async function inBatches<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let at = 0; at < items.length; at += size) results.push(...(await Promise.all(items.slice(at, at + size).map(work))))
  return results
}

type Provider = Awaited<ReturnType<typeof createBashShellProvider>>
async function primed(shell: string): Promise<Provider> {
  const provider = await createBashShellProvider(shell)
  await provider.buildExecCommand('true', { id: 'prime', useSandbox: false })
  return provider
}

type Round = { want: string; got: string }
async function raw(provider: Provider, shell: string, script: string, want: string): Promise<Round> {
  const shot = await runShell(shell, provider.getSpawnArgs(script))
  return { want, got: shot.out }
}

let buildCount = 0
async function built(provider: Provider, shell: string, content: string): Promise<Round> {
  const { commandString } = await provider.buildExecCommand(printing(content), { id: `bytes-${++buildCount}`, useSandbox: false })
  const shot = await runShell(shell, provider.getSpawnArgs(commandString))
  return { want: content, got: shot.out }
}

const firstMiss = (rows: Round[]): string => {
  const miss = rows.find(row => row.got !== row.want)
  return miss === undefined ? '' : `the script printed ${show(miss.want)} for bash, which printed ${show(miss.got)}`
}

const providers = new Map<string, Provider>()
for (const shell of shells) providers.set(shell, await primed(shell))

for (const shell of shells) {
  const provider = providers.get(shell) as Provider
  section(`§1 a script reaches bash byte for byte — ${shell}`)
  const named = await inBatches(NAMED, 4, ([, content]) => raw(provider, shell, printing(content), content))
  NAMED.forEach(([label], i) => check(label, named[i]!.got === named[i]!.want, firstMiss([named[i]!])))
  const tail = await raw(provider, shell, `printf %s x${BS.repeat(4)}`, `x${BS.repeat(2)}`)
  check('a run of four at the very end of the script', tail.got === tail.want, firstMiss([tail]))
  if (shell !== primary) continue
  const generated = await inBatches(GENERATED, 4, content => raw(provider, shell, printing(content), content))
  check(`runs of 1 to 9 backslashes before ${contexts.length} different next characters (${GENERATED.length} scripts)`, generated.every(row => row.got === row.want), firstMiss(generated))
  const random = await inBatches(RANDOM, 4, content => raw(provider, shell, printing(content), content))
  check(`a seeded random corpus of quotes, runs, controls and non-ASCII (${RANDOM.length} scripts)`, random.every(row => row.got === row.want), firstMiss(random))
}

section('§2 the composed command string — the eval wrapper the tool builds, through the real provider')
{
  const provider = providers.get(primary) as Provider
  const rows = await inBatches(NAMED.slice(0, 9), 4, ([, content]) => built(provider, primary, content))
  check('bash prints what each of nine named commands holds, through buildExecCommand', rows.every(row => row.got === row.want), firstMiss(rows))
  const randomBuilt = await inBatches(RANDOM.slice(0, 16), 4, content => built(provider, primary, content))
  check('…and for a random subset of 16', randomBuilt.every(row => row.got === row.want), firstMiss(randomBuilt))
  const command = String.raw`printf '%s\n' 'a\\b' 'c\\\\d'`
  const { commandString } = await provider.buildExecCommand(command, { id: 'shape', useSandbox: false })
  check('the model command still sits verbatim inside the eval quotes of the composed string', commandString.includes(`eval '${command.split("'").join(`'\\''`)}'`), commandString.slice(0, 200))
  check('the working-directory record still ends the composed string', commandString.includes('pwd -P >|') && (getPlatform() !== 'windows' || commandString.trimEnd().endsWith('|| true; }')))
}

section('§3 through the real exec seam, what the user sees')
const run = async (command: string): Promise<{ code: number; out: string }> => {
  const handle = await exec(command, new AbortController().signal, 'bash', { timeout: 20_000, shouldAutoBackground: false })
  const result = await handle.result
  return { code: result.code, out: result.stdout }
}
{
  const reported = await run(String.raw`printf '%s\n' 'a\\b' 'c\\\\d'`)
  check('the reported printf prints every backslash it was given', reported.out === String.raw`a\\b` + '\n' + String.raw`c\\\\d` + '\n', show(reported.out))
  const drive = await run(String.raw`echo 'C:\\Users\\me\\x.txt'`)
  check('a drive path with doubled separators prints as typed', drive.out === String.raw`C:\\Users\\me\\x.txt` + '\n', show(drive.out))
  const quoted = await run(String.raw`printf '%s' "x\\\\" "y\\\"z"`)
  check('doubled backslashes inside double quotes reach bash and collapse once, there', quoted.out === String.raw`x\\` + String.raw`y\"z`, show(quoted.out))
  const heredoc = await run('cat <<\'EOF\'\nA\\\\B\nEOF')
  check('a heredoc keeps its pair', heredoc.out === String.raw`A\\B` + '\n', show(heredoc.out))
  const sed = await run(String.raw`printf '%s\n' 'a\\b' | sed 's/\\/-/'`)
  check('a sed program that names a backslash by a pair finds it', sed.out === String.raw`a-\b` + '\n', show(sed.out))
  const moved = await run(String.raw`mkdir -p sub && cd sub && printf '%s\n' 'p\\q'`)
  check('a command with a pair that changes directory prints it', moved.code === 0 && moved.out === String.raw`p\\q` + '\n', `code ${moved.code} ${show(moved.out)}`)
  check('…and the session directory followed it (the cwd record is intact)', getCwd() === realpathSync(join(SCRATCH, 'sub')), getCwd())
  setCwd(SCRATCH)
  const exit = await run(String.raw`printf '%s' 'a\\b'; exit 7`)
  check('its own exit status survives', exit.code === 7 && exit.out === String.raw`a\\b`, `code ${exit.code} ${show(exit.out)}`)
  const missing = await run(String.raw`no_such_command_for_bytes 'x\\y'`)
  check('a missing command is still 127', missing.code === 127, `code ${missing.code}`)
}

section('§4 nothing else changes')
{
  const withSnapshot = providers.get(primary) as Provider
  const loginShell = await createBashShellProvider(primary, { skipSnapshot: true })
  const untouched = ['', 'echo hi', String.raw`echo 'a\b' "c\d" e\.f`, String.raw`printf %s "a\"b"`, String.raw`echo "x\\"`, String.raw`echo x\\`, 'echo a\\\n']
  const flagsOf = (provider: Provider): string[] => provider.getSpawnArgs('x').slice(0, -1)
  const sameArgs = (provider: Provider): boolean => untouched.every(text => JSON.stringify(provider.getSpawnArgs(text)) === JSON.stringify([...flagsOf(provider), text]))
  check('the flags are -c, and -l only when no snapshot is in use', JSON.stringify(flagsOf(loginShell)) === '["-c","-l"]' && ['["-c"]', '["-c","-l"]'].includes(JSON.stringify(flagsOf(withSnapshot))), JSON.stringify([flagsOf(loginShell), flagsOf(withSnapshot)]))
  check('a script whose runs bash already kept reaches the spawn call unchanged, on the snapshot provider', sameArgs(withSnapshot))
  check('…and on a provider that adds the login flag', sameArgs(loginShell))

  const powershell = createPowerShellProvider('pwsh')
  const psText = String.raw`Write-Output 'a\\b' "c\\\\d"`
  check('the PowerShell road hands its script over exactly as before', JSON.stringify(powershell.getSpawnArgs(psText)) === JSON.stringify(['-NoProfile', '-NonInteractive', '-Command', psText]))

  const inputs: Array<[string, string]> = [
    [String.raw`echo a\b`, String.raw`echo a\b`],
    [String.raw`echo a\\b`, String.raw`echo a\\\\b`],
    [String.raw`echo a\\\\b`, String.raw`echo a\\\\\\\\b`],
    [String.raw`echo a\\\ b`, String.raw`echo a\\\\\\ b`],
    [String.raw`echo 'a\\'`, String.raw`echo 'a\\\\'`],
    [String.raw`echo a\\` + '\nb', String.raw`echo a\\\\` + '\nb'],
    [String.raw`echo "a\\"`, String.raw`echo "a\\"`],
    [String.raw`echo "a\\\"b"`, String.raw`echo "a\\\"b"`],
    [String.raw`echo a\\`, String.raw`echo a\\`],
  ]
  const inputsFile = join(SCRATCH, 'platform-inputs.json')
  const probe = join(SCRATCH, 'platform-probe.ts')
  writeFileSync(inputsFile, JSON.stringify(inputs.map(([text]) => text)))
  writeFileSync(
    probe,
    [
      `Object.defineProperty(process, 'platform', { value: process.argv[2] })`,
      `;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }`,
      `const { readFileSync } = await import('node:fs')`,
      `const { createBashShellProvider } = await import(${JSON.stringify(join(ROOT, 'src', 'utils', 'shell', 'bashProvider.ts'))})`,
      `const provider = await createBashShellProvider('/bin/bash', { skipSnapshot: true })`,
      `const texts = JSON.parse(readFileSync(process.argv[3] as string, 'utf8')) as string[]`,
      `console.log('ARGS ' + JSON.stringify(texts.map(text => provider.getSpawnArgs(text))))`,
    ].join('\n'),
  )
  const argsOn = (platform: string): { answered: string[][] | null; detail: string } => {
    const child = spawnSync(process.execPath, ['run', probe, platform, inputsFile], { cwd: ROOT, encoding: 'utf8', env: { ...process.env }, windowsHide: true })
    const line = (child.stdout ?? '').split('\n').find(l => l.startsWith('ARGS '))
    return { answered: line === undefined ? null : (JSON.parse(line.slice(5)) as string[][]), detail: `exit ${child.status} ${show(String(child.stderr ?? '').trim())}` }
  }
  for (const platform of ['linux', 'darwin']) {
    const { answered, detail } = argsOn(platform)
    check(`on ${platform} the spawn arguments are the command string untouched`, answered !== null && answered.every((args, i) => JSON.stringify(args) === JSON.stringify(['-c', '-l', inputs[i]![0]])), detail)
  }
  const { answered, detail } = argsOn('win32')
  check(
    'on Windows a run of two or more backslashes is doubled, except before a double quote or at the end (the MSYS argument parse halves what it meets)',
    answered !== null && answered.every((args, i) => JSON.stringify(args) === JSON.stringify(['-c', '-l', inputs[i]![1]])),
    detail,
  )
}

rmSync(SCRATCH, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-shell-script-bytes: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-shell-script-bytes: all green')
process.exit(0)
