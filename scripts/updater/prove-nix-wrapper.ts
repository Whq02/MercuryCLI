import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { nodeBinPath } from '../lib/nodeBin.ts'

const option = (name: string): string | undefined => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined
const root = resolve(option('--source') ?? join(dirname(fileURLToPath(import.meta.url)), '../..'))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-nix-wrapper-')))
const node = nodeBinPath()
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
try {
  if (process.platform === 'win32') {
    console.log('prove-nix-wrapper: the wrapper is a POSIX shell script; nothing to run on Windows')
  } else {
    const nix = readFileSync(join(root, 'nix/package.nix'), 'utf8')
    const body = /launcher = writeShellScriptBin "mercury" ''\n([\s\S]*?)\n  '';\n/.exec(nix)?.[1] ?? ''
    check('the package still writes its wrapper as one shell text', body.includes('exec "$entry" "$@"'))
    const store = join(scratch, 'store')
    const payloadOutput = join(store, 'payload')
    const payload = join(payloadOutput, 'libexec/mercury')
    const output = join(store, 'mercury')
    const namespace = join(store, 'fhs')
    const entered = join(scratch, 'entered.txt')
    const home = join(scratch, 'home')
    mkdirSync(join(payload, 'vendor/node/bin'), { recursive: true })
    mkdirSync(join(payloadOutput, 'nix-support'), { recursive: true })
    mkdirSync(join(output, 'bin'), { recursive: true })
    mkdirSync(join(output, 'libexec'), { recursive: true })
    mkdirSync(join(namespace, 'bin'), { recursive: true })
    mkdirSync(home, { recursive: true })
    writeFileSync(join(payloadOutput, 'nix-support/mercury'), 'libexec/mercury\n')
    const { posixLauncher, parseEnginesNode } = await import(pathToFileURL(join(root, 'scripts/release/launcherTemplates.mjs')).href)
    writeFileSync(join(payload, 'mercury'), posixLauncher(parseEnginesNode(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).engines.node)), { mode: 0o755 })
    writeFileSync(join(payload, 'mercury.mjs'), 'console.log(`BUNDLE ${process.argv[1]}`)\n')
    writeFileSync(join(payload, 'manifest.json'), '{}')
    symlinkSync(node, join(payload, 'vendor/node/bin/node'))
    symlinkSync(payload, join(output, 'libexec/mercury'), 'dir')
    writeFileSync(join(namespace, 'bin/mercury-fhs'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(entered)}\nexec "$@"\n`, { mode: 0o755 })
    const render = (linux: boolean): string => {
      const text = body
        .replace(/\$\{lib\.optionalString stdenvNoCC\.hostPlatform\.isLinux ''\n([\s\S]*?)\n\s*''\}\n/, (_all, inner: string) => (linux ? `${inner}\n` : ''))
        .replaceAll("''${", '${')
        .replaceAll('${payload}', payloadOutput)
        .replaceAll('@out@', output)
        .replaceAll('${fhs}', namespace)
        .replaceAll('${lib.makeBinPath [ git ]}', '/usr/bin')
      return `#!/bin/sh\n${text}\n`
    }
    const wrapper = join(output, 'bin/mercury')
    const profile = join(scratch, 'profile')
    const binOnly = join(scratch, 'system-profile')
    const alias = join(scratch, 'own-bin/merc')
    mkdirSync(join(profile, 'bin'), { recursive: true })
    mkdirSync(join(binOnly, 'bin'), { recursive: true })
    mkdirSync(dirname(alias), { recursive: true })
    symlinkSync(wrapper, join(profile, 'bin/mercury'))
    symlinkSync(join(output, 'libexec'), join(profile, 'libexec'), 'dir')
    symlinkSync(wrapper, join(binOnly, 'bin/mercury'))
    symlinkSync(join(profile, 'bin/mercury'), alias)
    const { nixInstallRoot } = await import(pathToFileURL(join(root, 'src/services/privateChannel/installProvenance.ts')).href)
    const { ownCommandWord } = await import(pathToFileURL(join(root, 'src/services/privateChannel/installPath.ts')).href)
    const env = { PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home, MERCURY_CONFIG_DIR: join(home, '.mercury'), MERCURY_LOCAL_PROBE_TARGETS: 'none', NODE_DISABLE_COMPILE_CACHE: '1', TERM: 'dumb' }
    const start = (command: string): { bundle: string; out: string } => {
      const run = spawnSync(command, ['--version'], { encoding: 'utf8', env, cwd: scratch, timeout: 60_000 })
      return { bundle: /^BUNDLE (.*)$/m.exec(run.stdout)?.[1] ?? '', out: `${run.status}: ${run.stdout}${run.stderr}` }
    }
    writeFileSync(wrapper, render(false), { mode: 0o755 })
    for (const [layout, command, expected] of [
      ['a profile that links bin and libexec', join(profile, 'bin/mercury'), join(profile, 'libexec/mercury/mercury.mjs')],
      ["the package's own bin, as `nix run` starts it", wrapper, join(output, 'libexec/mercury/mercury.mjs')],
      ['a profile that links bin alone, as a NixOS system profile does unless told otherwise', join(binOnly, 'bin/mercury'), join(output, 'libexec/mercury/mercury.mjs')],
      ["a user's own link to the profile's command", alias, join(output, 'libexec/mercury/mercury.mjs')],
    ] as const) {
      const started = start(command)
      check(`${layout}: the payload starts and is handed the path beside the command that can start it again`, started.bundle === expected, started.out)
      check(`${layout}: the payload it is handed belongs to Nix`, started.bundle !== '' && nixInstallRoot(started.bundle, false) === payloadOutput, started.bundle)
      const word = started.bundle === '' ? '' : ownCommandWord({ provenanceKind: 'nix', found: { state: 'absent' }, node, bundle: started.bundle })
      const again = word === '' ? null : spawnSync('/bin/sh', ['-c', `${word} --version`], { encoding: 'utf8', env, cwd: scratch, timeout: 60_000 })
      check(`${layout}: the command Mercury names for itself exists and starts the same payload`, again !== null && again.status === 0 && again.stdout.includes(`BUNDLE ${started.bundle}`), `${word} · ${again?.status}: ${again?.stdout}${again?.stderr}`)
    }
    writeFileSync(wrapper, render(true), { mode: 0o755 })
    const direct = start(join(profile, 'bin/mercury'))
    check('Linux text: a payload whose own Node starts is run directly, and no namespace is entered', direct.bundle === join(profile, 'libexec/mercury/mercury.mjs') && !existsSync(entered), direct.out)
    rmSync(join(payload, 'vendor/node/bin/node'))
    writeFileSync(join(payload, 'vendor/node/bin/node'), '#!/bin/sh\nexit 127\n', { mode: 0o755 })
    const boxed = spawnSync(join(profile, 'bin/mercury'), ['--version', 'two words'], { encoding: 'utf8', env, cwd: scratch, timeout: 60_000 })
    const handed = existsSync(entered) ? readFileSync(entered, 'utf8').split('\n') : []
    check('Linux text: a payload whose own Node cannot start is handed to the namespace whole, by the same path and with its arguments', handed[0] === join(profile, 'libexec/mercury/mercury') && handed[1] === '--version' && handed[2] === 'two words', `${boxed.status}: ${handed.join(' | ')} ${boxed.stderr}`)
  }
} finally { rmSync(scratch, { recursive: true, force: true }) }
console.log(`prove-nix-wrapper: ${checks - failures}/${checks} passed`)
process.exitCode = failures ? 1 : 0
