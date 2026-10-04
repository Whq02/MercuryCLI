
const STREAM_GONE_CODES = new Set(['EPIPE', 'EIO', 'ENXIO', 'EBADF'])

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
