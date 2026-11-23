#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '0.0.0-proof' }

import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

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

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const settings = await import('../../src/platform/settings/settings.ts')
const paths = await import('../../src/integrations/extensions/paths.ts')
const records = await import('../../src/integrations/extensions/records.ts')
const sources = await import('../../src/integrations/extensions/sources.ts')
const install = await import('../../src/integrations/extensions/install.ts')
const cli = await import('../../src/integrations/extensions/cli.ts')
const roster = await import('../../src/integrations/extensions/roster.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
const FIXTURE = join(import.meta.dir, 'fixtures', 'fixture-source')
const list = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter(n => !n.startsWith('.')) : [])
const quiet = { out: () => {}, err: () => {}, interactive: false }

const requestLog: string[] = []
const archives = new Map<string, Buffer>()
let server: Server | null = null
let PORT = 0
function serve(): Promise<void> {
  return new Promise((resolveStart, reject) => {
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
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      PORT = (server!.address() as { port: number }).port
      resolveStart()
    })
  })
}
await serve()
const BASE = `http://127.0.0.1:${PORT}`

async function zipOf(dir: string): Promise<Buffer> {
  const { zipSync } = await import('fflate')
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

console.log('[1] a fresh home has zero sources and reading writes nothing')
{
  const before = list(home)
  const read = records.readSources()
  check('sources.json reads as an absent, empty record', read.ok && read.exists === false && Object.keys(read.data).length === 0, 'readSources in src/integrations/extensions/records.ts must report a missing sources.json as ok, not existing and empty')
  check('listSources is empty', sources.listSources().length === 0, 'listSources in src/integrations/extensions/sources.ts must return no rows for a fresh home')
  const rows = cli.sourceRows()
  check('sources --json is an empty list', rows.length === 0, 'sourceRows in src/integrations/extensions/cli.ts must return no rows for a fresh home')
  check('reading wrote nothing into the home', JSON.stringify(list(home)) === JSON.stringify(before), list(home).join(',') + '; reading sources (readSources in src/integrations/extensions/records.ts, listSources in src/integrations/extensions/sources.ts) must write nothing')
  check('no extensions folder was created by a read', !existsSync(paths.getExtensionsRoot()), 'a read of the sources must not create the folder getExtensionsRoot (src/integrations/extensions/paths.ts) names')
}

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
    check('git: the label is the catalogue name', added.label === 'fixture-source', 'addSource in src/integrations/extensions/sources.ts must label a source with its catalogue name; got ' + added.label)
    check('git: the record is a git record with a commit', added.record.kind === 'git' && typeof added.record.commit === 'string' && added.record.commit.length >= 7, 'addSource in src/integrations/extensions/sources.ts must store a git record with the cloned commit; got ' + JSON.stringify(added.record))
    check('git: the cache dir holds the catalogue', existsSync(join(paths.getSourceCacheDir('fixture-source'), 'mercury-extensions.json')), 'addSource in src/integrations/extensions/sources.ts must leave the cloned catalogue in the source cache dir (getSourceCacheDir, src/integrations/extensions/paths.ts)')
    check('git: the catalogue offers three', added.catalogue.extensions.length === 3, 'the fixture catalogue at scripts/extensions/fixtures/fixture-source lists three extensions; got ' + added.catalogue.extensions.length)
  }
  check('nothing installed by adding', Object.keys(records.installedOrEmpty()).length === 0 && !existsSync(paths.getInstalledDir()), 'addSource in src/integrations/extensions/sources.ts must not install anything')
  check('the row reads ok', sources.listSources()[0]?.state === 'ok', 'sourceState in src/integrations/extensions/sources.ts must read a freshly added source as ok; got ' + sources.listSources()[0]?.state)

  const folder = join(scratch, 'folder-source')
  cpSync(FIXTURE, folder, { recursive: true })
  const asFolder = await sources.addSource(folder, { label: 'folder-src' })
  check('folder: a path adds in place with --label', asFolder.ok && asFolder.label === 'folder-src' && asFolder.record.kind === 'folder', asFolder.ok ? '' : `${asFolder.step}: ${asFolder.reason}`)
  check('folder: never copied into the cache', !existsSync(paths.getSourceCacheDir('folder-src')), 'addSource in src/integrations/extensions/sources.ts must use a folder source in place, not copy it')
  check('folder: the record points at the folder', asFolder.ok && asFolder.record.where === folder, 'addSource in src/integrations/extensions/sources.ts must record the folder path as where')

  const zipPath = join(scratch, 'fixture.zip')
  writeFileSync(zipPath, await zipOf(FIXTURE))
  const asZip = await sources.addSource(zipPath, { label: 'zip-src' })
  check('zip by path adds', asZip.ok && asZip.record.kind === 'archive', asZip.ok ? '' : `${asZip.step}: ${asZip.reason}`)
  check('zip: extracted into the cache with the catalogue at the root', existsSync(join(paths.getSourceCacheDir('zip-src'), 'mercury-extensions.json')), 'addSource in src/integrations/extensions/sources.ts must extract the zip into the source cache dir with the catalogue at its root')
  check('zip: the hook script kept its executable bit', (() => {
    try {
      const mode = statSync(join(paths.getSourceCacheDir('zip-src'), 'kitchen-sink', 'bin', 'fixture-hook.sh')).mode
      return process.platform === 'win32' || (mode & 0o111) !== 0
    } catch {
      return false
    }
  })(), 'the zip extraction in src/integrations/extensions/sources.ts must keep the file mode bits of bin/fixture-hook.sh')
  const tgzPath = join(scratch, 'fixture.tgz')
  tgzOf(FIXTURE, tgzPath)
  const asTgz = await sources.addSource(tgzPath, { label: 'tgz-src' })
  check('tgz by path adds', asTgz.ok && asTgz.record.kind === 'archive', asTgz.ok ? '' : `${asTgz.step}: ${asTgz.reason}`)
  check('tgz: extracted with the catalogue at the root', existsSync(join(paths.getSourceCacheDir('tgz-src'), 'mercury-extensions.json')), 'addSource in src/integrations/extensions/sources.ts must extract the tgz into the source cache dir with the catalogue at its root')

  const nested = join(scratch, 'nested')
  cpSync(FIXTURE, join(nested, 'fixture-source-main'), { recursive: true })
  archives.set('/fixture.zip', await zipOf(nested))
  archives.set('/fixture.tgz', tgzOf(nested, join(scratch, 'nested.tgz')))
  const remoteZip = await sources.addSource(`${BASE}/fixture.zip`, { label: 'remote-zip' })
  check('zip over loopback adds', remoteZip.ok, remoteZip.ok ? '' : `${remoteZip.step}: ${remoteZip.reason}`)
  check('zip over loopback: one level of nesting is hoisted', existsSync(join(paths.getSourceCacheDir('remote-zip'), 'mercury-extensions.json')), 'addSource in src/integrations/extensions/sources.ts must hoist a single top-level folder of a downloaded archive to the cache root')
  const remoteTgz = await sources.addSource(`${BASE}/fixture.tgz`, { label: 'remote-tgz' })
  check('tgz over loopback adds', remoteTgz.ok, remoteTgz.ok ? '' : `${remoteTgz.step}: ${remoteTgz.reason}`)
  check('the loopback server saw exactly the two downloads', requestLog.length === 2, requestLog.join(' | '))

  const single = join(scratch, 'single-repo')
  cpSync(join(FIXTURE, 'kitchen-sink'), single, { recursive: true })
  git(['init', '-q', '-b', 'main'], single)
  git(['add', '-A'], single)
  git(['commit', '-q', '-m', 'one extension'], single)
  const asSingle = await sources.addSource(`file://${single}`)
  check('a single-extension repository adds as its own source, labelled by the name', asSingle.ok && asSingle.label === 'kitchen-sink' && asSingle.catalogue.extensions.length === 1, asSingle.ok ? '' : `${asSingle.step}: ${asSingle.reason}`)
  check('seven sources now', sources.listSources().length === 7, String(sources.listSources().length) + '; an earlier add in [2] did not land, or a refusal left a record (src/integrations/extensions/sources.ts)')
  check('still nothing installed', Object.keys(records.installedOrEmpty()).length === 0, 'addSource in src/integrations/extensions/sources.ts must never install')
}

