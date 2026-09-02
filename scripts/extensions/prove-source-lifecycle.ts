#!/usr/bin/env bun
// ============================================================================
//  scripts/extensions/prove-source-lifecycle.ts — sources, not a store.
//
//  §1  a fresh home has ZERO sources; reading them writes nothing.
//  §2  add: git (a file:// clone of a scratch repository), folder, zip and
//      tgz by path, zip and tgz over loopback https; a single-extension
//      repository is its own source; adding installs NOTHING.
//  §3  refused: owner/repo shorthand (no host implied), a reserved label, a
//      label collision (and --label / suffix handling), a root with no
//      catalogue — each with no residue on disk.
//  §4  the blocklist comes BEFORE network work: the loopback fixture's
//      request log stays EMPTY for a blocked URL and a blocked host.
//  §5  refresh detects a newer version and installs nothing; a catalogue
//      that fails at the new ref keeps the previous one and names the
//      failure.
//  §6  remove's two exits: source only (copies keep working, rows say
//      removed) · source and its extensions.
//  §7  the vanished source: host unreachable at refresh · folder missing ·
//      archive 404 · shrunken catalogue — the named states, installed copies
//      untouched, nothing uninstalled.
//  §8  `sources --json` and `list --source` shapes.
//
//  Scratch config home set before any product import; network-free (the
//  loopback server is this process; the git remote is a file:// path).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '0.0.0-proof' }

import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-ext-sources-'))
const home = join(scratch, 'home')
const cwd = join(scratch, 'cwd')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })
delete process.env.NODE_ENV
delete process.env.CI
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.chdir(cwd)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const settings = await import('../../src/utils/settings/settings.ts')
const paths = await import('../../src/extensions/paths.ts')
const records = await import('../../src/extensions/records.ts')
const sources = await import('../../src/extensions/sources.ts')
const install = await import('../../src/extensions/install.ts')
const cli = await import('../../src/extensions/cli.ts')
const roster = await import('../../src/extensions/roster.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
const FIXTURE = join(import.meta.dir, 'fixtures', 'fixture-source')
const list = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter(n => !n.startsWith('.')) : [])
const quiet = { out: () => {}, err: () => {}, interactive: false }

