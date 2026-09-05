import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assetNameFor } from '../../src/services/privateChannel/channelCore.js'

const { DOC_SET, readCompatFloor, releaseLayoutSection, topAllowlist } = (await import('../release/payloadContract.mjs')) as {
  DOC_SET: string[]
  readCompatFloor: () => { floorVersion: string; forwarder: string }
  releaseLayoutSection: (dir: string, target: string, floor: unknown) => Record<string, unknown>
  topAllowlist: (target: string, floor: unknown) => string[]
}
const { cmdLauncher, parseEnginesNode, posixLauncher, ps1Launcher } = (await import('../release/launcherTemplates.mjs')) as {
  cmdLauncher: (p: unknown) => string
  parseEnginesNode: (range: string | undefined) => unknown
  posixLauncher: (p: unknown) => string
  ps1Launcher: (p: unknown) => string
}

export const ROOT = join(import.meta.dir, '..', '..')
export const IS_WIN = process.platform === 'win32'
export const HOST_TARGET = IS_WIN ? 'windows-x64' : process.platform === 'darwin' ? 'macos-arm64' : 'linux-x64'
export const FLOOR = readCompatFloor()
export const NODE_POLICY = parseEnginesNode(
  (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { engines?: { node?: string } }).engines?.node,
)

export const hostAllowlist = (): string[] => topAllowlist(HOST_TARGET, FLOOR)

export function hostAssetName(version: string): string {
  const name = assetNameFor(version, process.platform, process.arch)
  if (!name) throw new Error(`host platform ${process.platform}/${process.arch} has no channel asset — run this prover on linux-x64/macos-arm64/windows-x64`)
  return name
}

export type PayloadShape = 'release-layout' | 'schema2-single'

export interface PayloadOpts {
  manifestVersion?: string
  stagedFail?: boolean
  postSwitchFail?: boolean
  shape?: PayloadShape
}

export function makePayload(dir: string, version: string, opts: PayloadOpts = {}): void {
  const shape = opts.shape ?? 'release-layout'
  mkdirSync(join(dir, 'vendor', 'ripgrep', 'stub'), { recursive: true })
  writeFileSync(join(dir, 'vendor', 'ripgrep', 'stub', 'rg'), 'stub\n')
  const body = opts.stagedFail
    ? 'process.exit(1)\n'
    : `import { readFileSync } from 'node:fs'
const m = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'))
${opts.postSwitchFail ? `const dir = decodeURIComponent(new URL('.', import.meta.url).pathname)\nif (/[\\/\\\\]${version.replace(/\./g, '\\.')}[\\/\\\\]$/.test(dir)) process.exit(1)\n` : ''}console.log('Mercury ' + m.version)
`
  writeFileSync(join(dir, 'mercury.mjs'), body)
  writeFileSync(join(dir, 'splash.mjs'), `// fixture splash ${version}\n`)
  writeFileSync(join(dir, 'splash-core.mjs'), `// fixture splash core ${version}\n`)
  if (IS_WIN) {
    writeFileSync(join(dir, 'mercury.cmd'), cmdLauncher(NODE_POLICY))
    writeFileSync(join(dir, 'mercury.ps1'), ps1Launcher(NODE_POLICY))
    writeFileSync(join(dir, 'install.ps1'), `# fixture installer stub\n`)
  } else {
    writeFileSync(join(dir, 'mercury'), posixLauncher(NODE_POLICY))
    writeFileSync(join(dir, 'install.sh'), `#!/bin/sh\n# fixture installer stub\n`)
  }
  for (const doc of DOC_SET) {
    writeFileSync(join(dir, doc), `# fixture ${doc} ${version}\n`)
  }
  writeFileSync(join(dir, 'mercury-vscode.vsix'), `fixture-vsix ${version}\n`)
  writeFileSync(join(dir, 'verify-artifact.mjs'), `// fixture provenance verifier ${version}\n`)
  const manifest: Record<string, unknown> = {
    schema: 2,
    name: 'mercury',
    version: opts.manifestVersion ?? version,
    bundle: 'mercury.mjs',
    bundleBytes: statSync(join(dir, 'mercury.mjs')).size,
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest) + '\n')
  if (shape === 'release-layout') {
    manifest.releaseLayout = releaseLayoutSection(dir, HOST_TARGET, FLOOR)
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  }
  if (!IS_WIN) {
    for (const f of ['mercury', 'install.sh']) {
      if (existsSync(join(dir, f))) chmodSync(join(dir, f), 0o755)
    }
  }
}