console.log('[3] refusals: shorthand, reserved label, collision, no catalogue — no residue')
{
  const before = list(paths.getSourcesDir())
  const short = await sources.addSource('owner/repo')
  check('owner/repo shorthand is refused naming the missing host', !short.ok && short.step === 'classify' && short.reason.includes('names no host'), (short.ok ? 'accepted' : short.reason) + '; classifySourceInput / addSource in src/integrations/extensions/sources.ts must refuse owner/repo at the classify step')
  const junk = await sources.addSource('not a source at all')
  check('junk is refused with the one-line reason', !junk.ok && junk.reason === 'not a git URL, a folder or an archive', 'addSource in src/integrations/extensions/sources.ts must refuse junk with that reason; got ' + (junk.ok ? 'accepted' : junk.reason))
  const reserved = await sources.addSource(join(scratch, 'folder-source'), { label: 'project' })
  check('a reserved label is refused', !reserved.ok && reserved.reason.includes('reserved'), 'addSource in src/integrations/extensions/sources.ts must refuse the label project as reserved')
  const dup = await sources.addSource(join(scratch, 'folder-source'))
  check('the same folder twice is refused as a duplicate', !dup.ok && dup.step === 'duplicate', 'addSource in src/integrations/extensions/sources.ts must refuse the same folder at the duplicate step')
  const other = join(scratch, 'folder-source-2')
  cpSync(FIXTURE, other, { recursive: true })
  const collide = await sources.addSource(other)
  check('a label collision is refused naming --label', !collide.ok && collide.step === 'label' && collide.reason.includes('--label'), (collide.ok ? 'accepted' : collide.reason) + '; addSource in src/integrations/extensions/sources.ts must refuse a label collision at the label step naming --label')
  const suffixed = await sources.addSource(other, { onCollision: 'suffix' })
  check('… or auto-suffixes -2 on request', suffixed.ok && suffixed.label === 'fixture-source-2', 'addSource in src/integrations/extensions/sources.ts must suffix -2 when onCollision is suffix')
  if (suffixed.ok) sources.removeSource(suffixed.label)
  const empty = join(scratch, 'empty-folder')
  mkdirSync(empty)
  const none = await sources.addSource(empty)
  check('a root with no catalogue is refused at the catalogue step', !none.ok && none.step === 'catalogue' && none.reason.includes('mercury-extensions.json'), 'addSource in src/integrations/extensions/sources.ts must refuse a root with no catalogue at the catalogue step naming mercury-extensions.json')
  const badRepo = join(scratch, 'bad-repo')
  mkdirSync(badRepo)
  writeFileSync(join(badRepo, 'mercury-extensions.json'), JSON.stringify({ name: 'bad', extensions: [{ name: 'x', version: '1', description: 'd' }] }))
  git(['init', '-q', '-b', 'main'], badRepo)
  git(['add', '-A'], badRepo)
  git(['commit', '-q', '-m', 'bad'], badRepo)
  const bad = await sources.addSource(`file://${badRepo}`)
  check('an invalid catalogue is refused with the field path', !bad.ok && bad.step === 'catalogue' && bad.reason.includes('extensions[0]'), (bad.ok ? 'accepted' : bad.reason) + '; addSource in src/integrations/extensions/sources.ts must refuse an invalid catalogue at the catalogue step naming the field path')
  const gone = await sources.addSource(`file://${join(scratch, 'no-such-repo')}`)
  check('a missing repository is refused at the clone step', !gone.ok && gone.step === 'clone', (gone.ok ? 'accepted' : gone.reason) + '; addSource in src/integrations/extensions/sources.ts must refuse a missing repository at the clone step')
  const after = list(paths.getSourcesDir())
  check('no residue: the sources dir is unchanged after every refusal', JSON.stringify(before) === JSON.stringify(after), `${before.join(',')} vs ${after.join(',')}; addSource in src/integrations/extensions/sources.ts must clean up after every refusal`)
  check('no residue: no staging folders left', !readdirSync(paths.getSourcesDir()).some(n => n.startsWith('.adding') || n.startsWith('.refreshing')), 'addSource and refreshSource in src/integrations/extensions/sources.ts must remove their .adding and .refreshing staging folders')
}

