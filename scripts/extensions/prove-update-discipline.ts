#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-ext-update-'))
const home = join(scratch, 'home')
const cwd = join(scratch, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })
delete process.env.NODE_ENV
delete process.env.CI
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.chdir(cwd)

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const paths = await import('../../src/integrations/extensions/paths.ts')
const records = await import('../../src/integrations/extensions/records.ts')
const sources = await import('../../src/integrations/extensions/sources.ts')
const install = await import('../../src/integrations/extensions/install.ts')
const rosterMod = await import('../../src/integrations/extensions/roster.ts')
const reloadMod = await import('../../src/integrations/extensions/reload.ts')
const boot = await import('../../src/integrations/extensions/boot.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
const FIXTURE = join(import.meta.dir, 'fixtures', 'fixture-source')
const ID = 'kitchen-sink@update-src'
function git(args: string[], at: string): void {
  execFileSync('git', args, { cwd: at, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'p@example.invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'p@example.invalid' } })
}
function bump(repo: string, version: string, mutateManifest?: (m: Record<string, unknown>) => void): void {
  const manifestPath = join(repo, 'kitchen-sink', 'mercury-extension.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.version = version
  mutateManifest?.(manifest)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  const cataloguePath = join(repo, 'mercury-extensions.json')
  const catalogue = JSON.parse(readFileSync(cataloguePath, 'utf8'))
  catalogue.extensions.find((e: { name: string }) => e.name === 'kitchen-sink').version = version
  writeFileSync(cataloguePath, JSON.stringify(catalogue, null, 2))
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', `v${version}`], repo)
}

console.log('============================================================')
console.log(' updates — an operator act, never silent')
console.log('============================================================')

const repo = join(scratch, 'remote')
cpSync(FIXTURE, repo, { recursive: true })
git(['init', '-q', '-b', 'main'], repo)
git(['add', '-A'], repo)
git(['commit', '-q', '-m', 'v1.0.0'], repo)
const added = await sources.addSource(`file://${repo}`, { label: 'update-src' })
check('the source adds', added.ok, 'addSource in src/integrations/extensions/sources.ts must accept a file:// git source with a label')
const installed = await install.installFromSource('update-src', 'kitchen-sink')
check('1.0.0 installs', installed.ok && installed.record.version === '1.0.0', 'installFromSource in src/integrations/extensions/install.ts must install the catalogue version 1.0.0 of kitchen-sink')
check('approve lands', install.approve(ID).ok, 'approve in src/integrations/extensions/install.ts must approve the installed kitchen-sink@update-src')
await reloadMod.reloadExtensions({ cwd })

console.log('[1] a newer version upstream changes nothing until check')
{
  bump(repo, '1.1.0')
  const row = rosterMod.computeRoster({ cwd }).entries.find(e => e.id === ID)
  check('before the check: no update known', row?.availableVersion === null, 'computeRoster in src/integrations/extensions/roster.ts must not report availableVersion until refreshSource has run')
  const refreshed = await sources.refreshSource('update-src')
  check('check names the update', refreshed.ok && refreshed.updates.some(u => u.id === ID && u.to === '1.1.0'), 'refreshSource in src/integrations/extensions/sources.ts must return an updates entry for kitchen-sink@update-src to 1.1.0')
  const after = rosterMod.computeRoster({ cwd }).entries.find(e => e.id === ID)
  check('after the check: ↑ 1.1.0 available on the row', after?.availableVersion === '1.1.0', `availableVersion is ${JSON.stringify(after?.availableVersion)}; refreshSource (src/integrations/extensions/sources.ts) must record the update where computeRoster (src/integrations/extensions/roster.ts) reads it`)
  check('nothing was fetched into installed/', !existsSync(paths.getInstalledVersionDir(ID, '1.1.0')), 'a source check must only read the catalogue; refreshSource in src/integrations/extensions/sources.ts must not fetch the new version')
  check('the running version is untouched', records.installedOrEmpty()[ID]?.version === '1.0.0', 'a source check must not change the installed record (src/integrations/extensions/records.ts)')
}

console.log('[2] the version key: pre-fetch; a lying catalogue refuses; a warm read needs no remote')
{
  const cataloguePath = join(repo, 'mercury-extensions.json')
  const catalogue = JSON.parse(readFileSync(cataloguePath, 'utf8'))
  catalogue.extensions.find((e: { name: string }) => e.name === 'kitchen-sink').version = '2.0.0'
  writeFileSync(cataloguePath, JSON.stringify(catalogue, null, 2))
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'lie'], repo)
  const refreshed = await sources.refreshSource('update-src')
  check('the lying source refreshes (the lie is caught at install)', refreshed.ok, 'refreshSource in src/integrations/extensions/sources.ts must not validate the catalogue version against the manifest; update in src/integrations/extensions/install.ts does')
  const lied = await install.update(ID)
  check('the update refuses the lie naming both versions', !lied.ok && lied.reason === 'catalogue says 2.0.0, manifest says 1.1.0', `${lied.ok ? 'applied' : lied.reason} — update in src/integrations/extensions/install.ts must refuse with exactly: catalogue says 2.0.0, manifest says 1.1.0`)
  check('no 2.0.0 folder remains', !existsSync(paths.getInstalledVersionDir(ID, '2.0.0')), 'update in src/integrations/extensions/install.ts must remove a fetched folder when it refuses')
  catalogue.extensions.find((e: { name: string }) => e.name === 'kitchen-sink').version = '1.1.0'
  writeFileSync(cataloguePath, JSON.stringify(catalogue, null, 2))
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'repair'], repo)
  check('re-check lands', (await sources.refreshSource('update-src')).ok, 'refreshSource in src/integrations/extensions/sources.ts failed after the catalogue was repaired')
  const record = records.installedOrEmpty()[ID]!
  check('the record path is the version-keyed folder', record.path === paths.getInstalledVersionDir(ID, '1.0.0'), `record.path is ${record.path}; the record must point at the folder getInstalledVersionDir (src/integrations/extensions/paths.ts) gives`)
  removeScratch(repo)
  const warm = rosterMod.computeRoster({ cwd }).entries.find(e => e.id === ID)
  check('with the remote DELETED the copy still resolves under the key (no re-clone)', warm !== undefined && warm.root === record.path && warm.manifest !== null, 'computeRoster in src/integrations/extensions/roster.ts must resolve an installed git extension from its version-keyed folder without the remote')
  cpSync(FIXTURE, repo, { recursive: true })
  bumpRestore()
}
function bumpRestore(): void {
  git(['init', '-q', '-b', 'main'], repo)
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'restore 1.0.0'], repo)
  bump(repo, '1.1.0')
}

