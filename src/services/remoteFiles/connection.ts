import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { remotePrelude } from './prelude.js'
import { authorityText, noteResolvedAuthority, remoteAuthorityFault, RemotePathError, resolvedAuthority, type RemoteAuthority, type RemoteAuthorityFacts } from './target.js'

const SHELLS = ['sh', 'bash', 'zsh']
const CONNECT_DEADLINE_MS = 30_000
const QUIET_DEADLINE_MS = 60_000
const BEATS_A_QUIET_TIME = 4
const BEAT = /\u0007/g
const RESOLVE_DEADLINE_MS = 10_000
const RESOLVE_FRESH_MS = 2_000
const NOISE_KEPT = 1024 * 1024
const WORDS_KEPT = 16 * 1024
const PAYLOAD_SLICE = 1024 * 1024

type RemoteFailure = 'ssh' | 'shell' | 'lost' | 'timeout'

export class RemoteConnectionError extends Error {
  readonly failure: RemoteFailure
  readonly answered: boolean
  constructor(failure: RemoteFailure, message: string, answered = false) {
    super(message)
    this.name = 'RemoteConnectionError'
    this.failure = failure
    this.answered = answered
  }
}

type RemoteReply = { stdout: Buffer; stderr: string; status: number }

type RemoteRequest = {
  script: string | ((ack: string) => string)
  payload?: Uint8Array
  signal?: AbortSignal
  quietMs?: number
  sink?: (chunk: Buffer) => void
}

function sshOptions(): string[] {
  return ['-T', '-x', '-oBatchMode=yes', '-oForwardAgent=no', '-oPermitLocalCommand=no', '-oClearAllForwardings=yes', '-oRemoteCommand=none', '-oControlMaster=no']
}

function sshDestination(authority: RemoteAuthority): string[] {
  return [
    ...(authority.user === undefined ? [] : ['-l', authority.user]),
    ...(authority.port === undefined ? [] : [`-oPort=${authority.port}`]),
    '--',
    authority.host,
  ]
}

function sshEnv(): NodeJS.ProcessEnv {
  return subprocessEnv({ stripProviderCredentials: true })
}

function lastWords(text: string): string {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('Warning: Permanently added'))
    .slice(-3)
    .join(' ')
}

function interrupted(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason
  const error = new Error('The remote request was interrupted.')
  error.name = 'AbortError'
  return error
}

function sshMissing(): RemoteConnectionError {
  return new RemoteConnectionError('ssh', 'ssh was not found on this machine; a path that begins ssh:// needs the OpenSSH client.')
}

let openings = 0

class Connection {
  opening = 0
  private child: ChildProcess | null = null
  private token = ''
  private queue: Promise<void> = Promise.resolve()
  private onStdout: ((chunk: Buffer) => void) | null = null
  private onStderr: ((chunk: Buffer) => void) | null = null
  private onClosed: ((words: string) => void) | null = null
  private idleWords = ''
  private beatMs = 0
  private asked = 0
  private refused: { error: RemoteConnectionError; through: number } | null = null

  constructor(private readonly authority: RemoteAuthority) {}

  private get host(): string {
    return authorityText(this.authority)
  }