console.log('[4] the blocklist refuses before any network or disk work')
{
  requestLog.length = 0
  settings.updateSettingsForSource('userSettings', { extensions: { blocked: [`${BASE}/blocked.zip`, 'blocked.invalid', 'evil-source'] } } as never)
  archives.set('/blocked.zip', await zipOf(FIXTURE))
  const blockedUrl = await sources.addSource(`${BASE}/blocked.zip`)
  check('a blocked URL is refused at the blocklist step', !blockedUrl.ok && blockedUrl.step === 'blocklist' && blockedUrl.reason.includes('blocked'), (blockedUrl.ok ? 'accepted' : blockedUrl.reason) + '; addSource in src/integrations/extensions/sources.ts must check the blocklist (src/integrations/extensions/blocklist.ts) first')
  check('the request log stays EMPTY for the blocked URL', requestLog.length === 0, requestLog.join(' | ') + '; addSource in src/integrations/extensions/sources.ts must refuse a blocked URL before any download')
  const blockedHost = await sources.addSource('https://blocked.invalid/owner/repo.git')
  check('a blocked host is refused before git runs', !blockedHost.ok && blockedHost.step === 'blocklist', 'addSource in src/integrations/extensions/sources.ts must refuse a blocked host at the blocklist step')
  const blockedLabel = await sources.addSource(join(scratch, 'folder-source-2'), { label: 'evil-source' })
  check('a blocked label is refused up front', !blockedLabel.ok && blockedLabel.step === 'blocklist', 'addSource in src/integrations/extensions/sources.ts must refuse a blocked label at the blocklist step')
  check('no residue after blocked adds', !readdirSync(paths.getSourcesDir()).some(n => n.startsWith('.adding')), 'addSource in src/integrations/extensions/sources.ts must leave no .adding staging folder after a blocked add')
  settings.updateSettingsForSource('userSettings', { extensions: { blocked: [] } } as never)
}