console.log('[3] update: a new folder, approval carried when the hash is unchanged, the card when changed')
{
  check('re-check after restore', (await sources.refreshSource('update-src')).ok, 'refreshSource in src/integrations/extensions/sources.ts failed on the restored remote')
  const carried = await install.update(ID)
  check('an unchanged contributions hash carries the approval', carried.ok && carried.outcome === 'carried' && carried.ok && (carried as { to?: string }).to === '1.1.0', `${carried.ok ? carried.outcome : carried.reason} — update in src/integrations/extensions/install.ts must carry the approval when the contributions hash is unchanged`)
  const record = records.installedOrEmpty()[ID]!
  check('the record moved to the new version folder', record.version === '1.1.0' && record.path === paths.getInstalledVersionDir(ID, '1.1.0'), 'update in src/integrations/extensions/install.ts must move the record to the new version folder')
  check('the previous folder is kept until a clean load', record.previous?.version === '1.0.0' && existsSync(record.previous!.path), 'update in src/integrations/extensions/install.ts must keep the previous version in record.previous')
  check('the row reads ◐ reload with both versions', (() => {
    const row = rosterMod.computeRoster({ cwd }).entries.find(e => e.id === ID)
    return row?.pending === 'update'
  })(), 'computeRoster in src/integrations/extensions/roster.ts must mark the row pending update after update')
  await reloadMod.reloadExtensions({ cwd })
  const settled = records.installedOrEmpty()[ID]!
  check('after the clean load the previous folder is removed', settled.previous === null && !existsSync(paths.getInstalledVersionDir(ID, '1.0.0')), 'a clean load must clear record.previous and delete its folder; see reloadExtensions in src/integrations/extensions/reload.ts')

  bump(repo, '1.2.0', m => {
    ;(m as { contributes: { hooks: Record<string, unknown> } }).contributes.hooks['turn.answer'] = [{ run: 'true' }]
  })
  check('check finds 1.2.0', (await sources.refreshSource('update-src')).ok, 'refreshSource in src/integrations/extensions/sources.ts failed after the 1.2.0 commit')
  const needs = await install.update(ID)
  check('a changed hash fetches and WAITS for the card', needs.ok && needs.outcome === 'needs-approval', `${needs.ok ? needs.outcome : needs.reason} — update in src/integrations/extensions/install.ts must fetch and return needs-approval when the contributions hash changed`)
  check('the fetched folder exists; the running version is untouched', existsSync(paths.getInstalledVersionDir(ID, '1.2.0')) && records.installedOrEmpty()[ID]?.version === '1.1.0', 'update in src/integrations/extensions/install.ts must fetch the new folder and leave the running record on 1.1.0 until approved')
  check('discard removes the fetched folder and keeps 1.1.0', (() => {
    const discarded = install.discardUpdate(ID)
    return discarded.ok && !existsSync(paths.getInstalledVersionDir(ID, '1.2.0')) && records.installedOrEmpty()[ID]?.version === '1.1.0'
  })(), 'discardUpdate in src/integrations/extensions/install.ts must remove the fetched folder and keep the running version')
  const again = await install.update(ID)
  check('fetch again', again.ok && again.outcome === 'needs-approval', 'update in src/integrations/extensions/install.ts must be able to fetch again after discardUpdate')
  const applied = install.approveUpdate(ID)
  check("the diff card's approve applies with a fresh approval", applied.ok && records.installedOrEmpty()[ID]?.version === '1.2.0' && records.installedOrEmpty()[ID]?.approval?.contributionsHash === records.installedOrEmpty()[ID]?.contributionsHash, 'approveUpdate in src/integrations/extensions/install.ts must switch the record to 1.2.0 with an approval of the new contributions hash')
}