  run(request: RemoteRequest): Promise<RemoteReply> {
    const order = ++this.asked
    const next = this.queue.then(() => this.attempt(request, order))
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  close(): void {
    const child = this.child
    this.child = null
    if (child === null) return
    try {
      child.stdin?.end()
      child.kill()
    } catch {
    }
  }

  private async attempt(request: RemoteRequest, order: number): Promise<RemoteReply> {
    if (request.signal?.aborted) throw interrupted(request.signal)
    if (this.child === null) {
      if (this.refused !== null && order <= this.refused.through) throw this.refused.error
      try {
        await this.open(request)
      } catch (error) {
        if (error instanceof RemoteConnectionError) this.refused = { error, through: this.asked }
        throw error
      }
    }
    try {
      return await this.exchange(request)
    } catch (error) {
      const retry = error instanceof RemoteConnectionError && error.failure === 'lost' && !error.answered && request.payload === undefined
      if (!retry || request.signal?.aborted) throw error
      await this.open(request)
      return this.exchange(request)
    }
  }

  private async open(request: RemoteRequest): Promise<void> {
    const beatSeconds = Math.max(1, Math.floor((request.quietMs ?? QUIET_DEADLINE_MS) / (BEATS_A_QUIET_TIME * 1000)))
    let refused: unknown
    for (const shell of SHELLS) {
      try {
        await this.start(shell, request.signal, beatSeconds)
        return
      } catch (error) {
        if (!(error instanceof RemoteConnectionError) || error.failure !== 'shell') throw error
        refused ??= error
      }
    }
    throw refused
  }

  private start(shell: string, signal: AbortSignal | undefined, beatSeconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const token = randomBytes(16).toString('hex')
      const ready = Buffer.from(`${randomBytes(16).toString('hex')}\n`)
      const child = spawn('ssh', [...sshOptions(), ...sshDestination(this.authority), shell], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: sshEnv(),
      })
      let out: Buffer = Buffer.alloc(0)
      let err: Buffer = Buffer.alloc(0)
      let settled = false
      const settle = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        signal?.removeEventListener('abort', abort)
        if (error === undefined) {
          this.child = child
          this.token = token
          this.beatMs = beatSeconds * 1000
          this.idleWords = ''
          this.opening = ++openings
          resolve()
          return
        }
        try {
          child.kill()
        } catch {
        }
        reject(error)
      }
      const abort = (): void => settle(interrupted(signal))
      const deadline = setTimeout(
        () => settle(new RemoteConnectionError('timeout', `${this.host} did not answer within ${CONNECT_DEADLINE_MS / 1000} seconds.`)),
        CONNECT_DEADLINE_MS,
      )
      signal?.addEventListener('abort', abort, { once: true })
      const arrived = (): void => {
        if (out.indexOf(ready) === -1 || err.indexOf(ready) === -1) return
        settle()
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) {
          if (this.child === child) this.onStdout?.(chunk)
          return
        }
        out = Buffer.concat([out, chunk]).subarray(-NOISE_KEPT)
        arrived()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        if (settled) {
          if (this.child !== child) return
          if (this.onStderr !== null) this.onStderr(chunk)
          else this.idleWords = (this.idleWords + chunk.toString('utf8').replace(BEAT, '')).slice(-WORDS_KEPT)
          return
        }
        err = Buffer.concat([err, chunk]).subarray(-NOISE_KEPT)
        arrived()
      })
      child.stdin?.on('error', () => {})
      child.on('error', error => {
        settle((error as NodeJS.ErrnoException).code === 'ENOENT' ? sshMissing() : new RemoteConnectionError('ssh', `ssh could not start: ${error.message}`))
      })
      child.on('close', code => {
        if (!settled) {
          const words = lastWords(err.toString('utf8'))
          if (code === 255 || code === null) settle(new RemoteConnectionError('ssh', `ssh could not reach ${this.host}: ${words === '' ? 'it gave no reason.' : words}`))
          else settle(new RemoteConnectionError('shell', `${this.host} has no POSIX shell that answers${words === '' ? '' : ` (${words})`}; a path that begins ssh:// needs sh, bash or zsh on the remote machine.`))
          return
        }
        if (this.child !== child) return
        this.child = null
        this.onClosed?.(lastWords(this.idleWords))
      })
      child.stdin?.write(remotePrelude(token, ready.toString('latin1').trimEnd(), beatSeconds))
    })
  }

  private exchange(request: RemoteRequest): Promise<RemoteReply> {
    return new Promise((resolve, reject) => {
      const child = this.child
      if (child === null || child.stdin === null) {
        reject(new RemoteConnectionError('lost', `The connection to ${this.host} was lost.`))
        return
      }
      const marker = randomBytes(16).toString('hex')
      const ack = randomBytes(16).toString('hex')
      const head = Buffer.from(`\n${marker} `)
      const ackLine = Buffer.from(`${ack}\n`)
      const errEnd = `${marker}\n`
      const quietMs = Math.max(this.beatMs * BEATS_A_QUIET_TIME, request.quietMs ?? QUIET_DEADLINE_MS)
      const parts: Buffer[] = []
      let held: Buffer = Buffer.alloc(0)
      let status: number | null = null
      let errText = ''
      let errDone = false
      let answered = false
      let awaitingAck = request.payload !== undefined
      let settled = false
      let quiet: ReturnType<typeof setTimeout> | undefined
      const release = (): void => {
        settled = true
        clearTimeout(quiet)
        request.signal?.removeEventListener('abort', abort)
        this.onStdout = null
        this.onStderr = null
        this.onClosed = null
      }
      const fail = (error: Error, drop: boolean): void => {
        if (settled) return
        release()
        if (drop) this.close()
        reject(error)
      }
      const done = (): void => {
        if (settled || status === null || !errDone) return
        release()
        resolve({ stdout: request.sink === undefined ? Buffer.concat(parts) : Buffer.alloc(0), stderr: errText, status })
      }
      const abort = (): void => fail(interrupted(request.signal), true)
      const touch = (): void => {
        clearTimeout(quiet)
        quiet = setTimeout(() => fail(new RemoteConnectionError('timeout', `${this.host} did not answer for ${Math.round(quietMs / 1000)} seconds.`, answered), true), quietMs)
      }
      const send = (payload: Uint8Array, from: number): void => {
        if (settled || from >= payload.length) return
        const until = Math.min(payload.length, from + PAYLOAD_SLICE)
        child.stdin?.write(payload.subarray(from, until), () => {
          if (settled) return
          touch()
          send(payload, until)
        })
      }
      const emit = (bytes: Buffer): void => {
        if (bytes.length === 0) return
        if (request.sink === undefined) parts.push(bytes)
        else request.sink(bytes)
      }
      this.onStdout = chunk => {
        touch()
        answered = true
        let joined = held.length === 0 ? chunk : Buffer.concat([held, chunk])
        if (status !== null) {
          fail(new RemoteConnectionError('lost', `The connection to ${this.host} went out of step and was closed.`, true), true)
          return
        }
        if (awaitingAck) {
          if (joined.length < ackLine.length && ackLine.subarray(0, joined.length).equals(joined)) {
            held = joined
            return
          }
          awaitingAck = false
          if (joined.length >= ackLine.length && joined.subarray(0, ackLine.length).equals(ackLine)) {
            joined = joined.subarray(ackLine.length)
            send(request.payload!, 0)
          }
        }
        const at = joined.indexOf(head)
        if (at === -1) {
          const keep = Math.min(joined.length, head.length - 1)
          emit(joined.subarray(0, joined.length - keep))
          held = Buffer.from(joined.subarray(joined.length - keep))
          return
        }
        emit(joined.subarray(0, at))
        const lineEnd = joined.indexOf(0x0a, at + head.length)
        if (lineEnd === -1) {
          held = Buffer.from(joined.subarray(at))
          return
        }
        status = Number(joined.subarray(at + head.length, lineEnd).toString('latin1'))
        held = Buffer.alloc(0)
        if (lineEnd + 1 < joined.length || !Number.isInteger(status)) {
          fail(new RemoteConnectionError('lost', `The connection to ${this.host} went out of step and was closed.`, true), true)
          return
        }
        done()
      }
      this.onStderr = chunk => {
        touch()
        if (errDone) return
        errText += chunk.toString('utf8').replace(BEAT, '')
        const at = errText.indexOf(errEnd)
        if (at === -1) {
          if (errText.length > 2 * WORDS_KEPT) errText = errText.slice(-WORDS_KEPT)
          return
        }
        errText = errText.slice(0, at)
        errDone = true
        done()
      }
      this.onClosed = words => {
        const said = lastWords(`${errText}\n${words}`)
        fail(new RemoteConnectionError('lost', `The connection to ${this.host} was lost${said === '' ? '.' : `: ${said}`}`, answered), false)
      }
      request.signal?.addEventListener('abort', abort, { once: true })
      touch()
      const script = typeof request.script === 'string' ? request.script : request.script(ack)
      const line = request.payload === undefined ? `{ ${script}; } </dev/null` : script
      child.stdin.write(`${this.token} ${line}; m_end ${marker}\n`)
    })
  }
}

