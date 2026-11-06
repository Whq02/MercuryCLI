#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dir, '../..')
const option = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const scratchArg = option('--scratch'), archives = option('--archives')
const scratch = scratchArg ? resolve(scratchArg) : await mkdtemp(join(tmpdir(), 'craft-foreign-platform-'))
assert(isAbsolute(scratch) && !scratch.startsWith(root), 'Pass --scratch <isolated absolute folder outside the repository>')
assert(!archives || isAbsolute(archives), '--archives names an absolute folder holding already downloaded release archives; the installer still enforces every size and SHA-256')
if (!scratchArg) process.once('exit', () => rmSync(scratch, { recursive: true, force: true }))
const apps = ['filmcraft', 'lightcraft', 'photocraft'] as const
const platforms = ['win-x64', 'linux-x64'] as const
const fetcher: typeof fetch = async (input, init) => {
  const local = archives ? join(archives, basename(new URL(String(input)).pathname)) : undefined
  if (local && existsSync(local)) return new Response(await readFile(local))
  return fetch(input, init)
}
const evidence = { host: `${process.platform}-${process.arch}`, archives: archives ?? 'downloaded from the pinned release URLs', rows: [] as Array<Record<string, unknown>> }
console.log('Craft foreign-platform installs: the Windows x64 and Linux x64 archives each app lock pins, installed through shared/install.mjs on this host. The binaries are not run here; the field box\'s Windows install (release step A6) is the proof that the .exe runs.')
for (const app of apps) {
  const delivered = join(scratch, app, 'extension')
  await cp(join(root, 'src/extensions/bundled', app), delivered, { recursive: true })
  await cp(join(root, 'src/extensions/bundled/shared'), join(delivered, 'shared'), { recursive: true })
  const { adapter } = await import(pathToFileURL(join(delivered, 'server/install.mjs')).href)
  const { checkInstall, installPinned, planInstall } = await import(pathToFileURL(join(delivered, 'shared/install.mjs')).href)
  const foreign = { ...adapter, guiBasename: adapter.id }
  assert.equal(planInstall(adapter, { dataDir: join(scratch, app, 'plan'), platform: 'darwin-arm64' }).payloads.length, adapter.pins.length, `${app}: macOS takes every pin`)
  for (const platform of platforms) {
    const dataDir = join(scratch, app, platform)
    const row = adapter.pins[0].platforms[platform]
    const plan = planInstall(foreign, { dataDir, platform })
    assert.equal(plan.payloads.length, 1, `${app} ${platform}: one pinned archive carries the app and its command-line tool`)
    assert.equal(plan.payloads[0].archive, row.archive)
    let asks = 0
    const installation = await installPinned(foreign, { dataDir, platform, fetcher, authorize: async () => { asks++; return true }, onProgress: (received: number, total: number, archive: string) => { if (received === total) console.log(`${archive}: ${received} bytes received`) } })
    assert.equal(asks, 1)
    const win = platform === 'win-x64'
    const cli = installation.cli.slice(installation.root.length + 1), gui = installation.gui.slice(installation.root.length + 1)
    assert(cli.endsWith(win ? `${app}-cli.exe` : `/bin/${app}-cli`), cli)
    assert(gui.endsWith(win ? `${app}.exe` : `/bin/${app}`), gui)
    assert.deepEqual(installation.manifest.archives.map((a: { archive: string; bytes: number; sha256: string }) => [a.archive, a.bytes, a.sha256]), [[row.archive, row.bytes, row.sha256]])
    for (const name of ['LICENSE-MIT', 'LICENSE-APACHE', 'NOTICE']) assert(installation.manifest.licences.some((l: { name: string; path: string }) => l.name === name && !l.path.includes('supplemental-notices')), `${app} ${platform}: ${name} travels inside the archive`)
    assert.equal((await checkInstall(foreign, { dataDir, platform })).state, 'installed')
    assert((await installPinned(foreign, { dataDir, platform, fetcher, authorize: () => { throw new Error('Reuse must not ask') } })).reused)
    evidence.rows.push({ app, platform, archive: row.archive, bytes: row.bytes, sha256: row.sha256, cli, gui, fileCount: installation.manifest.fileCount, treeDigest: installation.manifest.treeDigest, licences: installation.manifest.licences.map((l: { path: string }) => l.path) })
    console.log(`PASS ${app} ${platform}: ${row.archive} installed from the one pinned archive (${row.bytes} bytes, SHA-256 enforced); ${cli} and ${gui} identified; LICENSE-MIT, LICENSE-APACHE and NOTICE found in the tree; offline check and reuse without a second ask`)
  }
}
await writeFile(join(scratch, 'foreign-platform-installs.json'), JSON.stringify(evidence, null, 2))
console.log(`PASS: ${apps.length * platforms.length} foreign-platform installs on ${evidence.host}; evidence ${join(scratch, 'foreign-platform-installs.json')}`)
