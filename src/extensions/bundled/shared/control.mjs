import { createConnection } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath } from 'node:fs/promises'

const exec = promisify(execFile)
export function loopbackEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !/^127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error('Use a loopback address: 127.0.0.1:<port>')
  const port = Number(endpoint.split(':')[1])
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid control port')
  return { host: '127.0.0.1', port }
}

export async function verifyListener(endpoint, executable, { signal, expectedSha256 } = {}) {
  const { port } = loopbackEndpoint(endpoint)
  let pid, path, start
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; $p=@(Get-NetTCPConnection -State Listen -LocalPort ${port} | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -ExpandProperty OwningProcess -Unique); if($p.Count -ne 1){throw 'Expected one loopback listener'}; $x=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p[0]); @{pid=$x.ProcessId;path=$x.ExecutablePath;start=$x.CreationDate.ToString('o')}|ConvertTo-Json -Compress`
    const result = JSON.parse((await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { signal })).stdout)
    ;({ pid, path, start } = result)
  } else if (process.platform === 'darwin') {
    const listener = await exec('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { signal })
    const ids = [...new Set(listener.stdout.split('\n').filter(l => /^p\d+$/.test(l)).map(l => Number(l.slice(1))))]
    if (ids.length !== 1) throw new Error('Expected one control listener')
    pid = ids[0]
    const binary = await exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], { signal })
    const paths = binary.stdout.split('\n').filter(l => l.startsWith('n')).map(l => l.slice(1))
    const expected = await realpath(executable)
    path = paths[0]
    start = (await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { signal })).stdout.trim()
    if (!path || await realpath(path) !== expected) throw new Error('The control port belongs to a different executable. No app commands were sent.')
  } else if (process.platform === 'linux') {
    const sockets = (await exec('ss', ['-lptn', `sport = :${port}`], { signal })).stdout
    const ids = [...sockets.matchAll(/pid=(\d+)/g)].map(m => Number(m[1]))
    if (new Set(ids).size !== 1) throw new Error('Cannot identify the control listener')
    pid = ids[0]
    path = await realpath(`/proc/${pid}/exe`)
    start = (await exec('ps', ['-p', String(pid), '-o', 'lstart='], { signal })).stdout.trim()
  } else throw new Error('Application identity verification is unavailable on this platform')
  if (!pid || !path || !start) throw new Error('Application process identity is incomplete')
  const hash = async file => { const h = createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex') }
  const expectedPath = await realpath(executable), actualPath = await realpath(path)
  if (process.platform === 'win32' ? expectedPath.toLowerCase() !== actualPath.toLowerCase() : expectedPath !== actualPath) throw new Error('The running app is not the verified installation. No app commands were sent.')
  const digest = await hash(path)
  if (digest !== await hash(executable) || (expectedSha256 && digest !== expectedSha256)) throw new Error('The running executable does not match the verified release')
  return { pid, executable: actualPath, start, sha256: digest }
}

export function controlSession(endpoint, { signal, timeoutMs = 10000 } = {}) {
  const target = loopbackEndpoint(endpoint)
  const socket = createConnection(target)
  let buffer = '', closed = false
  const pending = new Map()
  const fail = error => { closed = true; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error) }; pending.clear() }
  socket.setEncoding('utf8')
  socket.on('error', fail)
  socket.on('close', () => fail(new Error('Control connection closed; outcome may be unknown. Inspect before retrying.')))
  socket.on('data', chunk => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { fail(new Error('Invalid control response')); socket.destroy(); return }
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
      if (!line.trim()) continue
      try {
        const reply = JSON.parse(line), p = pending.get(String(reply.id))
        if (!p) continue
        pending.delete(String(reply.id)); clearTimeout(p.timer)
        if (reply.ok === true) p.resolve(reply.result)
        else p.reject(new Error(typeof reply.error === 'string' ? reply.error : JSON.stringify(reply.error)))
      } catch (error) { fail(error); socket.destroy() }
    }
  })
  const cancelled = () => { fail(new Error('Control request cancelled; outcome may be unknown. Inspect before retrying.')); socket.destroy() }
  signal?.addEventListener('abort', cancelled, { once: true })
  return {
    request(method, params = {}) {
      signal?.throwIfAborted()
      if (closed) return Promise.reject(new Error('Control connection is closed'))
      const id = randomUUID()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Control request timed out; outcome may be unknown. Inspect before retrying.')); socket.destroy() }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        socket.write(JSON.stringify({ id, method, params }) + '\n')
      })
    },
    close() { signal?.removeEventListener('abort', cancelled); socket.destroy() },
  }
}