// ── a loopback archive server with a request log ────────────────────────────
const requestLog: string[] = []
const archives = new Map<string, Buffer>()
let server: Server | null = null
const PORT = 34310
function serve(): Promise<void> {
  return new Promise(resolveStart => {
    server = createServer((req, res) => {
      requestLog.push(`${req.method} ${req.url}`)
      const body = archives.get(req.url ?? '')
      if (!body) {
        res.statusCode = 404
        res.end('not here')
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/octet-stream')
      res.end(body)
    })
    server.listen(PORT, '127.0.0.1', () => resolveStart())
  })
}
await serve()
const BASE = `http://127.0.0.1:${PORT}`

// ── helpers: build archives of the fixture source ───────────────────────────
async function zipOf(dir: string): Promise<Buffer> {
  const { zipSync } = await import('fflate')
  // Unix modes ride the external attributes (os 3 = Unix), so the product's
  // mode recovery has something real to recover.
  const files: Record<string, [Uint8Array, { os: number; attrs: number }]> = {}
  const walk = (d: string, prefix: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(d, entry.name), rel)
      else {
        const mode = statSync(join(d, entry.name)).mode & 0o777
        files[rel] = [new Uint8Array(readFileSync(join(d, entry.name))), { os: 3, attrs: mode << 16 }]
      }
    }
  }
  walk(dir, '')
  return Buffer.from(zipSync(files))
}
function tgzOf(dir: string, out: string): Buffer {
  execFileSync('tar', ['-czf', out, '-C', dir, '.'], { stdio: 'ignore' })
  return readFileSync(out)
}
function git(args: string[], at: string): string {
  return execFileSync('git', args, { cwd: at, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@example.invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@example.invalid' } }).trim()
}

console.log('============================================================')
console.log(' sources — the lifecycle')
console.log('============================================================')

// ── §1 a fresh home ─────────────────────────────────────────────────────────
console.log('[1] a fresh home has zero sources and reading writes nothing')
{
  const before = list(home)
  const read = records.readSources()
  check('sources.json reads as an absent, empty record', read.ok && read.exists === false && Object.keys(read.data).length === 0)
  check('listSources is empty', sources.listSources().length === 0)
  const rows = cli.sourceRows()
  check('sources --json is an empty list', rows.length === 0)
  check('reading wrote nothing into the home', JSON.stringify(list(home)) === JSON.stringify(before), list(home).join(','))
  check('no extensions folder was created by a read', !existsSync(paths.getExtensionsRoot()))
}

// ── §2 add every kind ───────────────────────────────────────────────────────
console.log('[2] add: git (file://), folder, zip, tgz, by path and over loopback https')
const repo = join(scratch, 'remote-repo')
{
  cpSync(FIXTURE, repo, { recursive: true })
  git(['init', '-q', '-b', 'main'], repo)
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'the fixture source'], repo)
  const url = `file://${repo}`
  const added = await sources.addSource(url)
  check('git: a file:// clone adds', added.ok, added.ok ? '' : `${added.step}: ${added.reason}`)
  if (added.ok) {
    check('git: the label is the catalogue name', added.label === 'fixture-source')
    check('git: the record is a git record with a commit', added.record.kind === 'git' && typeof added.record.commit === 'string' && added.record.commit.length >= 7)
    check('git: the cache dir holds the catalogue', existsSync(join(paths.getSourceCacheDir('fixture-source'), 'mercury-extensions.json')))
    check('git: the catalogue offers three', added.catalogue.extensions.length === 3)
  }
  check('nothing installed by adding', Object.keys(records.installedOrEmpty()).length === 0 && !existsSync(paths.getInstalledDir()))
  check('the row reads ok', sources.listSources()[0]?.state === 'ok')

  // folder
  const folder = join(scratch, 'folder-source')
  cpSync(FIXTURE, folder, { recursive: true })
  const asFolder = await sources.addSource(folder, { label: 'folder-src' })
  check('folder: a path adds in place with --label', asFolder.ok && asFolder.label === 'folder-src' && asFolder.record.kind === 'folder', asFolder.ok ? '' : `${asFolder.step}: ${asFolder.reason}`)
  check('folder: never copied into the cache', !existsSync(paths.getSourceCacheDir('folder-src')))
  check('folder: the record points at the folder', asFolder.ok && asFolder.record.where === folder)

  // archives by path
  const zipPath = join(scratch, 'fixture.zip')
  writeFileSync(zipPath, await zipOf(FIXTURE))
  const asZip = await sources.addSource(zipPath, { label: 'zip-src' })
  check('zip by path adds', asZip.ok && asZip.record.kind === 'archive', asZip.ok ? '' : `${asZip.step}: ${asZip.reason}`)
  check('zip: extracted into the cache with the catalogue at the root', existsSync(join(paths.getSourceCacheDir('zip-src'), 'mercury-extensions.json')))
  check('zip: the hook script kept its executable bit', (() => {
    try {
      const mode = statSync(join(paths.getSourceCacheDir('zip-src'), 'kitchen-sink', 'bin', 'fixture-hook.sh')).mode
      return process.platform === 'win32' || (mode & 0o111) !== 0
    } catch {
      return false
    }
  })())
  const tgzPath = join(scratch, 'fixture.tgz')
  tgzOf(FIXTURE, tgzPath)
  const asTgz = await sources.addSource(tgzPath, { label: 'tgz-src' })
  check('tgz by path adds', asTgz.ok && asTgz.record.kind === 'archive', asTgz.ok ? '' : `${asTgz.step}: ${asTgz.reason}`)
  check('tgz: extracted with the catalogue at the root', existsSync(join(paths.getSourceCacheDir('tgz-src'), 'mercury-extensions.json')))

  // archives over loopback https(http) — a nested top-level folder is tolerated once
  const nested = join(scratch, 'nested')
  cpSync(FIXTURE, join(nested, 'fixture-source-main'), { recursive: true })
  archives.set('/fixture.zip', await zipOf(nested))
  archives.set('/fixture.tgz', tgzOf(nested, join(scratch, 'nested.tgz')))
  const remoteZip = await sources.addSource(`${BASE}/fixture.zip`, { label: 'remote-zip' })
  check('zip over loopback adds', remoteZip.ok, remoteZip.ok ? '' : `${remoteZip.step}: ${remoteZip.reason}`)
  check('zip over loopback: one level of nesting is hoisted', existsSync(join(paths.getSourceCacheDir('remote-zip'), 'mercury-extensions.json')))
  const remoteTgz = await sources.addSource(`${BASE}/fixture.tgz`, { label: 'remote-tgz' })
  check('tgz over loopback adds', remoteTgz.ok, remoteTgz.ok ? '' : `${remoteTgz.step}: ${remoteTgz.reason}`)
  check('the loopback server saw exactly the two downloads', requestLog.length === 2, requestLog.join(' | '))

  // a single-extension repository is its own source
  const single = join(scratch, 'single-repo')
  cpSync(join(FIXTURE, 'kitchen-sink'), single, { recursive: true })
  git(['init', '-q', '-b', 'main'], single)
  git(['add', '-A'], single)
  git(['commit', '-q', '-m', 'one extension'], single)
  const asSingle = await sources.addSource(`file://${single}`)
  check('a single-extension repository adds as its own source, labelled by the name', asSingle.ok && asSingle.label === 'kitchen-sink' && asSingle.catalogue.extensions.length === 1, asSingle.ok ? '' : `${asSingle.step}: ${asSingle.reason}`)
  check('seven sources now', sources.listSources().length === 7, String(sources.listSources().length))
  check('still nothing installed', Object.keys(records.installedOrEmpty()).length === 0)
}