console.log('[4] previous: kept while broken, swapped back without re-approval')
{
  const record = records.installedOrEmpty()[ID]!
  check('1.2.0 keeps 1.1.0 until its first clean load', record.previous?.version === '1.1.0', 'approveUpdate in src/integrations/extensions/install.ts must set record.previous to the replaced version')
  writeFileSync(join(record.path, 'mercury-extension.json'), '{ broken')
  await reloadMod.reloadExtensions({ cwd })
  const kept = records.installedOrEmpty()[ID]!
  check('a broken first load KEEPS the previous folder', kept.previous?.version === '1.1.0' && existsSync(kept.previous!.path), 'a failed first load must not clear record.previous; see reloadExtensions in src/integrations/extensions/reload.ts')
  const swapped = install.swapToPrevious(ID)
  check('--previous swaps back with no re-approval (its hash was approved)', swapped.ok && records.installedOrEmpty()[ID]?.version === '1.1.0' && records.installedOrEmpty()[ID]?.approval !== null, 'swapToPrevious in src/integrations/extensions/install.ts must restore 1.1.0 with its earlier approval')
  await reloadMod.reloadExtensions({ cwd })
  const back = rosterMod.computeRoster({ cwd }).entries.find(e => e.id === ID)
  check('1.1.0 is on again', back !== undefined && rosterMod.trustStateOf(back) === 'on', 'after swapToPrevious and a reload the row must read on; see trustStateOf in src/integrations/extensions/roster.ts')
}

console.log('[5] in-place: a version bump alone carries; a contributions change re-asks')
{
  const folder = join(cwd, '.mercury', 'extensions', 'needs-node')
  cpSync(join(FIXTURE, 'needs-node'), folder, { recursive: true })
  const approved = install.approve('needs-node@project', { root: folder, scope: 'project' })
  check('the folder approves in place', approved.ok, 'approve in src/integrations/extensions/install.ts must accept a project-scope folder given as root')
  const manifestPath = join(folder, 'mercury-extension.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.version = '2.1.0'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  let row = rosterMod.computeRoster({ cwd }).entries.find(e => e.id === 'needs-node@project')
  check('a version bump alone carries the approval', row !== undefined && row.approved && !row.changedSinceApproval, 'a manifest version bump alone must not change the contributions hash; see computeRoster in src/integrations/extensions/roster.ts')
  manifest.contributes.servers['second'] = { command: 'node', args: ['-e', '0'] }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  row = rosterMod.computeRoster({ cwd }).entries.find(e => e.id === 'needs-node@project')
  check('a contributions change reads changed — re-approve', row?.changedSinceApproval === true, 'computeRoster in src/integrations/extensions/roster.ts must set changedSinceApproval when the contributions change')
  removeScratch(folder)
}

console.log('[6] no background updater: the request log stays empty across a full boot')
{
  const requestLog: string[] = []
  const server: Server = createServer((req, res) => {
    requestLog.push(String(req.url))
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const archiveUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/x.zip`
  records.updateSources(current => ({
    ...current,
    'remote-arch': { kind: 'archive', where: archiveUrl, ref: null, addedAt: new Date().toISOString(), checkedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(), commit: null, lastError: null },
  }))
  const result = await boot.reloadExtensions({ cwd })
  void result
  rosterMod.computeRoster({ cwd })
  await reloadMod.reloadExtensions({ cwd })
  check('boot + roster + reload made ZERO requests', requestLog.length === 0, `${requestLog.join(' | ')} — nothing in boot, computeRoster or reload may fetch a source; updates happen only on an operator act (sources.refreshSource, install.update)`)
  const stale = sources.listSources().find(r => r.label === 'remote-arch')
  check('the month-old source reads ↻ stale — the whole nudge', stale?.state === 'stale', `${stale?.state} — listSources in src/integrations/extensions/sources.ts must read a source last checked 30 days ago as stale`)
  server.close()
}

removeScratch(scratch)
console.log(failures === 0 ? '\n ✅ UPDATE DISCIPLINE — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