console.log('[5] refresh: only a refresh discovers a newer version; nothing is installed or swapped')
{
  const installed = await install.installFromSource('fixture-source', 'kitchen-sink')
  check('install from the git source lands under installed/<id>/<version>', installed.ok && installed.root === paths.getInstalledVersionDir('kitchen-sink@fixture-source', '1.0.0'), installed.ok ? '' : `${installed.reason}; installFromSource in src/integrations/extensions/install.ts`)
  const approved = install.approve('kitchen-sink@fixture-source')
  check('approve records the hash and the switch', approved.ok, 'approve in src/integrations/extensions/install.ts refused kitchen-sink@fixture-source')
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
  check('before a refresh the row knows no update', rowBefore?.availableVersion === null, 'computeRoster in src/integrations/extensions/roster.ts must not know of an update before a refresh; got ' + rowBefore?.availableVersion)
  const refreshed = await sources.refreshSource('fixture-source')
  check('refresh succeeds and names the update', refreshed.ok && refreshed.updates.length === 1 && refreshed.updates[0]?.to === '1.1.0', (refreshed.ok ? JSON.stringify(refreshed.updates) : refreshed.reason) + '; refreshSource in src/integrations/extensions/sources.ts must report the 1.0.0 to 1.1.0 update (compareWithCatalogue)')
  const afterRoster = roster.computeRoster({ cwd })
  const rowAfter = afterRoster.entries.find(e => e.id === 'kitchen-sink@fixture-source')
  check('after the refresh the row reads ↑ 1.1.0 available', rowAfter?.availableVersion === '1.1.0', 'computeRoster in src/integrations/extensions/roster.ts must set availableVersion from the refreshed catalogue; got ' + rowAfter?.availableVersion)
  check('the installed copy is untouched (still 1.0.0)', records.installedOrEmpty()['kitchen-sink@fixture-source']?.version === '1.0.0' && existsSync(paths.getInstalledVersionDir('kitchen-sink@fixture-source', '1.0.0')), 'refreshSource in src/integrations/extensions/sources.ts must not touch installed copies')
  check('no 1.1.0 folder was created by the refresh', !existsSync(paths.getInstalledVersionDir('kitchen-sink@fixture-source', '1.1.0')), 'refreshSource in src/integrations/extensions/sources.ts must not install the new version')
  check('the record stamps checkedAt and the new commit', (() => {
    const r = records.sourcesOrEmpty()['fixture-source']
    return r !== undefined && r.checkedAt !== null && r.commit !== null && r.lastError === null
  })(), 'refreshSource in src/integrations/extensions/sources.ts must stamp checkedAt and commit and clear lastError in sources.json')

  writeFileSync(cataloguePath, '{ this is not json')
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'break the catalogue'], repo)
  const broken = await sources.refreshSource('fixture-source')
  check('a broken catalogue at the new ref fails the refresh naming the failure', !broken.ok && broken.reason.includes('catalogue invalid'), (broken.ok ? 'ok' : broken.reason) + '; refreshSource in src/integrations/extensions/sources.ts must fail naming catalogue invalid')
  const stillThere = sources.readSourceCatalogue('fixture-source', records.sourcesOrEmpty()['fixture-source']!)
  check('the previous catalogue still lists', stillThere.ok && stillThere.catalogue.extensions.length === 3, 'a failed refresh in src/integrations/extensions/sources.ts must keep the previous cached catalogue')
  check('the row reads ✕ unreachable with the reason', sources.listSources().find(r => r.label === 'fixture-source')?.state === 'unreachable', 'a failed refresh must set lastError so sourceState in src/integrations/extensions/sources.ts reads unreachable')
  writeFileSync(cataloguePath, JSON.stringify(catalogue, null, 2))
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'repair'], repo)
  const repaired = await sources.refreshSource('fixture-source')
  check('a repaired catalogue refreshes clean again', repaired.ok && sources.listSources().find(r => r.label === 'fixture-source')?.state === 'ok', 'refreshSource in src/integrations/extensions/sources.ts must clear the failure once the catalogue is valid again')
}