// ── §3 refusals with no residue ─────────────────────────────────────────────
console.log('[3] refusals: shorthand, reserved label, collision, no catalogue — no residue')
{
  const before = list(paths.getSourcesDir())
  const short = await sources.addSource('owner/repo')
  check('owner/repo shorthand is refused naming the missing host', !short.ok && short.step === 'classify' && short.reason.includes('names no host'), short.ok ? 'accepted' : short.reason)
  const junk = await sources.addSource('not a source at all')
  check('junk is refused with the one-line reason', !junk.ok && junk.reason === 'not a git URL, a folder or an archive')
  const reserved = await sources.addSource(join(scratch, 'folder-source'), { label: 'project' })
  check('a reserved label is refused', !reserved.ok && reserved.reason.includes('reserved'))
  const dup = await sources.addSource(join(scratch, 'folder-source'))
  check('the same folder twice is refused as a duplicate', !dup.ok && dup.step === 'duplicate')
  const other = join(scratch, 'folder-source-2')
  cpSync(FIXTURE, other, { recursive: true })
  const collide = await sources.addSource(other)
  check('a label collision is refused naming --label', !collide.ok && collide.step === 'label' && collide.reason.includes('--label'), collide.ok ? 'accepted' : collide.reason)
  const suffixed = await sources.addSource(other, { onCollision: 'suffix' })
  check('… or auto-suffixes -2 on request', suffixed.ok && suffixed.label === 'fixture-source-2')
  if (suffixed.ok) sources.removeSource(suffixed.label)
  const empty = join(scratch, 'empty-folder')
  mkdirSync(empty)
  const none = await sources.addSource(empty)
  check('a root with no catalogue is refused at the catalogue step', !none.ok && none.step === 'catalogue' && none.reason.includes('mercury-extensions.json'))
  const badRepo = join(scratch, 'bad-repo')
  mkdirSync(badRepo)
  writeFileSync(join(badRepo, 'mercury-extensions.json'), JSON.stringify({ name: 'bad', extensions: [{ name: 'x', version: '1', description: 'd' }] }))
  git(['init', '-q', '-b', 'main'], badRepo)
  git(['add', '-A'], badRepo)
  git(['commit', '-q', '-m', 'bad'], badRepo)
  const bad = await sources.addSource(`file://${badRepo}`)
  check('an invalid catalogue is refused with the field path', !bad.ok && bad.step === 'catalogue' && bad.reason.includes('extensions[0]'), bad.ok ? 'accepted' : bad.reason)
  const gone = await sources.addSource(`file://${join(scratch, 'no-such-repo')}`)
  check('a missing repository is refused at the clone step', !gone.ok && gone.step === 'clone', gone.ok ? 'accepted' : gone.reason)
  const after = list(paths.getSourcesDir())
  check('no residue: the sources dir is unchanged after every refusal', JSON.stringify(before) === JSON.stringify(after), `${before.join(',')} vs ${after.join(',')}`)
  check('no residue: no staging folders left', !readdirSync(paths.getSourcesDir()).some(n => n.startsWith('.adding') || n.startsWith('.refreshing')))
}

