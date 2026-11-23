import { Worker } from 'node:worker_threads'

let finished = false
const die = () => { if (!finished) process.kill(process.pid, 'SIGKILL') }
process.on('disconnect', die)
process.once('message', request => {
  const input = new SharedArrayBuffer(65544)
  const control = new Int32Array(input, 0, 2)
  const data = new Uint8Array(input, 8)
  let pending = 0, ended = false, inputError = false, reply = null
  const pump = () => {
    if (pending === 0) return
    const count = Math.min(pending, process.stdin.readableLength)
    const chunk = process.stdin.read(count > 0 ? count : pending)
    if (chunk === null && !ended && !inputError) return
    if (chunk !== null) data.set(chunk)
    Atomics.store(control, 1, inputError ? -1 : chunk?.length ?? 0)
    Atomics.store(control, 0, 1)
    pending = 0
    Atomics.notify(control, 0)
  }
  process.stdin.on('readable', pump)
  process.stdin.on('end', () => { ended = true; pump() })
  process.stdin.on('error', () => { inputError = true; pump() })
  const worker = new Worker(new URL('./jsonQueryWorker.mjs', import.meta.url), { workerData: { ...request, input } })
  worker.on('message', message => {
    if (message.read !== undefined) { pending = message.read; pump() }
    else if (message.started) { if (process.connected) process.send({ started: true }) }
    else reply = message
  })
  worker.once('error', error => { reply = { error: error.message } })
  worker.once('exit', code => {
    finished = true
    const result = reply ?? { error: `The JSON query worker exited without a result (${code}).` }
    if (process.connected) process.send(result, () => process.exit(code === 0 ? 0 : 1))
    else process.exit(1)
  })
})
