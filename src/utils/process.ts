
const STREAM_GONE_CODES = new Set(['EPIPE', 'EIO', 'ENXIO', 'EBADF'])

const PEER_GONE_WRITE_CODES = new Set([
  ...STREAM_GONE_CODES,
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
])

export function isPeerGoneWriteError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && PEER_GONE_WRITE_CODES.has(code)
}

function handleStreamGoneErrors(stream: NodeJS.WriteStream | NodeJS.ReadStream, onGone?: (code: string) => void): void {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    const code = err?.code
    if (!code || !STREAM_GONE_CODES.has(code)) throw err
    try {
      stream.destroy()
    } catch {
    }
    onGone?.(code)
  })
}

export function registerProcessOutputErrorHandlers(): void {
  handleStreamGoneErrors(process.stdout)
  handleStreamGoneErrors(process.stderr)
}

export function registerProcessInputErrorHandler(onGone: (code: string) => void): void {
  handleStreamGoneErrors(process.stdin, onGone)
}

export function writeToStderr(data: string): void {
  if (process.stderr.destroyed) return
  process.stderr.write(data)
}


export function exitWithError(message: string): never {
  console.error(message)
  process.exit(1)
}