console.log('[6] remove: the source only (copies keep working) · the source and its extensions')
{
  const installedZip = await install.installFromSource('zip-src', 'needs-node')
  check('an install from the zip source lands', installedZip.ok, installedZip.ok ? '' : `${installedZip.reason}; installFromSource in src/integrations/extensions/install.ts`)
  const removed = sources.removeSource('zip-src')
  check('remove the source only: reports the installed copies from it', removed.ok && removed.installedFromIt.includes('needs-node@zip-src'), 'removeSource in src/integrations/extensions/sources.ts must list the extensions installed from the source')
  check('the cache dir is gone', !existsSync(paths.getSourceCacheDir('zip-src')), 'removeSource in src/integrations/extensions/sources.ts must delete the source cache dir')
  check('the installed copy stays', existsSync(paths.getInstalledVersionDir('needs-node@zip-src', '2.0.0')) && records.installedOrEmpty()['needs-node@zip-src'] !== undefined, 'removeSource in src/integrations/extensions/sources.ts must leave installed copies and records alone')
  const row = roster.computeRoster({ cwd }).entries.find(e => e.id === 'needs-node@zip-src')
  check('its row reads from zip-src (removed)', row?.sourceRemoved === true, 'computeRoster in src/integrations/extensions/roster.ts must set sourceRemoved for an installed extension whose source is gone')
  const upd = await install.update('needs-node@zip-src')
  check('it can no longer update, with the reason', !upd.ok && upd.reason.includes('removed'), 'update in src/integrations/extensions/install.ts must refuse naming that the source was removed; got ' + JSON.stringify(upd))

  const removedBoth = await cli.removeVerb('tgz-src', { andExtensions: true }, quiet)
  check('remove with --and-extensions exits 0', removedBoth.exit === 0, 'removeVerb in src/integrations/extensions/cli.ts returned exit ' + removedBoth.exit)
  check('a folder source removal never deletes the operator\'s folder', (() => {
    const r = sources.removeSource('folder-src')
    return r.ok && existsSync(join(scratch, 'folder-source', 'mercury-extensions.json'))
  })(), 'removeSource in src/integrations/extensions/sources.ts must never delete a folder source\'s own folder')
  const installedTgz = await install.installFromSource('remote-tgz', 'partial-one')
  check('install from the remote tgz source', installedTgz.ok, installedTgz.ok ? '' : `${installedTgz.reason}; installFromSource in src/integrations/extensions/install.ts`)
  const r2 = sources.removeSource('remote-tgz')
  check('remove names the extension installed from it', r2.ok && r2.installedFromIt.includes('partial-one@remote-tgz'), 'removeSource in src/integrations/extensions/sources.ts must list the extensions installed from the source')
  for (const id of r2.ok ? r2.installedFromIt : []) {
    const done = install.uninstall(id)
    check(`uninstall ${id} after the source went`, done.ok, 'uninstall in src/integrations/extensions/install.ts must work once the source is gone')
  }
  check('the uninstalled copy is gone', !existsSync(paths.getInstalledIdDir('partial-one@remote-tgz')), 'uninstall in src/integrations/extensions/install.ts must delete the id folder under installed/')
}

