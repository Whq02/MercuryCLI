import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const hostPlatform = () => process.env.MERCURY_CRAFT_PLATFORM?.trim() || `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`
const abort = signal => signal?.throwIfAborted()
const present = async path => { try { await lstat(path); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e } }

export function safeMember(name) {
  if (typeof name !== 'string' || !name || /[\x00-\x1f\\:]/.test(name) || isAbsolute(name) || name.split('/').some(p => p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p))) throw new Error(`Unsafe archive path: ${JSON.stringify(name)}`)
  return name.replace(/^\.\//, '')
}

export function validatePin(pin) {
  if (!pin || !/^[a-z0-9-]+$/.test(pin.name) || !/^\d+\.\d+\.\d+$/.test(pin.version) || pin.tag !== `v${pin.version}` || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(pin.repository)) throw new Error('Invalid release identity')
  if (!Array.isArray(pin.licenseFiles) || !pin.licenseFiles.length || !pin.license) throw new Error('Release must name its licences')
  pin.licenseFiles.forEach(safeMember)
  if (!pin.platforms || !Object.keys(pin.platforms).length) throw new Error('Release has no platforms')
  for (const row of Object.values(pin.platforms)) {
    safeMember(row.archive)
    if (row.archive.includes('/') || !row.archive.includes(pin.version) || row.url !== `${pin.repository}/releases/download/${pin.tag}/${row.archive}` || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes <= 0) throw new Error('Invalid release asset URL, size or SHA-256')
  }
  return pin
}

export function planInstall(adapter, { dataDir, platform = hostPlatform() }) {
  if (!isAbsolute(dataDir) || !/^[a-z0-9-]+$/.test(adapter.id)) throw new Error('An absolute application data directory is required')
  const pins = adapter.pins.map(validatePin)
  if (!pins.length || pins[0].name !== adapter.id || pins.some(pin => pin.version !== adapter.version)) throw new Error('App and command-line tool versions must match')
  const payloads = pins.flatMap(pin => {
    const row = pin.platforms[platform]
    return row ? [{ ...row, name: pin.name, licenseFiles: pin.licenseFiles, repository: pin.repository, tag: pin.tag }] : []
  })
  if (!pins[0].platforms[platform]) throw new Error(`${adapter.title} has no supported release for ${platform}`)
  if (platform.startsWith('darwin') && payloads.length !== pins.length) throw new Error('The matching macOS command-line tool is missing')
  const destination = join(dataDir, 'runtime', `${adapter.version}-${platform}`)
  const plan = { app: adapter.id, title: adapter.title, version: adapter.version, platform, bytes: payloads.reduce((n, p) => n + p.bytes, 0), payloads, destination }
  return { ...plan, digest: sha256(JSON.stringify(plan)) }
}

export async function treeRecord(root) {
  const entries = []
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name), rel = relative(root, path).split(sep).join('/')
      if (rel === '.vendor-manifest.json') continue
      safeMember(rel)
      const info = await lstat(path)
      if (info.isSymbolicLink()) {
        const target = await readlink(path)
        if (isAbsolute(target) || !contained(root, resolve(dirname(path), target)) || !contained(root, await realpath(path))) throw new Error(`Symlink escapes installation: ${rel}`)
        entries.push({ path: rel, kind: 'link', sha256: sha256(target), mode: info.mode & 0o777 })
      } else if (info.isDirectory()) await walk(path)
      else if (info.isFile()) entries.push({ path: rel, kind: 'file', sha256: await hashFile(path), mode: info.mode & 0o777 })
      else throw new Error(`Unsupported file type: ${rel}`)
    }
  }
  await walk(root)
  return { entries, fileCount: entries.length, treeDigest: sha256(JSON.stringify(entries)) }
}
const contained = (root, path) => path === root || path.startsWith(root + sep)
async function checkDataDirectories(dataDir) {
  for (const path of [dataDir, join(dataDir, 'runtime')]) {
    if (!await present(path)) continue
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Application data and runtime directories must be real directories, not links')
  }
}
async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function resolveBinaries(adapter, root, platform, entries) {
  const win = platform.startsWith('win-')
  const cliName = adapter.cliBasename + (win ? '.exe' : '')
  const guiName = adapter.guiBasename + (win ? '.exe' : '')
  const pick = (name, gui) => {
    const matches = entries.filter(f => f.kind === 'file' && basename(f.path) === name && (!gui || !platform.startsWith('darwin') || f.path.includes('.app/Contents/MacOS/')))
    if (matches.length !== 1) throw new Error(`Expected one ${name}, found ${matches.length}`)
    return matches[0].path
  }
  return { cli: pick(cliName, false), gui: pick(guiName, true) }
}

