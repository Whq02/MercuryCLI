#!/usr/bin/env bun
// ============================================================================
//  scripts/extensions/prove-update-discipline.ts — nothing updates on its
//  own.
//
//  §1 a source listing a newer version changes NOTHING until `check`; after
//     `check` the row notes the update and nothing was fetched into
//     installed/.
//  §2 the version key is decided PRE-FETCH: the folder an update lands in
//     is the catalogue's version; a catalogue lying about the version
//     refuses the install; a warm re-read finds the copy under the
//     pre-fetch key with the remote DELETED (no re-clone).
//  §3 `update` fetches into a NEW version folder, never touching the
//     running one; an unchanged contributions hash carries the approval; a
//     changed one waits for the diff card (approve applies, discard removes
//     the fetched folder and keeps the old version).
//  §4 the previous folder is kept until the first clean load, then removed;
//     a broken new version keeps it and `--previous` swaps back with no
//     re-approval.
//  §5 in-place extensions re-ask only on a contributions change (a version
//     bump alone carries over).
//  §6 no background timer exists: across a full boot-load + roster + reload
//     the loopback request log stays EMPTY (boot never fetches).
// ============================================================================
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const paths = await import('../../src/extensions/paths.ts')
const records = await import('../../src/extensions/records.ts')
const sources = await import('../../src/extensions/sources.ts')
const install = await import('../../src/extensions/install.ts')
const rosterMod = await import('../../src/extensions/roster.ts')
const reloadMod = await import('../../src/extensions/reload.ts')
const boot = await import('../../src/extensions/boot.ts')

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
check('the source adds', added.ok)
const installed = await install.installFromSource('update-src', 'kitchen-sink')
check('1.0.0 installs', installed.ok && installed.record.version === '1.0.0')
check('approve lands', install.approve(ID).ok)
await reloadMod.reloadExtensions({ cwd })

// ── §1 only a check discovers ───────────────────────────────────────────────
console.log('[1] a newer version upstream changes nothing until check')
{
  bump(repo, '1.1.0')
  const row = rosterMod.computeRoster({ cwd }).entries.find(e => e.id === ID)
  check('before the check: no update known', row?.availableVersion === null)
  const refreshed = await sources.refreshSource('update-src')
  check('check names the update', refreshed.ok && refreshed.updates.some(u => u.id === ID && u.to === '1.1.0'))
  const after = rosterMod.computeRoster({ cwd }).entries.find(e => e.id === ID)
  check('after the check: ↑ 1.1.0 available on the row', after?.availableVersion === '1.1.0')
  check('nothing was fetched into installed/', !existsSync(paths.getInstalledVersionDir(ID, '1.1.0')))
  check('the running version is untouched', records.installedOrEmpty()[ID]?.version === '1.0.0')
}

// ── §2 the version key is decided pre-fetch ─────────────────────────────────
console.log('[2] the version key: pre-fetch; a lying catalogue refuses; a warm read needs no remote')
{
  // A catalogue lying about the version (manifest stays 1.1.0, catalogue says 2.0.0)
  const cataloguePath = join(repo, 'mercury-extensions.json')
  const catalogue = JSON.parse(readFileSync(cataloguePath, 'utf8'))
  catalogue.extensions.find((e: { name: string }) => e.name === 'kitchen-sink').version = '2.0.0'
  writeFileSync(cataloguePath, JSON.stringify(catalogue, null, 2))
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'lie'], repo)
  const refreshed = await sources.refreshSource('update-src')
  check('the lying source refreshes (the lie is caught at install)', refreshed.ok)
  const lied = await install.update(ID)
  check('the update refuses the lie naming both versions', !lied.ok && lied.reason === 'catalogue says 2.0.0, manifest says 1.1.0', lied.ok ? 'applied' : lied.reason)
  check('no 2.0.0 folder remains', !existsSync(paths.getInstalledVersionDir(ID, '2.0.0')))
  // repair the catalogue
  catalogue.extensions.find((e: { name: string }) => e.name === 'kitchen-sink').version = '1.1.0'
  writeFileSync(cataloguePath, JSON.stringify(catalogue, null, 2))
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'repair'], repo)
  check('re-check lands', (await sources.refreshSource('update-src')).ok)
  // the warm read: the record's path IS the pre-fetch key; delete the remote — everything still reads
  const record = records.installedOrEmpty()[ID]!
  check('the record path is the version-keyed folder', record.path === paths.getInstalledVersionDir(ID, '1.0.0'))
  rmSync(repo, { recursive: true, force: true })
  const warm = rosterMod.computeRoster({ cwd }).entries.find(e => e.id === ID)
  check('with the remote DELETED the copy still resolves under the key (no re-clone)', warm !== undefined && warm.root === record.path && warm.manifest !== null)
  // restore the remote for the rest
  cpSync(FIXTURE, repo, { recursive: true })
  bumpRestore()
}
function bumpRestore(): void {
  git(['init', '-q', '-b', 'main'], repo)
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'restore 1.0.0'], repo)
  bump(repo, '1.1.0')
}

