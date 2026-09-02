/**
 * Process stdio hardening: tolerating streams whose counterparty is absent,
 * flushed final writes, a fatal-exit helper, and a stdin data peek.
 */

/** Each covers one way a standard stream dies without the process being at fault. */
const STREAM_GONE_CODES = new Set(['EPIPE', 'EIO', 'ENXIO', 'EBADF'])

/**
 * On one of the stream-gone codes, best-effort destroy the stream and invoke
 * the callback with the errno. Any other error keeps propagating — genuine
 * faults must still surface.
 */
function handleStreamGoneErrors(stream: NodeJS.WriteStream | NodeJS.ReadStream, onGone?: (code: string) => void): void {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    const code = err?.code
    if (!code || !STREAM_GONE_CODES.has(code)) throw err
    try {
      stream.destroy()
    } catch {
      // Destroying must never itself throw out of the handler.
    }
    onGone?.(code)
  })
}

/** The minimum so a piped, early-terminated consumer cannot crash the process. */
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

/**
 * Resolves only after the chunk drained to the OS — the final headless bytes
 * must reach the consumer before a synchronous exit discards the process
 * buffer (a slow pipe reader, worst on Windows). Never rejects, and never a
 * blocking descriptor write (EAGAIN / partial writes on non-blocking pipes).
 */
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

/**
 * "Is there a real producer on the other end of stdin?" — true on timeout,
 * false on stream end. The FIRST data chunk cancels the timeout but does not
 * resolve: after data is seen the peek waits for end unconditionally (the
 * caller is accumulating and needs every chunk).
 */
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