console.log('[7] the vanished source: unreachable host · missing folder · 404 archive · shrunken catalogue')
{
  const deadRepo = join(scratch, 'dead-repo')
  cpSync(FIXTURE, deadRepo, { recursive: true })
  git(['init', '-q', '-b', 'main'], deadRepo)
  git(['add', '-A'], deadRepo)
  git(['commit', '-q', '-m', 'x'], deadRepo)
  const dead = await sources.addSource(`file://${deadRepo}`, { label: 'dead-src' })
  check('the doomed source adds', dead.ok, 'addSource in src/integrations/extensions/sources.ts refused the dead-src repository')
  const inst = await install.installFromSource('dead-src', 'kitchen-sink')
  check('an install from it lands', inst.ok, inst.ok ? '' : `${inst.reason}; installFromSource in src/integrations/extensions/install.ts`)
  removeScratch(deadRepo)
  const unreachable = await sources.refreshSource('dead-src')
  check('refresh of a vanished host fails naming the step', !unreachable.ok && unreachable.reason.length > 0, 'refreshSource in src/integrations/extensions/sources.ts must fail with a reason when the repository is gone')
  check('the row reads ✕ unreachable', sources.listSources().find(r => r.label === 'dead-src')?.state === 'unreachable', 'a failed refresh must set lastError so sourceState in src/integrations/extensions/sources.ts reads unreachable')
  check('the cached catalogue still lists', (() => {
    const r = records.sourcesOrEmpty()['dead-src']!
    const c = sources.readSourceCatalogue('dead-src', r)
    return c.ok && c.catalogue.extensions.length === 3
  })(), 'a failed refresh in src/integrations/extensions/sources.ts must keep the cached catalogue readable (readSourceCatalogue)')
  check('installs from the cache still work', (await install.installFromSource('dead-src', 'needs-node')).ok, 'installFromSource in src/integrations/extensions/install.ts must install from the cache of an unreachable source')
  check('the installed copy is untouched', existsSync(paths.getInstalledVersionDir('kitchen-sink@dead-src', '1.0.0')), 'refreshSource in src/integrations/extensions/sources.ts must not touch installed copies when it fails')
  check('nothing was uninstalled', records.installedOrEmpty()['kitchen-sink@dead-src'] !== undefined, 'refreshSource in src/integrations/extensions/sources.ts must not uninstall when it fails')

  const vanishing = join(scratch, 'vanishing-folder')
  cpSync(FIXTURE, vanishing, { recursive: true })
  const vf = await sources.addSource(vanishing, { label: 'vanishing' })
  check('the vanishing folder adds', vf.ok, 'addSource in src/integrations/extensions/sources.ts refused the vanishing folder')
  const vfInstall = await install.installFromSource('vanishing', 'needs-node')
  check('an install from it copies the folder (never in place)', vfInstall.ok && !vfInstall.root.startsWith(vanishing), 'installFromSource in src/integrations/extensions/install.ts must copy a folder source into installed/, never run in place')
  removeScratch(vanishing)
  const vfRow = sources.listSources().find(r => r.label === 'vanishing')
  check('the row reads ✕ unreachable · folder missing · <path>', vfRow?.state === 'unreachable' && (vfRow.reason ?? '').includes('folder missing'), (vfRow?.reason ?? '') + '; sourceStateReason in src/integrations/extensions/sources.ts must say folder missing for a folder source that is gone')
  const vfInstall2 = await install.installFromSource('vanishing', 'kitchen-sink')
  check('installing from it is refused with that reason', !vfInstall2.ok && vfInstall2.reason.includes('folder missing'), 'installFromSource in src/integrations/extensions/install.ts must refuse with the folder missing reason; got ' + JSON.stringify(vfInstall2))
  check('its installed copy keeps working', existsSync(paths.getInstalledVersionDir('needs-node@vanishing', '2.0.0')), 'an installed copy from a vanished folder source must stay in installed/')

  archives.delete('/fixture.zip')
  const gone = await sources.refreshSource('remote-zip')
  check('a 404 archive fails the refresh naming the status', !gone.ok && gone.reason.includes('404'), (gone.ok ? 'ok' : gone.reason) + '; refreshSource in src/integrations/extensions/sources.ts must name the HTTP status when an archive download fails')
  check('the extracted copy on disk stays the catalogue', existsSync(join(paths.getSourceCacheDir('remote-zip'), 'mercury-extensions.json')), 'a failed archive refresh in src/integrations/extensions/sources.ts must keep the previously extracted cache')
  check('the row reads ✕ unreachable', sources.listSources().find(r => r.label === 'remote-zip')?.state === 'unreachable', 'a failed refresh must set lastError so sourceState in src/integrations/extensions/sources.ts reads unreachable')

  const cataloguePath = join(repo, 'mercury-extensions.json')
  const catalogue = JSON.parse(readFileSync(cataloguePath, 'utf8'))
  catalogue.extensions = catalogue.extensions.filter((e: { name: string }) => e.name !== 'kitchen-sink')
  writeFileSync(cataloguePath, JSON.stringify(catalogue, null, 2))
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'delist'], repo)
  const shrunk = await sources.refreshSource('fixture-source')
  check('the refresh names the delisted extension', shrunk.ok && shrunk.delisted.includes('kitchen-sink@fixture-source'), (shrunk.ok ? JSON.stringify(shrunk.delisted) : shrunk.reason) + '; refreshSource / compareWithCatalogue in src/integrations/extensions/sources.ts must list a removed extension as delisted')
  const delistedRow = roster.computeRoster({ cwd }).entries.find(e => e.id === 'kitchen-sink@fixture-source')
  check('the installed row reads no longer offered', delistedRow?.noLongerOffered === true, 'computeRoster in src/integrations/extensions/roster.ts must set noLongerOffered for an installed extension the catalogue dropped')
  check('it stays installed and approved — Mercury never uninstalls on a source\'s say-so', delistedRow?.approved === true && existsSync(paths.getInstalledVersionDir('kitchen-sink@fixture-source', '1.0.0')), 'a delisting must not uninstall or unapprove (refreshSource in src/integrations/extensions/sources.ts, computeRoster in src/integrations/extensions/roster.ts)')
}