// ── §3 carry-over vs the diff card ──────────────────────────────────────────
console.log('[3] update: a new folder, approval carried when the hash is unchanged, the card when changed')
{
  check('re-check after restore', (await sources.refreshSource('update-src')).ok)
  const carried = await install.update(ID)
  check('an unchanged contributions hash carries the approval', carried.ok && carried.outcome === 'carried' && carried.ok && (carried as { to?: string }).to === '1.1.0', carried.ok ? carried.outcome : carried.reason)
  const record = records.installedOrEmpty()[ID]!
  check('the record moved to the new version folder', record.version === '1.1.0' && record.path === paths.getInstalledVersionDir(ID, '1.1.0'))
  check('the previous folder is kept until a clean load', record.previous?.version === '1.0.0' && existsSync(record.previous!.path))
  check('the row reads ◐ reload with both versions', (() => {
    const row = rosterMod.computeRoster({ cwd }).entries.find(e => e.id === ID)
    return row?.pending === 'update'
  })())
  await reloadMod.reloadExtensions({ cwd })
  const settled = records.installedOrEmpty()[ID]!
  check('after the clean load the previous folder is removed', settled.previous === null && !existsSync(paths.getInstalledVersionDir(ID, '1.0.0')))

  // a changed contributions hash waits for the card
  bump(repo, '1.2.0', m => {
    ;(m as { contributes: { hooks: Record<string, unknown> } }).contributes.hooks['Stop'] = [{ hooks: [{ type: 'command', command: 'true' }] }]
  })
  check('check finds 1.2.0', (await sources.refreshSource('update-src')).ok)
  const needs = await install.update(ID)
  check('a changed hash fetches and WAITS for the card', needs.ok && needs.outcome === 'needs-approval', needs.ok ? needs.outcome : needs.reason)
  check('the fetched folder exists; the running version is untouched', existsSync(paths.getInstalledVersionDir(ID, '1.2.0')) && records.installedOrEmpty()[ID]?.version === '1.1.0')
  check('discard removes the fetched folder and keeps 1.1.0', (() => {
    const discarded = install.discardUpdate(ID)
    return discarded.ok && !existsSync(paths.getInstalledVersionDir(ID, '1.2.0')) && records.installedOrEmpty()[ID]?.version === '1.1.0'
  })())
  const again = await install.update(ID)
  check('fetch again', again.ok && again.outcome === 'needs-approval')
  const applied = install.approveUpdate(ID)
  check("the diff card's approve applies with a fresh approval", applied.ok && records.installedOrEmpty()[ID]?.version === '1.2.0' && records.installedOrEmpty()[ID]?.approval?.contributionsHash === records.installedOrEmpty()[ID]?.contributionsHash)
}

// ── §4 a broken new version keeps the previous; --previous swaps back ───────
console.log('[4] previous: kept while broken, swapped back without re-approval')
{
  // break the NEW copy on disk before its first load (simulating a broken 1.2.0)
  const record = records.installedOrEmpty()[ID]!
  check('1.2.0 keeps 1.1.0 until its first clean load', record.previous?.version === '1.1.0')
  writeFileSync(join(record.path, 'mercury-extension.json'), '{ broken')
  await reloadMod.reloadExtensions({ cwd })
  const kept = records.installedOrEmpty()[ID]!
  check('a broken first load KEEPS the previous folder', kept.previous?.version === '1.1.0' && existsSync(kept.previous!.path))
  const swapped = install.swapToPrevious(ID)
  check('--previous swaps back with no re-approval (its hash was approved)', swapped.ok && records.installedOrEmpty()[ID]?.version === '1.1.0' && records.installedOrEmpty()[ID]?.approval !== null)
  await reloadMod.reloadExtensions({ cwd })
  const back = rosterMod.computeRoster({ cwd }).entries.find(e => e.id === ID)
  check('1.1.0 is on again', back !== undefined && rosterMod.trustStateOf(back) === 'on')
}

// ── §5 in-place re-asks only on a contributions change ──────────────────────
console.log('[5] in-place: a version bump alone carries; a contributions change re-asks')
{
  const folder = join(cwd, '.mercury', 'extensions', 'needs-node')
  cpSync(join(FIXTURE, 'needs-node'), folder, { recursive: true })
  const approved = install.approve('needs-node@project', { root: folder, scope: 'project' })
  check('the folder approves in place', approved.ok)
  const manifestPath = join(folder, 'mercury-extension.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.version = '2.1.0'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  let row = rosterMod.computeRoster({ cwd }).entries.find(e => e.id === 'needs-node@project')
  check('a version bump alone carries the approval', row !== undefined && row.approved && !row.changedSinceApproval)
  manifest.contributes.servers['second'] = { command: 'node', args: ['-e', '0'] }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  row = rosterMod.computeRoster({ cwd }).entries.find(e => e.id === 'needs-node@project')
  check('a contributions change reads changed — re-approve', row?.changedSinceApproval === true)
  rmSync(folder, { recursive: true, force: true })
}

// ── §6 no background timer; boot never fetches ──────────────────────────────
console.log('[6] no background updater: the request log stays empty across a full boot')
{
  const requestLog: string[] = []
  const server: Server = createServer((req, res) => {
    requestLog.push(String(req.url))
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>(r => server.listen(34312, '127.0.0.1', () => r()))
  // an http archive source in the records: boot must not touch it
  records.updateSources(current => ({
    ...current,
    'remote-arch': { kind: 'archive', where: 'http://127.0.0.1:34312/x.zip', ref: null, addedAt: new Date().toISOString(), checkedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(), commit: null, lastError: null },
  }))
  const result = await boot.reloadExtensions({ cwd })
  void result
  rosterMod.computeRoster({ cwd })
  await reloadMod.reloadExtensions({ cwd })
  check('boot + roster + reload made ZERO requests', requestLog.length === 0, requestLog.join(' | '))
  const stale = sources.listSources().find(r => r.label === 'remote-arch')
  check('the month-old source reads ↻ stale — the whole nudge', stale?.state === 'stale', stale?.state)
  check('no timer API exists in the sources module (structural)', !readFileSync(join(import.meta.dir, '..', '..', 'src', 'extensions', 'sources.ts'), 'utf8').includes('setInterval'))
  server.close()
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ UPDATE DISCIPLINE — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