// ── §4 the blocklist comes before network work ──────────────────────────────
console.log('[4] the blocklist refuses before any network or disk work')
{
  requestLog.length = 0
  settings.updateSettingsForSource('userSettings', { extensions: { blocked: [`${BASE}/blocked.zip`, 'blocked.invalid', 'evil-source'] } } as never)
  archives.set('/blocked.zip', await zipOf(FIXTURE))
  const blockedUrl = await sources.addSource(`${BASE}/blocked.zip`)
  check('a blocked URL is refused at the blocklist step', !blockedUrl.ok && blockedUrl.step === 'blocklist' && blockedUrl.reason.includes('blocked'), blockedUrl.ok ? 'accepted' : blockedUrl.reason)
  check('the request log stays EMPTY for the blocked URL', requestLog.length === 0, requestLog.join(' | '))
  const blockedHost = await sources.addSource('https://blocked.invalid/owner/repo.git')
  check('a blocked host is refused before git runs', !blockedHost.ok && blockedHost.step === 'blocklist')
  const blockedLabel = await sources.addSource(join(scratch, 'folder-source-2'), { label: 'evil-source' })
  check('a blocked label is refused up front', !blockedLabel.ok && blockedLabel.step === 'blocklist')
  check('no residue after blocked adds', !readdirSync(paths.getSourcesDir()).some(n => n.startsWith('.adding')))
  settings.updateSettingsForSource('userSettings', { extensions: { blocked: [] } } as never)
}

// ── §5 refresh detects a newer version and installs nothing ─────────────────
console.log('[5] refresh: only a refresh discovers a newer version; nothing is installed or swapped')
{
  const installed = await install.installFromSource('fixture-source', 'kitchen-sink')
  check('install from the git source lands under installed/<id>/<version>', installed.ok && installed.root === paths.getInstalledVersionDir('kitchen-sink@fixture-source', '1.0.0'), installed.ok ? '' : installed.reason)
  const approved = install.approve('kitchen-sink@fixture-source')
  check('approve records the hash and the switch', approved.ok)
  // bump the remote
  const manifestPath = join(repo, 'kitchen-sink', 'mercury-extension.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.version = '1.1.0'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  const cataloguePath = join(repo, 'mercury-extensions.json')
  const catalogue = JSON.parse(readFileSync(cataloguePath, 'utf8'))
  catalogue.extensions[0].version = '1.1.0'
  writeFileSync(cataloguePath, JSON.stringify(catalogue, null, 2))
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'bump'], repo)
  const beforeRoster = roster.computeRoster({ cwd })
  const rowBefore = beforeRoster.entries.find(e => e.id === 'kitchen-sink@fixture-source')
  check('before a refresh the row knows no update', rowBefore?.availableVersion === null)
  const refreshed = await sources.refreshSource('fixture-source')
  check('refresh succeeds and names the update', refreshed.ok && refreshed.updates.length === 1 && refreshed.updates[0]?.to === '1.1.0', refreshed.ok ? JSON.stringify(refreshed.updates) : refreshed.reason)
  const afterRoster = roster.computeRoster({ cwd })
  const rowAfter = afterRoster.entries.find(e => e.id === 'kitchen-sink@fixture-source')
  check('after the refresh the row reads ↑ 1.1.0 available', rowAfter?.availableVersion === '1.1.0')
  check('the installed copy is untouched (still 1.0.0)', records.installedOrEmpty()['kitchen-sink@fixture-source']?.version === '1.0.0' && existsSync(paths.getInstalledVersionDir('kitchen-sink@fixture-source', '1.0.0')))
  check('no 1.1.0 folder was created by the refresh', !existsSync(paths.getInstalledVersionDir('kitchen-sink@fixture-source', '1.1.0')))
  check('the record stamps checkedAt and the new commit', (() => {
    const r = records.sourcesOrEmpty()['fixture-source']
    return r !== undefined && r.checkedAt !== null && r.commit !== null && r.lastError === null
  })())

  // a catalogue that fails at the new ref: the previous stays, the failure is named
  writeFileSync(cataloguePath, '{ this is not json')
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'break the catalogue'], repo)
  const broken = await sources.refreshSource('fixture-source')
  check('a broken catalogue at the new ref fails the refresh naming the failure', !broken.ok && broken.reason.includes('catalogue invalid'), broken.ok ? 'ok' : broken.reason)
  const stillThere = sources.readSourceCatalogue('fixture-source', records.sourcesOrEmpty()['fixture-source']!)
  check('the previous catalogue still lists', stillThere.ok && stillThere.catalogue.extensions.length === 3)
  check('the row reads ✕ unreachable with the reason', sources.listSources().find(r => r.label === 'fixture-source')?.state === 'unreachable')
  // repair
  writeFileSync(cataloguePath, JSON.stringify(catalogue, null, 2))
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'repair'], repo)
  const repaired = await sources.refreshSource('fixture-source')
  check('a repaired catalogue refreshes clean again', repaired.ok && sources.listSources().find(r => r.label === 'fixture-source')?.state === 'ok')
}