export async function checkInstall(adapter, options) {
  const plan = planInstall(adapter, options)
  try {
    await checkDataDirectories(options.dataDir)
    if (!await present(plan.destination)) return { state: 'absent', plan }
    if ((await lstat(plan.destination)).isSymbolicLink()) throw new Error('Installation directory is a symbolic link')
    const manifest = JSON.parse(await readFile(join(plan.destination, '.vendor-manifest.json'), 'utf8'))
    if (manifest.planDigest !== plan.digest || manifest.version !== plan.version || manifest.platform !== plan.platform) throw new Error('Installed release does not match the requested version')
    const tree = await treeRecord(plan.destination)
    if (tree.fileCount !== manifest.fileCount || tree.treeDigest !== manifest.treeDigest) throw new Error('Installed files have changed')
    const binaries = await resolveBinaries(adapter, plan.destination, plan.platform, tree.entries)
    if (manifest.cli !== binaries.cli || manifest.gui !== binaries.gui || manifest.cliSha256 !== tree.entries.find(f => f.path === binaries.cli)?.sha256 || manifest.guiSha256 !== tree.entries.find(f => f.path === binaries.gui)?.sha256) throw new Error('Installed executable identity has changed')
    for (const p of plan.payloads) for (const name of p.licenseFiles) {
      if (!manifest.licences?.some(l => l.payload === p.name && l.name === name && tree.entries.some(f => f.path === l.path && f.sha256 === l.sha256))) throw new Error(`Missing licence: ${p.name}/${name}`)
    }
    return { state: 'installed', plan, installation: { root: plan.destination, cli: join(plan.destination, binaries.cli), gui: join(plan.destination, binaries.gui), manifest, reused: true } }
  } catch (error) { return { state: 'invalid', plan, reason: error.message } }
}

async function downloadPinned(row, destination, { signal, onProgress, fetcher = fetch } = {}) {
  abort(signal)
  const response = await fetcher(row.url, { signal, redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
  const final = new URL(response.url || row.url)
  if (final.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(final.hostname)) throw new Error('Download redirected outside GitHub release storage')
  const output = await open(destination, 'wx', 0o600)
  let received = 0
  const hash = createHash('sha256')
  try {
    for await (const chunk of response.body) {
      abort(signal)
      received += chunk.length
      if (received > row.bytes) throw new Error(`Download exceeds expected size: ${row.archive}`)
      hash.update(chunk)
      await output.writeFile(chunk)
      onProgress?.(received, row.bytes, row.archive)
    }
    abort(signal)
    const digest = hash.digest('hex')
    if (received !== row.bytes || digest !== row.sha256) throw new Error(`Size or SHA-256 mismatch: ${row.archive}`)
    return { archive: row.archive, bytes: received, sha256: digest, url: row.url }
  } catch (error) { await output.close(); await rm(destination, { force: true }); throw error }
  finally { await output.close().catch(() => {}) }
}

export function zipEntries(bytes) {
  let end = bytes.length - 22
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0 || end < bytes.length - 65557) throw new Error('Invalid ZIP directory')
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16)
  if (count === 65535 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) throw new Error('Unsupported multi-volume or ZIP64 archive')
  let at = start
  const entries = [], names = new Set()
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid ZIP entry')
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), compressed = bytes.readUInt32LE(at + 20), size = bytes.readUInt32LE(at + 24)
    const n = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32), mode = bytes.readUInt32LE(at + 38) >>> 16, offset = bytes.readUInt32LE(at + 42)
    const path = safeMember(bytes.subarray(at + 46, at + 46 + n).toString('utf8'))
    const key = path.replace(/\/$/, '').toLowerCase()
    if (names.has(key) || flags & 1 || ![0, 8].includes(method) || ((mode & 0o170000) && ![0o040000, 0o100000].includes(mode & 0o170000))) throw new Error(`Unsafe ZIP entry: ${path}`)
    names.add(key)
    if (bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error('Invalid ZIP local header')
    const localN = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28), dataAt = offset + 30 + localN + localExtra
    if (bytes.subarray(offset + 30, offset + 30 + localN).toString('utf8') !== path || dataAt + compressed > start) throw new Error('ZIP member identity mismatch')
    entries.push({ path, mode, size, directory: path.endsWith('/'), compressed: bytes.subarray(dataAt, dataAt + compressed), method })
    at += 46 + n + extra + comment
  }
  return entries
}

