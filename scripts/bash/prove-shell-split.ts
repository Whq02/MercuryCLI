#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

let failures = 0
const splitFailHint = 'change getGlobPreambleCommand (src/platform/shell/globPreamble.ts) or where buildExecCommand puts the preamble in the frame (createBashShellProvider in src/platform/shell/bashProvider.ts)'
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${ok ? '' : `${detail ? ' · ' : ' — '}${splitFailHint}`}`)
  if (!ok) failures = 1
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'shell-split-')))
const userHome = join(scratch, 'user-home')
mkdirSync(userHome)
process.env.HOME = userHome
process.env.SHELL = '/bin/zsh'
const hadPrefix = process.env.MERCURY_SHELL_PREFIX
delete process.env.MERCURY_SHELL_PREFIX
delete process.env.MERCURY_SHELL_ENGINE
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { resolveBashPackDir } = await import('../../src/platform/shell/bashPack.ts')
const { resolveBrushPackDir } = await import('../../src/platform/shell/brushPack.ts')
const { getGlobPreambleCommand } = await import('../../src/platform/shell/globPreamble.ts')
const { createBashShellProvider } = await import('../../src/platform/shell/bashProvider.ts')
const { createEngineCommandProvider } = await import('../../src/platform/shell/engineSession.ts')
const { systemShellRecord } = await import('../../src/platform/shell/shellRecord.ts')
const { exec, setCwd } = await import('../../src/platform/shell/shellExec.ts')
setCwd(scratch)

const singleQuoted = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`
const chain = (preamble: string | null, scene: string, before: string[] = []): string =>
  [...before, ...(preamble === null ? [] : [preamble]), `eval ${singleQuoted(scene)} < /dev/null`].join(' && ')
const run = (shell: string, command: string) => spawnSync(shell, ['-c', command], { encoding: 'utf8' })
const lines = (out: string): string[] => out.split('\n').filter(line => line !== '')
const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((line, i) => line === b[i])
const show = (r: { status: number | null; stdout: string; stderr: string }): string =>
  `status=${r.status} stdout=${JSON.stringify(r.stdout)}${r.stderr.trim() ? ` stderr=${JSON.stringify(r.stderr.trim())}` : ''}`

const SPLIT = `X="a b c"; printf '%s\\n' $X`
const QUOTED = `X="a b c"; printf '%s\\n' "$X"`
const COUNT = `X="a b c"; set -- $X; echo $#`
const LOOP = `X="a b c"; for p in $X; do echo "[$p]"; done`
const GLOB = `echo /tmp/__no_such_dir_${process.pid}/*.yml`
const OPTION = 'shopt -q extglob; echo "extglob=$?"'
const THREE = ['a', 'b', 'c']
const ONE = ['a b c']
const WALKED = ['[a]', '[b]', '[c]']

const preamble = getGlobPreambleCommand('shipped')
const snapshot = join(scratch, 'snapshot.sh')
writeFileSync(snapshot, 'unalias -a 2>/dev/null || true\nshopt -s extglob\n')

console.log('— the shell the system road runs —')
const road = await systemShellRecord()
t('the road names a bash, or the engine where no bash starts, whatever $SHELL names (here /bin/zsh)', road.dialect === 'bash' && (road.origin === 'engine' || basename(road.path) === 'bash'), `${road.origin} ${road.path}`)
console.log(`      the road: ${road.origin} ${road.path} ${road.version}`)

const pack = resolveBashPackDir()
const shells: Array<[string, string]> = [
  ...(pack.state === 'ok' ? [[`the shipped bash ${pack.manifest.bashVersion}`, pack.binaryPath] as [string, string]] : []),
  ...(existsSync('/bin/bash') ? [['the system bash at /bin/bash', '/bin/bash'] as [string, string]] : []),
]
t('a bash stands under this proof', shells.length > 0 && preamble !== null, pack.state === 'ok' ? '' : pack.note)

