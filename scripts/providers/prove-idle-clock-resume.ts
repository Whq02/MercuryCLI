import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import net from 'node:net'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.2' }
const { createStreamIdleWatchdog } = await import('../../src/services/providers/streamIdleBudget.ts')
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
if (process.argv[2] === '--child') {
  const socket = net.connect(Number(process.argv[3]), '127.0.0.1')
  await new Promise<void>(resolve => socket.once('connect', resolve))
  const watchdog = createStreamIdleWatchdog({ timeoutMs: 1500 })
  watchdog.noteActivity()
  socket.on('data', () => {
    const fired = watchdog.fired()
    watchdog.noteActivity()
    watchdog.stop()
    socket.destroy()
    console.log(JSON.stringify({ fired }))
    process.exit(fired === null ? 0 : 1)
  })
  console.log('READY')
  setTimeout(() => process.exit(2), 8000)
} else {
  const clock = Date.now
  let skew = 0
  Date.now = () => clock() + skew
  const watchdog = createStreamIdleWatchdog({ timeoutMs: 500 })
  try {
    await delay(200)
    watchdog.noteActivity()
    skew = 600000
    await delay(350)
    assert.equal(watchdog.fired(), null, 'wall-clock jumps do not consume idle time')
  } finally { Date.now = clock; watchdog.stop() }
  const stalled = createStreamIdleWatchdog({ timeoutMs: 100 })
  await delay(150)
  assert(stalled.fired() !== null, 'real silence still expires')
  stalled.stop()
  if (process.platform !== 'win32') {
    let client: net.Socket | undefined
    const server = net.createServer(socket => { client = socket })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const child = Bun.spawn([process.execPath, 'run', import.meta.filename, '--child', String((server.address() as net.AddressInfo).port)], { stdout: 'pipe', stderr: 'inherit' })
    let output = ''
    let ready!: () => void
    const readyPromise = new Promise<void>(resolve => { ready = resolve })
    const reading = (async () => { for await (const bytes of child.stdout) { output += Buffer.from(bytes).toString(); if (output.includes('READY')) ready() } })()
    try {
      await readyPromise
      process.kill(child.pid, 'SIGSTOP')
      await delay(1000)
      client!.write('x')
      await delay(1000)
      process.kill(child.pid, 'SIGCONT')
      const exit = await child.exited
      await reading
      assert.equal(exit, 0, output)
    } finally {
      if (child.exitCode === null) { process.kill(child.pid, 'SIGCONT'); child.kill() }
      client?.destroy()
      server.close()
    }
  }
  console.log('P03 monotonic idle deadlines survive clock changes and consume buffered bytes after suspension')
}