// ── §6 remove's two exits ───────────────────────────────────────────────────
console.log('[6] remove: the source only (copies keep working) · the source and its extensions')
{
  const installedZip = await install.installFromSource('zip-src', 'needs-node')
  check('an install from the zip source lands', installedZip.ok, installedZip.ok ? '' : installedZip.reason)
  const removed = sources.removeSource('zip-src')
  check('remove the source only: reports the installed copies from it', removed.ok && removed.installedFromIt.includes('needs-node@zip-src'))
  check('the cache dir is gone', !existsSync(paths.getSourceCacheDir('zip-src')))
  check('the installed copy stays', existsSync(paths.getInstalledVersionDir('needs-node@zip-src', '2.0.0')) && records.installedOrEmpty()['needs-node@zip-src'] !== undefined)
  const row = roster.computeRoster({ cwd }).entries.find(e => e.id === 'needs-node@zip-src')
  check('its row reads from zip-src (removed)', row?.sourceRemoved === true)
  const upd = await install.update('needs-node@zip-src')
  check('it can no longer update, with the reason', !upd.ok && upd.reason.includes('removed'))

  const removedBoth = await cli.removeVerb('tgz-src', { andExtensions: true }, quiet)
  check('remove with --and-extensions exits 0', removedBoth.exit === 0)
  check('a folder source removal never deletes the operator\'s folder', (() => {
    const r = sources.removeSource('folder-src')
    return r.ok && existsSync(join(scratch, 'folder-source', 'mercury-extensions.json'))
  })())
  const installedTgz = await install.installFromSource('remote-tgz', 'partial-one')
  check('install from the remote tgz source', installedTgz.ok, installedTgz.ok ? '' : installedTgz.reason)
  const r2 = sources.removeSource('remote-tgz')
  check('remove names the extension installed from it', r2.ok && r2.installedFromIt.includes('partial-one@remote-tgz'))
  for (const id of r2.ok ? r2.installedFromIt : []) {
    const done = install.uninstall(id)
    check(`uninstall ${id} after the source went`, done.ok)
  }
  check('the uninstalled copy is gone', !existsSync(paths.getInstalledIdDir('partial-one@remote-tgz')))
}

