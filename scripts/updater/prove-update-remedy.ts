import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { makeFixtures, spawnFixtureReleaseServer } from './journeyFixtures.js'

const root = resolve(import.meta.dir, '../..')
const distAt = process.argv.indexOf('--dist')
const dist = resolve(distAt < 0 ? join(root, 'dist/mercury.mjs') : process.argv[distAt + 1]!)
const scratch = mkdtempSync(join(tmpdir(), 'update-remedy-'))
const home = join(scratch, 'home')
const config = join(home, '.mercury')
const versions = join(config, 'versions')
const script = process.platform === 'win32' ? 'irm https://mercury-cli.ai/install.ps1 | iex' : 'curl -fsSL https://mercury-cli.ai/install.sh | sh'
const fixtures = makeFixtures(join(scratch, 'fixtures'), 'channel', [{ version: '9.9.0' }])
const releasesFile = join(fixtures, 'releases.json')
const releases = JSON.parse(readFileSync(releasesFile, 'utf8'))
const server = await spawnFixtureReleaseServer({ fixtures, log: join(scratch, 'requests.log') })
const env = {
  PATH: process.env.PATH,
  HOME: home,
  USERPROFILE: home,
  LOCALAPPDATA: join(home, 'local'),
  TMPDIR: tmpdir(),
  MERCURY_CONFIG_DIR: config,
  MERCURY_VERSIONS_DIR: versions,
  MERCURY_UPDATE_API_BASE_URL: server.url,
  MERCURY_GH_CMD: JSON.stringify([process.execPath, '-e', 'process.exit(1)']),
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  CI: '1',
  TERM: 'dumb',
}
function bundleAt(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const bundle = join(dir, 'mercury.mjs')
  copyFileSync(dist, bundle)
  return bundle
}
function refused(bundle: string, args: string[], command: string, extra = {}, state?: string): void {
  for (const json of [false, true]) {
    const r = spawnSync('node', [bundle, 'update', ...args, ...(json ? ['--json'] : [])], { encoding: 'utf8', timeout: 60_000, env: { ...env, ...extra } })
    assert.equal(r.status, 1, `${args}: ${r.error ?? ''}\n${r.stdout}\n${r.stderr}`)
    if (json) {
      const record = JSON.parse(r.stdout)
      assert.equal(record.reinstallCommand, command, `${args}: JSON reinstall command`)
      if (state) assert.equal(record.state, state)
    } else {
      assert.equal(r.stderr.trim().split('\n').at(-1), command, r.stderr)
      assert.equal(r.stderr.trim().split('\n').filter(line => line === command).length, 1, 'exactly one reinstall line')
    }
  }
  console.log(`refusal ${args.join(' ') || 'update'}: ${command}`)
}
try {
  mkdirSync(versions, { recursive: true })
  writeFileSync(join(versions, 'current.txt'), '1.0.0\n')
  const unknown = bundleAt(join(scratch, 'unknown'))
  writeFileSync(releasesFile, JSON.stringify([{ tag_name: 'v9.9.0', draft: false, prerelease: false, assets: [] }]))
  refused(unknown, ['--check'], script, {}, 'malformed-release')
  refused(unknown, [], script, {}, 'no-update')
  refused(unknown, ['--rollback'], script, {}, 'refused')
  for (const args of [[], ['--check'], ['--status']]) refused(unknown, args, script, { MERCURY_UPDATE_FAULT: 'pointer-read' })
  writeFileSync(join(versions, 'current.txt'), 'not-a-version\n')
  refused(unknown, ['--check'], script, {}, 'invalid-installed-version')
  refused(unknown, [], script, {}, 'no-update')
  writeFileSync(join(versions, 'current.txt'), '1.0.0\n')
  writeFileSync(releasesFile, JSON.stringify(releases))
  refused(unknown, [], script, {}, 'refused')
  writeFileSync(releasesFile, '[]')
  for (const args of [[], ['--check']]) {
    const r = spawnSync('node', [unknown, 'update', ...args], { encoding: 'utf8', timeout: 60_000, env })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!r.stdout.includes(script) && !r.stderr.includes(script), 'no reinstall line on successful no-releases')
  }
  const brew = bundleAt(join(scratch, 'Cellar/mercury/1.0.0/libexec'))
  refused(brew, [], 'brew upgrade Whq02/mercury/mercury', {}, 'refused')
  refused(brew, ['--rollback'], 'brew upgrade Whq02/mercury/mercury', {}, 'refused')
  const npm = bundleAt(join(scratch, 'node_modules/mercury-tech-cli'))
  refused(npm, [], 'npm i -g mercury-tech-cli@latest', {}, 'refused')
  const managed = bundleAt(join(versions, '1.0.0'))
  writeFileSync(join(versions, '1.0.0/manifest.json'), '{}')
  writeFileSync(releasesFile, JSON.stringify([{ tag_name: 'v9.9.0', draft: false, prerelease: false, assets: [] }]))
  refused(managed, ['--check'], script)
  if (process.platform !== 'win32') {
    const bin = join(scratch, 'npm-bin')
    mkdirSync(bin)
    chmodSync(npm, 0o755)
    symlinkSync(npm, join(bin, 'mercury'))
    refused(managed, ['--check'], 'npm i -g mercury-tech-cli@latest', { PATH: `${bin}${delimiter}${env.PATH}` })
  }
  const { updateReinstallCommand } = await import('../../src/services/privateChannel/updateRemedy.js')
  const provenance = (kind: 'unknown' | 'managed' | 'homebrew' | 'npm', invokedPath = '') => ({ kind, invokedPath })
  assert.equal(updateReinstallCommand(provenance('unknown'), null, 'win32'), 'irm https://mercury-cli.ai/install.ps1 | iex')
  assert.equal(updateReinstallCommand(provenance('unknown'), null, 'linux'), 'curl -fsSL https://mercury-cli.ai/install.sh | sh')
  assert.equal(updateReinstallCommand(provenance('homebrew'), null), 'brew upgrade Whq02/mercury/mercury')
  assert.equal(updateReinstallCommand(provenance('npm'), null), 'npm i -g mercury-tech-cli@latest')
  assert.equal(updateReinstallCommand(provenance('managed'), '/npm/bin/mercury'), 'npm i -g mercury-tech-cli@latest')
  const wingetPath = 'C:\\profile\\AppData\\Local\\Microsoft\\WinGet\\Packages\\MercuryCLI.MercuryCLI_Microsoft.Winget.Source_8wekyb3d8bbwe\\mercury\\mercury.mjs'
  assert.equal(updateReinstallCommand(provenance('unknown', wingetPath), null, 'win32'), 'winget upgrade MercuryCLI.MercuryCLI')
  assert.equal(updateReinstallCommand(provenance('unknown', wingetPath.replace('profile\\AppData\\Local\\Microsoft', 'Program Files')), null, 'win32'), 'winget upgrade MercuryCLI.MercuryCLI')
  assert.equal(updateReinstallCommand(provenance('unknown', wingetPath.replace('MercuryCLI.MercuryCLI_', 'Other.Package_')), null, 'win32'), 'irm https://mercury-cli.ai/install.ps1 | iex')
  const manifestSource = readFileSync(join(root, 'scripts/release/winget-manifest.mjs'), 'utf8')
  assert.ok(manifestSource.includes("id: 'MercuryCLI.MercuryCLI'"), 'WinGet remedy matches the manifest identifier')
  console.log('prove-update-remedy: all green')
} finally {
  await server.close()
  rmSync(scratch, { recursive: true, force: true })
}