for (const [name, shell] of shells) {
  console.log(`— ${name}: an unquoted expansion splits into words, a quoted one stays whole —`)
  const split = run(shell, chain(preamble, SPLIT))
  t(`${name} + preamble: printf over an unquoted $X prints three lines`, split.status === 0 && same(lines(split.stdout), THREE), show(split))
  const quoted = run(shell, chain(preamble, QUOTED))
  t(`${name} + preamble: the quoted "$X" stays one line`, quoted.status === 0 && same(lines(quoted.stdout), ONE), show(quoted))
  const count = run(shell, chain(preamble, COUNT))
  t(`${name} + preamble: set -- $X counts 3`, count.status === 0 && same(lines(count.stdout), ['3']), show(count))
  const loop = run(shell, chain(preamble, LOOP))
  t(`${name} + preamble: for p in $X walks three words`, loop.status === 0 && same(lines(loop.stdout), WALKED), show(loop))
  const glob = run(shell, chain(preamble, GLOB))
  t(`${name} + preamble: the unmatched glob passes through literally, exit 0`, glob.status === 0 && glob.stdout.includes('__no_such_dir_'), show(glob))
  const sourced = [`source ${singleQuoted(snapshot)} 2>/dev/null || true`]
  const control = run(shell, chain(null, OPTION, sourced))
  t(`CONTROL: ${name} after a snapshot that switches extglob on reads it on`, same(lines(control.stdout), ['extglob=0']), show(control))
  const after = run(shell, chain(preamble, OPTION, sourced))
  t(`${name}: the preamble runs after the snapshot and wins, extglob reads off`, same(lines(after.stdout), ['extglob=1']), show(after))
}

console.log('— through the road itself: exec() hands the command to the shell its record names —')
{
  const scenes: Array<[string, string, string[]]> = [
    ['printf over an unquoted $X prints three lines', SPLIT, THREE],
    ['the quoted "$X" stays one line', QUOTED, ONE],
    ['set -- $X counts 3', COUNT, ['3']],
    ['for p in $X walks three words', LOOP, WALKED],
    ['extglob reads off', OPTION, ['extglob=1']],
  ]
  for (const [name, scene, want] of scenes) {
    const handle = await exec(scene, new AbortController().signal, 'bash', { timeout: 30_000, preventCwdChanges: true })
    const result = await handle.result
    handle.cleanup()
    t(`the road: ${name}`, result.code === 0 && same(lines(result.stdout), want), `code=${result.code} stdout=${JSON.stringify(result.stdout)}`)
  }
}

console.log('— wiring: both roads put the snapshot before the preamble —')
{
  const provider = await createBashShellProvider(road.origin === 'engine' ? { ...road, origin: 'system' } : road)
  const built = await provider.buildExecCommand('echo wired', { id: 'shell-split-proof' })
  const sourceAt = built.commandString.indexOf('source ')
  const preambleAt = built.commandString.indexOf(String(preamble))
  const evalAt = built.commandString.indexOf('eval ')
  t('the system road: the sourced snapshot, then the preamble, then the command, in one && chain', sourceAt >= 0 && sourceAt < preambleAt && preambleAt < evalAt, built.commandString.slice(0, 200))

  const engine = resolveBrushPackDir()
  if (engine.state === 'ok') {
    process.env.MERCURY_SHELL_PREFIX = 'env'
    const perCommand = await createEngineCommandProvider(engine.binaryPath).buildExecCommand('echo wired', { id: 'shell-split-engine-proof' })
    delete process.env.MERCURY_SHELL_PREFIX
    const engineSource = perCommand.commandString.indexOf('source ')
    const enginePreamble = perCommand.commandString.indexOf(String(preamble))
    t(
      `the engine under a shell prefix: ${engineSource === -1 ? 'the preamble (the engine took no snapshot here)' : 'the sourced snapshot, then the preamble'}, in one frame before the command`,
      enginePreamble >= 0 && engineSource < enginePreamble && enginePreamble < perCommand.commandString.indexOf('eval '),
      perCommand.commandString.slice(0, 200),
    )
    const bare = await createEngineCommandProvider(engine.binaryPath).buildExecCommand('echo wired', { id: 'shell-split-engine-bare' })
    t('the engine with no prefix takes no preamble', !bare.commandString.includes(String(preamble)), bare.commandString.slice(0, 200))
  } else {
    t('SKIP the engine legs — the engine pack is absent on this machine', true, engine.note)
  }
}

rmSync(scratch, { recursive: true, force: true })
void proofHome
if (hadPrefix !== undefined) process.env.MERCURY_SHELL_PREFIX = hadPrefix
console.log(failures ? '\nSHELL-SPLIT RED' : '\nSHELL-SPLIT GREEN')
process.exit(failures)