const connections = new Map<string, Connection>()

export function remoteRun(authority: RemoteAuthority, request: RemoteRequest): Promise<RemoteReply> {
  const fault = remoteAuthorityFault(authority)
  if (fault !== null) return Promise.reject(new RemotePathError(fault))
  const key = authorityText(authority)
  let connection = connections.get(key)
  if (connection === undefined) {
    connection = new Connection(authority)
    connections.set(key, connection)
  }
  return connection.run(request)
}

export function remoteOpening(authority: RemoteAuthority): number {
  return connections.get(authorityText(authority))?.opening ?? 0
}

export function closeRemoteConnections(): number {
  const open = connections.size
  for (const connection of connections.values()) connection.close()
  connections.clear()
  return open
}

registerCleanup(async () => {
  closeRemoteConnections()
})
process.once('exit', () => {
  closeRemoteConnections()
})

function configured(authority: RemoteAuthority, signal: AbortSignal | undefined): Promise<RemoteAuthorityFacts | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-G', ...sshDestination(authority)], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: sshEnv() })
    let text = ''
    let settled = false
    const settle = (outcome: RemoteAuthorityFacts | null | Error): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      signal?.removeEventListener('abort', abort)
      if (outcome instanceof Error) reject(outcome)
      else resolve(outcome)
    }
    const abort = (): void => {
      child.kill()
      settle(interrupted(signal))
    }
    const deadline = setTimeout(() => {
      child.kill()
      settle(null)
    }, RESOLVE_DEADLINE_MS)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => {
      if (text.length < NOISE_KEPT) text += chunk.toString('utf8')
    })
    child.on('error', error => settle((error as NodeJS.ErrnoException).code === 'ENOENT' ? sshMissing() : null))
    child.on('close', code => {
      const value = (name: string): string | undefined => new RegExp(`^${name} (.+)$`, 'm').exec(text)?.[1]?.trim()
      const hostname = value('hostname')
      if (code !== 0 || hostname === undefined) {
        settle(null)
        return
      }
      const port = Number(value('port'))
      const user = value('user')
      settle({ hostname, ...(user === undefined ? {} : { user }), ...(Number.isInteger(port) && port > 0 ? { port } : {}) })
    })
  })
}

const resolving = new Map<string, Promise<void>>()
const resolvedAt = new Map<string, number>()

export function resolveRemoteAuthority(authority: RemoteAuthority, signal?: AbortSignal): Promise<void> {
  const fault = remoteAuthorityFault(authority)
  if (fault !== null) return Promise.reject(new RemotePathError(fault))
  const key = authorityText(authority)
  if (resolvedAuthority(authority) !== undefined && Date.now() - (resolvedAt.get(key) ?? 0) < RESOLVE_FRESH_MS) return Promise.resolve()
  let pending = resolving.get(key)
  if (pending === undefined) {
    pending = configured(authority, signal)
      .then(facts => {
        if (facts === null) return
        noteResolvedAuthority(authority, facts)
        resolvedAt.set(key, Date.now())
      })
      .finally(() => resolving.delete(key))
    resolving.set(key, pending)
  }
  return pending
}
