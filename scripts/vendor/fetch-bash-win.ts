#!/usr/bin/env bun
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BASH_PACK_NAME, BASH_PACK_PATH, bashPackPlatform } from '../../src/platform/shell/bashPack.ts'
import { RELEASE_TARGETS, buildPlatformOf, isReleaseTarget } from '../../src/platform/update-channel/releaseTarget.ts'
import {
  BashWinPackRefused,
  bashWinPackFault,
  bashWinPlatforms,
  layBashWinPack,
  measureFile,
  pinnedBashWinFiles,
  pinnedFileFault,
  readBashWinLock,
  type BashWinLock,
  type PinnedFile,
} from './lay-bash-win-pack.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const LOCK_PATH = join(ROOT, 'vendor', 'bash.lock.json')

const argv = process.argv.slice(2)
const valueOf = (flag: string): string | null => {
  const at = argv.indexOf(flag)
  return at === -1 ? null : (argv[at + 1] ?? '')
}
const checkOnly = argv.includes('--check')
const force = argv.includes('--force')
const all = argv.includes('--all')
const offline = argv.includes('--offline')
const withSources = argv.includes('--sources')
const PACK_ROOT = resolve(valueOf('--out') ?? join(ROOT, ...BASH_PACK_PATH.split('/')))
const CACHE_DIR = resolve(valueOf('--cache') ?? join(PACK_ROOT, 'archive', 'msys2'))
const DOWNLOAD_TRIES = 3
const DOWNLOAD_LIMIT_MS = 300_000

function fail(msg: string): never {
  console.error(`fetch-bash-win: ${msg}`)
  process.exit(1)
}

function selectPlatforms(lock: BashWinLock): string[] {
  const known = bashWinPlatforms(lock)
  if (all) return known
  const target = valueOf('--target')
  if (target !== null) {
    if (!isReleaseTarget(target)) fail(`--target wants one of ${RELEASE_TARGETS.join(', ')} (got ${target || 'nothing'})`)
    const ship = buildPlatformOf(target)
    const platform = bashPackPlatform(ship.platform, ship.arch)
    if (platform === null || !known.includes(platform)) {
      console.log(`fetch-bash-win: the bash pack for ${target} is built, not fetched (bun run scripts/vendor/build-bash.ts --target ${target}) — nothing to fetch`)
      process.exit(0)
    }
    return [platform]
  }
  const named = valueOf('--platform')
  if (named !== null) {
    if (!known.includes(named)) fail(`--platform wants one of ${known.join(', ')} (got ${named || 'nothing'})`)
    return [named]
  }
  const host = bashPackPlatform()
  if (host === null || !known.includes(host)) {
    console.log(`fetch-bash-win: this host (${process.platform}/${process.arch}) takes no fetched bash pack — nothing to fetch (--platform ${known.join(' or --platform ')}, or --all, lays one out for a Windows build)`)
    process.exit(0)
  }
  return [host]
}

async function secure(pinned: PinnedFile): Promise<void> {
  const standing = measureFile(pinned.path)
  if (standing !== null && standing.bytes === pinned.bytes && standing.sha256 === pinned.sha256) {
    console.log(`fetch-bash-win: ok ${pinned.file}  ${pinned.bytes} bytes  sha256 ${pinned.sha256}  (in the cache, verified)`)
    return
  }
  if (offline) fail(pinnedFileFault(pinned) ?? `${pinned.file} is not usable`)
  if (standing !== null) console.log(`fetch-bash-win: ${pinned.file} in the cache does not match the lock — downloading it again`)
  console.log(`fetch-bash-win: downloading ${pinned.url}`)
  mkdirSync(resolve(pinned.path, '..'), { recursive: true })
  const tmp = `${pinned.path}.tmp-${process.pid}`
  await download(pinned, tmp)
  const measured = measureFile(tmp)
  if (measured === null || measured.bytes !== pinned.bytes || measured.sha256 !== pinned.sha256) {
    rmSync(tmp, { force: true })
    fail(`${pinned.file} from ${pinned.url} is ${String(measured?.bytes)} bytes with sha256 ${String(measured?.sha256)}; the lock pins ${pinned.bytes} bytes and ${pinned.sha256} — refusing (the package changed at its address: read vendor/bash.lock.json's msys2 block against MSYS2's package database again)`)
  }
  renameSync(tmp, pinned.path)
  console.log(`fetch-bash-win: ok ${pinned.file}  ${pinned.bytes} bytes  sha256 ${pinned.sha256}  (downloaded, verified)`)
}

