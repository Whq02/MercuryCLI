import { constants, copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function volumeClones(dir: string): boolean {
  const from = join(dir, `.clone-probe-${process.pid}-a`)
  const to = join(dir, `.clone-probe-${process.pid}-b`)
  try {
    writeFileSync(from, 'probe\n')
    copyFileSync(from, to, constants.COPYFILE_FICLONE_FORCE)
    return readFileSync(to, 'utf8') === 'probe\n'
  } catch {
    return false
  } finally {
    rmSync(from, { force: true })
    rmSync(to, { force: true })
  }
}

export function cloneRoadExpected(dir: string): boolean {
  return (process.platform === 'darwin' || process.platform === 'linux') && volumeClones(dir)
}
