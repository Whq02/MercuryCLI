import { appendFileSync, writeFileSync } from 'node:fs'

export type PtyRecord = { direction: 'input' | 'output'; atMs: number; bytes: Buffer }
export type PtyRecording = {
  records: PtyRecord[]
  exited: Promise<number>
  send: (bytes: string | Uint8Array) => number
  close: () => Promise<void>
}

export const sharedClockMs = (): number => performance.timeOrigin + performance.now()

export function recordPty(options: {
  argv: string[]
  cwd: string
  env: Record<string, string | undefined>
  cols: number
  rows: number
  path: string
}): PtyRecording {
  if (process.platform === 'win32') throw new Error('the byte recorder needs a POSIX pty')
  const records: PtyRecord[] = []
  writeFileSync(options.path, '')
  const record = (direction: PtyRecord['direction'], bytes: Uint8Array, atMs = sharedClockMs()): number => {
    const row = { direction, atMs, bytes: Buffer.from(bytes) }
    records.push(row)
    const header = Buffer.alloc(13)
    header[0] = direction === 'input' ? 73 : 79
    header.writeDoubleLE(row.atMs, 1)
    header.writeUInt32LE(row.bytes.length, 9)
    appendFileSync(options.path, Buffer.concat([header, row.bytes]))
    return row.atMs
  }
  const child = Bun.spawn(options.argv, {
    cwd: options.cwd,
    env: options.env,
    terminal: {
      cols: options.cols,
      rows: options.rows,
      data(_terminal: unknown, bytes: Uint8Array) { record('output', bytes) },
    },
  })
  let ended = false
  const exited = child.exited.then(code => { ended = true; return code })
  return {
    records,
    exited,
    send(bytes) {
      if (ended) throw new Error('the pty child exited before the input was delivered')
      const buffer = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes)
      const at = sharedClockMs()
      child.terminal!.write(buffer)
      record('input', buffer, at)
      return at
    },
    async close() {
      if (!ended) child.kill('SIGTERM')
      await exited
      child.terminal!.close()
    },
  }
}

export function decodePtyRecording(raw: Buffer): PtyRecord[] {
  const records: PtyRecord[] = []
  let offset = 0
  while (offset < raw.length) {
    if (offset + 13 > raw.length) throw new Error('truncated recorder header')
    const tag = raw[offset]
    const length = raw.readUInt32LE(offset + 9)
    if (tag !== 73 && tag !== 79) throw new Error('unknown recorder direction')
    if (offset + 13 + length > raw.length) throw new Error('truncated recorder payload')
    records.push({ direction: tag === 73 ? 'input' : 'output', atMs: raw.readDoubleLE(offset + 1), bytes: Buffer.from(raw.subarray(offset + 13, offset + 13 + length)) })
    offset += 13 + length
  }
  return records
}

export function outputBursts(records: readonly PtyRecord[], gapMs = 4): PtyRecord[][] {
  const bursts: PtyRecord[][] = []
  for (const row of records) {
    if (row.direction !== 'output') continue
    const prior = bursts.at(-1)
    if (prior && row.atMs - prior.at(-1)!.atMs <= gapMs) prior.push(row)
    else bursts.push([row])
  }
  return bursts
}
