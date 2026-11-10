type ReadHandle = { reading?: boolean; readStop?: () => unknown }

type ConsoleReader = { _handle?: ReadHandle | null; _readableState?: { reading?: boolean } }

export function holdConsoleRead(stdin: NodeJS.ReadStream, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false
  const reader = stdin as unknown as ConsoleReader
  const handle = reader._handle
  if (!handle || handle.reading !== true || typeof handle.readStop !== 'function') return false
  handle.reading = false
  if (reader._readableState) reader._readableState.reading = false
  handle.readStop()
  return true
}