async function extractArchive(archive, destination, { signal } = {}) {
  abort(signal)
  if (archive.endsWith('.dmg')) {
    if (process.platform !== 'darwin') throw new Error('Disk images require macOS')
    const mount = `${destination}.mount`
    await mkdir(mount)
    let mounted = false
    try {
      await exec('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, archive], { signal })
      mounted = true
      const apps = (await readdir(mount)).filter(name => name.endsWith('.app'))
      if (apps.length !== 1) throw new Error('Disk image must contain one application')
      const app = join(mount, apps[0])
      await treeRecord(app)
      await cp(app, join(destination, apps[0]), { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true })
      for (const name of await readdir(mount)) if (/^(LICENSE|NOTICE|COPYING)/i.test(name) && (await lstat(join(mount, name))).isFile()) await cp(join(mount, name), join(destination, safeMember(name)))
    } finally {
      if (mounted) await exec('/usr/bin/hdiutil', ['detach', mount])
      await rm(mount, { recursive: true, force: true })
    }
  } else if (archive.endsWith('.zip')) {
    const entries = zipEntries(await readFile(archive))
    for (const entry of entries) {
      abort(signal)
      const path = join(destination, entry.path)
      if (entry.directory) { await mkdir(path, { recursive: true }); continue }
      const data = entry.method === 8 ? inflateRawSync(entry.compressed, { maxOutputLength: entry.size + 1 }) : entry.compressed
      if (data.length !== entry.size) throw new Error(`Invalid ZIP member size: ${entry.path}`)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, data, { flag: 'wx', mode: entry.mode & 0o111 ? 0o755 : 0o644 })
    }
  } else if (archive.endsWith('.tar.gz')) {
    const data = gunzipSync(await readFile(archive)), entries = [], names = new Set()
    const string = b => b.toString('utf8').replace(/\0.*$/s, '')
    for (let at = 0; at + 512 <= data.length;) {
      const h = data.subarray(at, at + 512)
      if (h.every(b => b === 0)) break
      const prefix = string(h.subarray(345, 500)), name = string(h.subarray(0, 100))
      const path = safeMember((prefix ? prefix + '/' : '') + name), type = h[156], size = parseInt(string(h.subarray(124, 136)).trim(), 8) || 0
      if (![0, 48, 53].includes(type) || names.has(path.toLowerCase()) || !Number.isSafeInteger(size) || size < 0 || at + 512 + size > data.length) throw new Error(`Unsafe TAR entry: ${path}`)
      names.add(path.toLowerCase())
      entries.push({ path, directory: type === 53, data: data.subarray(at + 512, at + 512 + size), mode: parseInt(string(h.subarray(100, 108)).trim(), 8) })
      at += 512 + Math.ceil(size / 512) * 512
    }
    for (const entry of entries) {
      abort(signal)
      const path = join(destination, entry.path)
      if (entry.directory) await mkdir(path, { recursive: true })
      else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, entry.data, { flag: 'wx', mode: entry.mode & 0o111 ? 0o755 : 0o644 }) }
    }
  } else throw new Error('Unsupported release archive')
  abort(signal)
  await treeRecord(destination)
}

