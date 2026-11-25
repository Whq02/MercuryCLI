import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { UpdateCeilings } from './archiveListing.js'
import { passedOver } from '../errors/passedOver.js'
import { isEscapingRelativePath } from '../host-os/paths.js'

function linkOnDiskLands(link: string): string {
  try {
    return realpathSync(link)
  } catch (error) {
    passedOver(error)
    return resolve(dirname(link), readlinkSync(link))
  }
}

export function unpackedFolderRefusal(root: string, ceilings: UpdateCeilings): string | null {
  const home = realpathSync(root)
  const tally = { entries: 0, bytes: 0 }
  const folders = [home]
  for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
    for (const name of readdirSync(folder)) {
      const full = join(folder, name)
      const stat = lstatSync(full)
      const told = JSON.stringify(relative(home, full)).slice(0, 120)
      tally.entries++
      if (tally.entries > ceilings.entries) return `the unpacker wrote more than ${ceilings.entries} entries, the most a release may hold`
      if (stat.isDirectory()) folders.push(full)
      else if (stat.isSymbolicLink()) {
        const away = relative(home, linkOnDiskLands(full))
        if (isAbsolute(away) || isEscapingRelativePath(away)) return `the unpacker left a link that leaves the folder it unpacked into: ${told}`
      } else if (!stat.isFile()) return `the unpacker left a device, a FIFO or a socket: ${told}`
      else {
        tally.bytes += stat.size
        if (tally.bytes > ceilings.unpackedBytes) return `the unpacker wrote more than ${ceilings.unpackedBytes} bytes, the most a release may hold`
      }
    }
  }
  return null
}
