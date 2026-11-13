import { closeSync, constants, fstatSync, openSync, readFileSync, statSync, type Stats } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'

type NotAFile = 'a named pipe' | 'a socket' | 'a device'

export function notAFileKind(st: Stats): NotAFile | null {
  if (st.isFile() || st.isDirectory()) return null
  return st.isFIFO() ? 'a named pipe' : st.isSocket() ? 'a socket' : 'a device'
}

export function notAFileRefusal(displayPath: string, kind: NotAFile): string {
  return `Reading ${displayPath} is not allowed: it is ${kind}, not a file or a folder, and reading it could hang or never end; use a shell command with a timeout or a byte limit instead.`
}

export class NotARegularFileError extends Error {
  constructor(path: string, kind: NotAFile) {
    super(notAFileRefusal(path, kind))
    this.name = 'NotARegularFileError'
  }
}

const READ_WITHOUT_BLOCKING = constants.O_RDONLY | constants.O_NONBLOCK

function refuseWhatIsNotAFile(path: string, st: Stats): void {
  const kind = notAFileKind(st)
  if (kind !== null) throw new NotARegularFileError(path, kind)
}

export function openRegularFileSync(path: string, early: Stats = statSync(path)): { fd: number; stats: Stats } {
  refuseWhatIsNotAFile(path, early)
  const fd = openSync(path, READ_WITHOUT_BLOCKING)
  try {
    const stats = fstatSync(fd)
    refuseWhatIsNotAFile(path, stats)
    return { fd, stats }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

export async function openRegularFile(path: string, early?: Stats): Promise<{ handle: FileHandle; stats: Stats }> {
  refuseWhatIsNotAFile(path, early ?? (await stat(path)))
  const handle = await open(path, READ_WITHOUT_BLOCKING)
  try {
    const stats = await handle.stat()
    refuseWhatIsNotAFile(path, stats)
    return { handle, stats }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

export function readRegularFileSync(path: string, early?: Stats): Buffer {
  const { fd } = openRegularFileSync(path, early)
  try {
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

export async function readRegularFile(path: string, signal?: AbortSignal, early?: Stats): Promise<Buffer> {
  const { handle } = await openRegularFile(path, early)
  try {
    return await handle.readFile(signal ? { signal } : {})
  } finally {
    await handle.close().catch(() => undefined)
  }
}
