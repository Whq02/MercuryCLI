import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { writeShimSet } from '../../src/platform/update-channel/installLayout.ts'
import { distBuildInputs } from './distProvenance.ts'

const { parseEnginesNode, posixLauncher } = (await import('../release/launcherTemplates.mjs')) as {
  parseEnginesNode: (range: string | undefined) => unknown
  posixLauncher: (policy: unknown) => string
}

const TREE = resolve(import.meta.dir, '..', '..')
const DIST = join(TREE, 'dist')
const DEAD_ADDRESS = 'http://127.0.0.1:1'

export type StagedInstall = {
  kind: 'source' | 'release'
  userHome: string
  home: string
  bin: string
  command: string
  bundle: string
  env: NodeJS.ProcessEnv
}

function stageBuild(dir: string): void {
  if (!existsSync(join(DIST, 'mercury.mjs'))) throw new Error(`${join(DIST, 'mercury.mjs')} is absent: run \`bun run build.ts\` in ${TREE}, then run this proof again`)
  const inputs = distBuildInputs(TREE)
  if (inputs.stale) throw new Error(`${inputs.line}: build first (\`bun run build.ts\` in ${TREE}), then run this proof again`)
  mkdirSync(dir, { recursive: true })
  for (const name of readdirSync(DIST)) {
    if (statSync(join(DIST, name)).isDirectory()) symlinkSync(join(DIST, name), join(dir, name))
    else copyFileSync(join(DIST, name), join(dir, name), constants.COPYFILE_FICLONE)
  }
}

function executable(path: string, text: string): void {
  writeFileSync(path, text)
  chmodSync(path, 0o755)
}

export function stageInstall(kind: 'source' | 'release', userHome: string): StagedInstall {
  if (process.platform === 'win32') throw new Error('stageInstall stages the POSIX source deploy and the POSIX release install; on Windows the release install is walked by hand')
  const home = join(userHome, '.mercury')
  const envWith = (bin: string): NodeJS.ProcessEnv => ({
    PATH: `${bin}${delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: userHome,
    TERM: 'dumb',
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_UPDATE_API_BASE_URL: DEAD_ADDRESS,
    ANTHROPIC_BASE_URL: DEAD_ADDRESS,
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  })
  if (kind === 'source') {
    const runtime = join(home, 'runtime')
    const bin = join(home, 'bin')
    stageBuild(join(runtime, 'builds', 'staged'))
    writeFileSync(join(runtime, 'builds', 'staged', 'runtime-manifest.json'), `${JSON.stringify({ schema: 1, dirty: false })}\n`)
    symlinkSync(join('builds', 'staged'), join(runtime, 'current'))
    mkdirSync(bin, { recursive: true })
    executable(join(bin, 'mercury'), readFileSync(join(TREE, 'scripts', 'ops', 'launcher-mercury.sh'), 'utf8'))
    return { kind, userHome, home, bin, command: join(bin, 'mercury'), bundle: join(runtime, 'current', 'mercury.mjs'), env: envWith(bin) }
  }
  const { version } = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8')) as { version: string }
  const { engines } = JSON.parse(readFileSync(join(TREE, 'package.json'), 'utf8')) as { engines?: { node?: string } }
  const versionsDir = join(home, 'versions')
  const bin = join(userHome, '.local', 'bin')
  stageBuild(join(versionsDir, version))
  executable(join(versionsDir, version, 'mercury'), posixLauncher(parseEnginesNode(engines?.node)))
  writeFileSync(join(versionsDir, 'current.txt'), `${version}\n`)
  writeShimSet({ versionsDir, binDir: bin, shimPath: join(bin, 'mercury'), isWindows: false })
  return { kind, userHome, home, bin, command: join(bin, 'mercury'), bundle: join(versionsDir, version, 'mercury.mjs'), env: envWith(bin) }
}
