#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist} (run bun run build.ts to write dist/mercury.mjs, or pass --dist <path to the built mercury.mjs>)`); process.exit(1) }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }

const home = realpathSync(mkdtempSync(join(tmpdir(), 'run-door-ps1-')))
const cwd = join(home, 'project')
mkdirSync(cwd, { recursive: true })
seedFirstRun(home, [cwd])
const baseEnv = {
  HOME: home, PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_HOME: home, MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
}
type Run = { code: number | null; out: string; err: string }
const run = (args: string[], extraEnv: Record<string, string> = {}): Promise<Run> => new Promise(done => {
  const child = spawn('node', [dist, 'run', ...args], { cwd, env: { ...baseEnv, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', d => { out += String(d) })
  child.stderr.on('data', d => { err += String(d) })
  const guard = setTimeout(() => child.kill('SIGKILL'), 120_000)
  child.on('close', code => { clearTimeout(guard); done({ code, out, err }) })
})

const PROMPT = '-1 is a negative number. Reply with exactly: NEG'
try {
  console.log('§1 the option-boundary hint under the PowerShell launcher marker (MERCURY_LAUNCHER=ps1)')
  {
    const plain = await run(['--format', 'rows', PROMPT])
    const plainLines = plain.err.trim().split('\n')
    check('without the marker: exit 2, empty stdout, the parser line then ONE hint line', plain.code === 2 && plain.out === '' && plainLines.length === 2 && /looks like a prompt that begins with "-"/.test(plainLines[1]!), `${plain.err.slice(0, 400)} | change promptMistakenForOptionHint and exitForCommanderError in src/boot/main/cli.ts so an unknown option holding whitespace gets exit 2, empty stdout and exactly one hint line after the parser line`)
    check('without the marker the hint names the plain form and never mentions PowerShell', plainLines[1]!.includes(`run -- ${JSON.stringify(PROMPT)}`) && !/PowerShell/.test(plainLines[1]!), `${plainLines[1] ?? ''} | change promptMistakenForOptionHint in src/boot/main/cli.ts so the hint without MERCURY_LAUNCHER=ps1 reads run -- followed by the JSON-quoted prompt and never names PowerShell`)

    const ps1 = await run(['--format', 'rows', PROMPT], { MERCURY_LAUNCHER: 'ps1' })
    const ps1Lines = ps1.err.trim().split('\n')
    check('under the ps1 marker: the same exit 2, empty stdout, parser line then ONE hint line', ps1.code === 2 && ps1.out === '' && ps1Lines.length === 2 && ps1Lines[0] === plainLines[0], `${ps1.err.slice(0, 400)} | change promptMistakenForOptionHint in src/boot/main/cli.ts so the ps1 marker leaves the exit code, stdout and parser line as they are and still prints one hint line`)
    check('the hint keeps the plain form word for word', ps1Lines[1]!.startsWith(plainLines[1]!), `${ps1Lines[1] ?? ''} | change promptMistakenForOptionHint in src/boot/main/cli.ts so the ps1 hint begins with the plain hint word for word`)
    check('…and adds the PowerShell truth: the first -- is PowerShell\'s own, write it twice', /from PowerShell's \S+ command the first "--" is PowerShell's own and never reaches Mercury, so write it twice: \S+ run -- -- /.test(ps1Lines[1]!) && ps1Lines[1]!.includes(`run -- -- ${JSON.stringify(PROMPT)}`), `${ps1Lines[1] ?? ''} | change the ps1 branch of promptMistakenForOptionHint in src/boot/main/cli.ts so it says the first "--" is PowerShell's own and shows run -- -- with the quoted prompt`)
    check('…and names the cmd launcher as the other way', /\(or use \S+\.cmd\)$/.test(ps1Lines[1]!), `${ps1Lines[1] ?? ''} | change the ps1 branch of promptMistakenForOptionHint in src/boot/main/cli.ts so the hint ends with (or use <name>.cmd)`)

    const cmd = await run(['--format', 'rows', PROMPT], { MERCURY_LAUNCHER: 'cmd' })
    check('another marker value (cmd) keeps the plain hint — only the ps1 road eats the boundary', cmd.err.trim().split('\n')[1] === plainLines[1], `${cmd.err.slice(0, 300)} | change promptMistakenForOptionHint in src/boot/main/cli.ts so only MERCURY_LAUNCHER=ps1 adds the PowerShell text`)

    const control = await run(['--format', 'rows', '--frobnicate', 'hello'], { MERCURY_LAUNCHER: 'ps1' })
    check('control: a one-word unknown option under the marker is still a plain parser error, no hint', control.code === 2 && control.out === '' && control.err.trim().split('\n').every(line => !/looks like a prompt/.test(line)), `${control.err.slice(0, 300)} | change promptMistakenForOptionHint in src/boot/main/cli.ts so an unknown option without whitespace returns null and prints no hint`)
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(failures === 0 ? 'PASS run-door-powershell-boundary' : `FAIL run-door-powershell-boundary: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