export const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

export function archiveStage(stage: string, rootName: string, archivePath: string): void {
  if (IS_WIN) {
    execFileSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath $env:MJ_SRC -DestinationPath $env:MJ_DEST -Force'],
      { stdio: 'pipe', timeout: 300_000, env: { ...process.env, MJ_SRC: join(stage, rootName), MJ_DEST: archivePath } },
    )
  } else {
    execFileSync('tar', ['-czf', archivePath, '-C', stage, rootName])
  }
}

export interface ReleaseFixtureSpec {
  version: string
  tag?: string
  draft?: boolean
  prerelease?: boolean
  payload?: PayloadOpts
  archiveRoot?: string
  sums?: 'ok' | 'missing-entry' | 'duplicate' | 'malformed' | 'mismatch'
  omitAsset?: boolean
}

export function makeFixtures(fixturesRoot: string, name: string, specs: ReleaseFixtureSpec[]): string {
  const dir = join(fixturesRoot, name)
  const releases: unknown[] = []
  for (const spec of specs) {
    const tag = spec.tag ?? `v${spec.version}`
    const assetName = hostAssetName(spec.version)
    const tagDir = join(dir, 'assets', tag)
    mkdirSync(tagDir, { recursive: true })
    const stage = join(dir, 'stage', tag)
    const rootName = spec.archiveRoot ?? 'mercury'
    makePayload(join(stage, rootName), spec.version, spec.payload ?? {})
    const archivePath = join(tagDir, assetName)
    archiveStage(stage, rootName, archivePath)
    const digest = sha256File(archivePath)
    let sumsText: string
    switch (spec.sums ?? 'ok') {
      case 'ok':
        sumsText = `${digest}  ${assetName}\n`
        break
      case 'missing-entry':
        sumsText = `${'0'.repeat(64)}  some-other-file.tar.gz\n`
        break
      case 'duplicate':
        sumsText = `${digest}  ${assetName}\n${'1'.repeat(64)}  ${assetName}\n`
        break
      case 'malformed':
        sumsText = `this is not a checksum manifest\n`
        break
      case 'mismatch':
        sumsText = `${'2'.repeat(64)}  ${assetName}\n`
        break
    }
    writeFileSync(join(tagDir, 'SHA256SUMS.txt'), sumsText)
    releases.push({
      tag_name: tag,
      draft: spec.draft ?? false,
      prerelease: spec.prerelease ?? true,
      assets: [...(spec.omitAsset ? [] : [{ name: assetName }]), { name: 'SHA256SUMS.txt' }],
    })
  }
  writeFileSync(join(dir, 'releases.json'), JSON.stringify(releases, null, 1))
  return dir
}


export interface FixtureServerOptions {
  fixtures: string
  log?: string
  visibility?: 'public' | 'private'
  rateLimit?: boolean
  rateResetSeconds?: number
  skipSums?: boolean
}

export interface FixtureServer {
  url: string
  close: () => Promise<void>
}

export function spawnFixtureReleaseServer(opts: FixtureServerOptions): Promise<FixtureServer> {
  const script = join(ROOT, 'scripts', 'updater', 'fixture-release-server.mjs')
  const child = spawn('node', [script, '--fixtures', opts.fixtures, '--port', '0', ...(opts.log ? ['--log', opts.log] : [])], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FIXTURE_VISIBILITY: opts.visibility ?? 'public',
      FIXTURE_RATE_LIMIT: opts.rateLimit ? '1' : '0',
      FIXTURE_RATE_RESET_S: String(opts.rateResetSeconds ?? 1500),
      FIXTURE_SKIP_SUMS: opts.skipSums ? '1' : '0',
    },
  })
  return new Promise<FixtureServer>((resolve, reject) => {
    let buffered = ''
    let settled = false
    child.stdout.on('data', (chunk: Buffer | string) => {
      buffered += String(chunk)
      const newline = buffered.indexOf('\n')
      if (newline === -1 || settled) return
      settled = true
      resolve({
        url: buffered.slice(0, newline).trim(),
        close: () =>
          new Promise<void>(done => {
            if (child.exitCode !== null) return done()
            child.once('exit', () => done())
            child.kill()
          }),
      })
    })
    child.stderr.on('data', (chunk: Buffer | string) => process.stderr.write(String(chunk)))
    child.once('exit', code => {
      if (!settled) {
        settled = true
        reject(new Error(`fixture release server exited with ${code} before printing its URL`))
      }
    })
  })
}

export function closedLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}
