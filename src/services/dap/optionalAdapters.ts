import pins from '../../../vendor/dap-adapters.lock.json' with { type: 'json' }
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { downloadPinned, extractArchive, treeRecord } from '../../extensions/bundled/shared/install.mjs'
import { getMercuryHome } from '../../utils/envUtils.js'

interface Asset { archive: string; url: string; bytes: number; sha256: string; entry: string }
interface Pin { title: string; version: string; repository: string; license: string; licenseFiles: string[]; licenseText?: string; platforms: Record<string, Asset> }
interface OptionalAdapterPlan extends Asset {
  key: string
  title: string
  version: string
  licenseFiles: string[]
  licenseText?: string
  home: string
  platform: string
  destination: string
}
const catalogue: Record<string, Pin> = pins

export function optionalAdapterPlan(key: string, home = getMercuryHome(), platform = `${process.platform}-${process.arch}`): OptionalAdapterPlan | null {
  const pin = catalogue[key]
  const asset = pin?.platforms[platform] ?? pin?.platforms.any
  if (!pin || !asset) return null
  return { ...asset, key, title: pin.title, version: pin.version, licenseFiles: pin.licenseFiles, ...(pin.licenseText ? { licenseText: pin.licenseText } : {}), home, platform, destination: join(home, 'adapters', key, `${pin.version}-${platform}`) }
}

export function installedOptionalAdapter(key: string): string | null {
  const plan = optionalAdapterPlan(key)
  if (!plan) return null
  try {
    const manifest = JSON.parse(readFileSync(join(plan.destination, '.vendor-manifest.json'), 'utf8'))
    if (manifest.sha256 !== plan.sha256 || manifest.version !== plan.version) return null
    if (lstatSync(plan.destination).isSymbolicLink()) return null
    for (const file of [plan.entry, ...plan.licenseFiles]) {
      if (!lstatSync(join(plan.destination, file)).isFile()) return null
    }
    return join(plan.destination, plan.entry)
  } catch {
    return null
  }
}

function realDirectory(directory: string): void {
  if (!existsSync(directory)) return
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Application data and runtime directories must be real directories, not links')
}

export async function installOptionalAdapter(plan: OptionalAdapterPlan, options: {
  authorize: (plan: OptionalAdapterPlan) => Promise<boolean>
  signal?: AbortSignal
  fetcher?: typeof fetch
}): Promise<string | null> {
  const current = optionalAdapterPlan(plan.key, plan.home, plan.platform)
  if (!current || JSON.stringify(current) !== JSON.stringify(plan)) throw new Error('Installed release does not match the requested version')
  options.signal?.throwIfAborted()
  realDirectory(dirname(dirname(plan.destination)))
  realDirectory(dirname(plan.destination))
  realDirectory(plan.destination)
  if (existsSync(plan.destination)) {
    const manifest = JSON.parse(readFileSync(join(plan.destination, '.vendor-manifest.json'), 'utf8'))
    const tree = await treeRecord(plan.destination)
    if (manifest.sha256 !== plan.sha256 || manifest.treeDigest !== tree.treeDigest) throw new Error('Installed files have changed')
    return join(plan.destination, plan.entry)
  }
  if (!await options.authorize(plan)) return null
  options.signal?.throwIfAborted()
  const parent = dirname(plan.destination)
  realDirectory(dirname(parent))
  realDirectory(parent)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  realDirectory(parent)
  const lockPath = join(parent, '.install-lock')
  const lock = await open(lockPath, 'wx', 0o600)
  let stage: string | undefined
  try {
    stage = await mkdtemp(join(parent, '.stage-'))
    const archive = join(stage, plan.archive)
    const unpack = join(stage, 'unpack')
    await downloadPinned(plan, archive, options)
    await mkdir(unpack)
    await extractArchive(archive, unpack, options)
    if (plan.licenseText) await writeFile(join(unpack, plan.licenseFiles[0]!), plan.licenseText, { flag: 'wx' })
    for (const file of [plan.entry, ...plan.licenseFiles]) {
      if (!lstatSync(join(unpack, file)).isFile()) throw new Error(`Missing licence or adapter entry: ${file}`)
    }
    if (!plan.entry.endsWith('.js')) await chmod(join(unpack, plan.entry), 0o755)
    const tree = await treeRecord(unpack)
    await writeFile(join(unpack, '.vendor-manifest.json'), JSON.stringify({ version: plan.version, sha256: plan.sha256, treeDigest: tree.treeDigest, fileCount: tree.fileCount }) + '\n')
    options.signal?.throwIfAborted()
    await rename(unpack, plan.destination)
    return join(plan.destination, plan.entry)
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true })
    await lock.close()
    await rm(lockPath, { force: true })
  }
}