console.log('[8] sources --json and list --source shapes')
{
  const lines: string[] = []
  const io = { out: (l: string) => lines.push(l), err: () => {}, interactive: false }
  const result = await cli.sourcesVerb({ json: true }, io)
  check('sources --json exits 0', result.exit === 0, 'sourcesVerb in src/integrations/extensions/cli.ts returned exit ' + result.exit)
  const parsed = JSON.parse(lines.join('\n')) as { sources: Array<Record<string, unknown>> }
  check('the shape is { sources: [...] }', Array.isArray(parsed.sources) && parsed.sources.length > 0, 'sourcesVerb in src/integrations/extensions/cli.ts must print { sources: [...] } with every source')
  const row = parsed.sources.find(r => r.label === 'fixture-source')
  const keys = ['label', 'kind', 'where', 'ref', 'state', 'reason', 'checkedAt', 'commit', 'offered', 'installed', 'updates', 'extensions']
  check('every source row carries the contract keys', row !== undefined && keys.every(k => k in row), (row ? Object.keys(row).join(',') : 'no row') + '; sourceRows in src/integrations/extensions/cli.ts must carry every contract key')
  check('the row states are the taxonomy words', parsed.sources.every(r => ['ok', 'stale', 'unreachable', 'unchecked'].includes(String(r.state))), 'sourceRows in src/integrations/extensions/cli.ts must print only the SourceState words from src/integrations/extensions/sources.ts')
  lines.length = 0
  const listed = await cli.listVerb({ json: true, source: 'fixture-source' }, io)
  check('list --source --json exits 0', listed.exit === 0, 'listVerb in src/integrations/extensions/cli.ts returned exit ' + listed.exit)
  const offer = JSON.parse(lines.join('\n')) as { extensions: Array<{ name: string; state: string }> }
  check('list --source lists what the source offers with a state per row', offer.extensions.length === 2 && offer.extensions.every(e => typeof e.state === 'string'), 'listVerb in src/integrations/extensions/cli.ts must print every extension the source offers with a state')
  lines.length = 0
  const missing = await cli.listVerb({ json: true, source: 'no-such' }, io)
  check('list --source with an unknown label exits 1', missing.exit === 1, 'listVerb in src/integrations/extensions/cli.ts returned exit ' + missing.exit)
}

server?.close()
removeScratch(scratch)
console.log(failures === 0 ? '\n ✅ SOURCE LIFECYCLE — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