export async function installPinned(adapter, options) {
  const { signal, authorize, onProgress } = options
  const plan = planInstall(adapter, options)
  abort(signal)
  const checked = await checkInstall(adapter, options)
  if (checked.state === 'installed') return checked.installation
  if (checked.state === 'invalid') throw new Error(`${adapter.title} installation is invalid: ${checked.reason}. Existing files were not replaced.`)
  if (options.existingVersion && options.existingVersion !== adapter.version) throw new Error(`${adapter.title} ${options.existingVersion} was not changed. This integration requires ${adapter.version}.`)
  if (typeof authorize !== 'function' || !await authorize(plan)) throw new Error('Installation declined. Nothing was installed.')
  abort(signal)
  const runtime = join(options.dataDir, 'runtime')
  await checkDataDirectories(options.dataDir)
  await mkdir(runtime, { recursive: true, mode: 0o700 })
  await checkDataDirectories(options.dataDir)
  const lockPath = join(runtime, '.install-lock')
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Another installation is in progress. Check its result before trying again.') })
  let stage
  try {
    const again = await checkInstall(adapter, options)
    if (again.state === 'installed') return again.installation
    stage = await mkdtemp(join(runtime, '.stage-'))
    const root = join(stage, 'app'), archives = join(stage, 'downloads')
    await mkdir(root); await mkdir(archives)
    const receipts = [], licences = []
    for (const payload of plan.payloads) {
      abort(signal)
      const archive = join(archives, payload.archive), unpack = join(root, payload.name)
      receipts.push(await downloadPinned(payload, archive, { signal, onProgress, fetcher: options.fetcher }))
      await mkdir(unpack)
      await (options.extractor ?? extractArchive)(archive, unpack, { signal })
      const files = (await treeRecord(unpack)).entries
      for (const name of payload.licenseFiles) {
        const found = files.find(f => basename(f.path) === name && f.kind === 'file')
        if (found) licences.push({ payload: payload.name, name, path: `${payload.name}/${found.path}`, sha256: found.sha256, source: payload.url })
        else {
          const notice = adapter.notices?.find(n => n.name === name && n.source === `${payload.repository}/blob/${payload.tag}/${name}`)
          if (!notice || sha256(notice.content) !== notice.sha256) throw new Error(`Missing licence: ${payload.name}/${name}`)
          const path = `${payload.name}/supplemental-notices/${safeMember(name)}`
          await mkdir(dirname(join(root, path)), { recursive: true })
          await writeFile(join(root, path), notice.content, { flag: 'wx' })
          licences.push({ payload: payload.name, name, path, sha256: notice.sha256, source: notice.source })
        }
      }
    }
    const tree = await treeRecord(root), binaries = await resolveBinaries(adapter, root, plan.platform, tree.entries)
    if (!plan.platform.startsWith('win-')) { await chmod(join(root, binaries.cli), 0o755); await chmod(join(root, binaries.gui), 0o755) }
    const finalTree = await treeRecord(root)
    const manifest = { name: adapter.id, version: adapter.version, platform: plan.platform, planDigest: plan.digest, archiveSha256: plan.payloads.map(p => p.sha256), archives: receipts, licences, ...binaries, cliSha256: await hashFile(join(root, binaries.cli)), guiSha256: await hashFile(join(root, binaries.gui)), fileCount: finalTree.fileCount, treeDigest: finalTree.treeDigest }
    await writeFile(join(root, '.vendor-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    abort(signal)
    await rename(root, plan.destination)
    return { root: plan.destination, cli: join(plan.destination, binaries.cli), gui: join(plan.destination, binaries.gui), manifest, reused: false }
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true })
    await lock.close(); await rm(lockPath, { force: true })
  }
}