async function download(pinned: PinnedFile, tmp: string): Promise<void> {
  let fault = ''
  for (let attempt = 1; attempt <= DOWNLOAD_TRIES; attempt++) {
    try {
      const response = await fetch(pinned.url, { signal: AbortSignal.timeout(DOWNLOAD_LIMIT_MS) })
      if (response.ok) {
        await Bun.write(tmp, response)
        return
      }
      fault = `HTTP ${response.status} ${response.statusText}`
    } catch (error) {
      fault = error instanceof Error ? error.message : String(error)
    }
    rmSync(tmp, { force: true })
    if (attempt < DOWNLOAD_TRIES) console.log(`fetch-bash-win: ${pinned.file} did not arrive (${fault}); try ${attempt + 1} of ${DOWNLOAD_TRIES}`)
  }
  fail(`download failed for ${pinned.file} after ${DOWNLOAD_TRIES} tries: ${fault}`)
}

async function main(): Promise<void> {
  if (!existsSync(LOCK_PATH)) fail(`lock file missing: ${LOCK_PATH}`)
  let lock: BashWinLock
  try {
    lock = readBashWinLock(LOCK_PATH)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  const platforms = selectPlatforms(lock)
  const packDirFor = (platform: string): string => join(PACK_ROOT, platform)

  if (checkOnly) {
    let stale = 0
    for (const platform of platforms) {
      const fault = bashWinPackFault(packDirFor(platform), lock, platform)
      if (fault === null) console.log(`fetch-bash-win --check: OK — ${BASH_PACK_NAME} ${lock.msys2.bashVersion} ${platform} pack valid against the lock`)
      else {
        stale++
        console.error(`fetch-bash-win --check: STALE — ${platform}: ${fault}`)
      }
    }
    if (stale > 0) {
      console.error('  remedy: bun run scripts/vendor/fetch-bash-win.ts --all (downloads the pinned MSYS2 packages, verifies each size and sha256, lays the pack out)')
      process.exit(2)
    }
    process.exit(0)
  }

  const wanted = platforms.filter(platform => {
    if (force) return true
    const fault = bashWinPackFault(packDirFor(platform), lock, platform)
    if (fault === null) console.log(`fetch-bash-win: pack already valid for ${BASH_PACK_NAME} ${lock.msys2.bashVersion} ${platform} — nothing to do (--force lays it out again)`)
    else if (existsSync(packDirFor(platform))) console.log(`fetch-bash-win: laying ${platform} out again — ${fault}`)
    return fault !== null
  })
  if (wanted.length === 0 && !withSources) return

  const pinned = pinnedBashWinFiles(lock, CACHE_DIR, withSources ? 'all' : 'needed')
  for (const file of pinned) await secure(file)
  const binaries = lock.msys2.packages.length
  console.log(`fetch-bash-win: every checksum verified — ${binaries} binary packages, ${pinned.length - binaries} source package${pinned.length - binaries === 1 ? '' : 's'}`)

  for (const platform of wanted) {
    const dir = packDirFor(platform)
    const tmp = `${dir}.tmp-${process.pid}`
    try {
      const laid = layBashWinPack({ lock, platform, cacheDir: CACHE_DIR, destDir: tmp })
      rmSync(dir, { recursive: true, force: true })
      renameSync(tmp, dir)
      const post = bashWinPackFault(dir, lock, platform)
      if (post !== null) fail(`post-install validation failed for ${platform}: ${post}`)
      console.log(
        `fetch-bash-win: DONE — ${BASH_PACK_NAME} ${laid.manifest.bashVersion} ${platform} ready for the build (${laid.files} files beside the record, ${laid.bytes} bytes, ${laid.programs.length} program names in ${laid.manifest.programsDir}, tree digest ${laid.manifest.treeDigest}; bun run build.ts --target ${platform.replace('win-', 'windows-')})`,
      )
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true })
      if (error instanceof BashWinPackRefused) fail(`the ${platform} pack is refused:\n  ${error.faults.join('\n  ')}`)
      throw error
    }
  }
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)))