// ── §7 the vanished source ──────────────────────────────────────────────────
console.log('[7] the vanished source: unreachable host · missing folder · 404 archive · shrunken catalogue')
{
  // host unreachable at refresh: the remote repo directory disappears
  const deadRepo = join(scratch, 'dead-repo')
  cpSync(FIXTURE, deadRepo, { recursive: true })
  git(['init', '-q', '-b', 'main'], deadRepo)
  git(['add', '-A'], deadRepo)
  git(['commit', '-q', '-m', 'x'], deadRepo)
  const dead = await sources.addSource(`file://${deadRepo}`, { label: 'dead-src' })
  check('the doomed source adds', dead.ok)
  const inst = await install.installFromSource('dead-src', 'kitchen-sink')
  check('an install from it lands', inst.ok, inst.ok ? '' : inst.reason)
  rmSync(deadRepo, { recursive: true, force: true })
  const unreachable = await sources.refreshSource('dead-src')
  check('refresh of a vanished host fails naming the step', !unreachable.ok && unreachable.reason.length > 0)
  check('the row reads ✕ unreachable', sources.listSources().find(r => r.label === 'dead-src')?.state === 'unreachable')
  check('the cached catalogue still lists', (() => {
    const r = records.sourcesOrEmpty()['dead-src']!
    const c = sources.readSourceCatalogue('dead-src', r)
    return c.ok && c.catalogue.extensions.length === 3
  })())
  check('installs from the cache still work', (await install.installFromSource('dead-src', 'needs-node')).ok)
  check('the installed copy is untouched', existsSync(paths.getInstalledVersionDir('kitchen-sink@dead-src', '1.0.0')))
  check('nothing was uninstalled', records.installedOrEmpty()['kitchen-sink@dead-src'] !== undefined)

  // a folder source whose directory is gone
  const vanishing = join(scratch, 'vanishing-folder')
  cpSync(FIXTURE, vanishing, { recursive: true })
  const vf = await sources.addSource(vanishing, { label: 'vanishing' })
  check('the vanishing folder adds', vf.ok)
  const vfInstall = await install.installFromSource('vanishing', 'needs-node')
  check('an install from it copies the folder (never in place)', vfInstall.ok && !vfInstall.root.startsWith(vanishing))
  rmSync(vanishing, { recursive: true, force: true })
  const vfRow = sources.listSources().find(r => r.label === 'vanishing')
  check('the row reads ✕ unreachable · folder missing · <path>', vfRow?.state === 'unreachable' && (vfRow.reason ?? '').includes('folder missing'), vfRow?.reason ?? '')
  const vfInstall2 = await install.installFromSource('vanishing', 'kitchen-sink')
  check('installing from it is refused with that reason', !vfInstall2.ok && vfInstall2.reason.includes('folder missing'))
  check('its installed copy keeps working', existsSync(paths.getInstalledVersionDir('needs-node@vanishing', '2.0.0')))

  // an archive URL that now 404s
  archives.delete('/fixture.zip')
  const gone = await sources.refreshSource('remote-zip')
  check('a 404 archive fails the refresh naming the status', !gone.ok && gone.reason.includes('404'), gone.ok ? 'ok' : gone.reason)
  check('the extracted copy on disk stays the catalogue', existsSync(join(paths.getSourceCacheDir('remote-zip'), 'mercury-extensions.json')))
  check('the row reads ✕ unreachable', sources.listSources().find(r => r.label === 'remote-zip')?.state === 'unreachable')

  // a catalogue that shrank
  const cataloguePath = join(repo, 'mercury-extensions.json')
  const catalogue = JSON.parse(readFileSync(cataloguePath, 'utf8'))
  catalogue.extensions = catalogue.extensions.filter((e: { name: string }) => e.name !== 'kitchen-sink')
  writeFileSync(cataloguePath, JSON.stringify(catalogue, null, 2))
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'delist'], repo)
  const shrunk = await sources.refreshSource('fixture-source')
  check('the refresh names the delisted extension', shrunk.ok && shrunk.delisted.includes('kitchen-sink@fixture-source'), shrunk.ok ? JSON.stringify(shrunk.delisted) : shrunk.reason)
  const delistedRow = roster.computeRoster({ cwd }).entries.find(e => e.id === 'kitchen-sink@fixture-source')
  check('the installed row reads no longer offered', delistedRow?.noLongerOffered === true)
  check('it stays installed and approved — Mercury never uninstalls on a source\'s say-so', delistedRow?.approved === true && existsSync(paths.getInstalledVersionDir('kitchen-sink@fixture-source', '1.0.0')))
}

// ── §8 the JSON shapes ──────────────────────────────────────────────────────
console.log('[8] sources --json and list --source shapes')
{
  const lines: string[] = []
  const io = { out: (l: string) => lines.push(l), err: () => {}, interactive: false }
  const result = await cli.sourcesVerb({ json: true }, io)
  check('sources --json exits 0', result.exit === 0)
  const parsed = JSON.parse(lines.join('\n')) as { sources: Array<Record<string, unknown>> }
  check('the shape is { sources: [...] }', Array.isArray(parsed.sources) && parsed.sources.length > 0)
  const row = parsed.sources.find(r => r.label === 'fixture-source')
  const keys = ['label', 'kind', 'where', 'ref', 'state', 'reason', 'checkedAt', 'commit', 'offered', 'installed', 'updates', 'extensions']
  check('every source row carries the contract keys', row !== undefined && keys.every(k => k in row), row ? Object.keys(row).join(',') : 'no row')
  check('the row states are the taxonomy words', parsed.sources.every(r => ['ok', 'stale', 'unreachable', 'unchecked'].includes(String(r.state))))
  lines.length = 0
  const listed = await cli.listVerb({ json: true, source: 'fixture-source' }, io)
  check('list --source --json exits 0', listed.exit === 0)
  const offer = JSON.parse(lines.join('\n')) as { extensions: Array<{ name: string; state: string }> }
  check('list --source lists what the source offers with a state per row', offer.extensions.length === 2 && offer.extensions.every(e => typeof e.state === 'string'))
  lines.length = 0
  const missing = await cli.listVerb({ json: true, source: 'no-such' }, io)
  check('list --source with an unknown label exits 1', missing.exit === 1)
}

server?.close()
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ SOURCE LIFECYCLE — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
