
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

export function writeToStdout(data: string): void {
  if (process.stdout.destroyed) return
  process.stdout.write(data)
}

export function writeToStderr(data: string): void {
  if (process.stderr.destroyed) return
  process.stderr.write(data)
}

function writeFlushed(stream: NodeJS.WriteStream, data: string): Promise<void> {
  return new Promise<void>(resolve => {
    if (stream.destroyed) {
      resolve()
      return
    }
    try {
      stream.write(data, () => resolve())
    } catch {
      resolve()
    }
  })
}

export function writeToStdoutFlushed(data: string): Promise<void> {
  return writeFlushed(process.stdout, data)
}

export function writeToStderrFlushed(data: string): Promise<void> {
  return writeFlushed(process.stderr, data)
}

export function exitWithError(message: string): never {
  console.error(message)
  process.exit(1)
}

export function peekForStdinData(stream: NodeJS.ReadStream, ms: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
    }
    const onData = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
    const onEnd = (): void => {
      cleanup()
      resolve(false)
    }
    timer = setTimeout(() => {
      cleanup()
      resolve(true)
    }, ms)
    stream.on('data', onData)
    stream.on('end', onEnd)
  })
}
