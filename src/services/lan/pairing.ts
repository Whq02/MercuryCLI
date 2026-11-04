import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { announcerMachineName, startAnnouncer, type AnnouncerHandle, type AnnouncerIo, type Announcement } from './announcer.js'

const PAIRING_CODE_LENGTH = 6
const PAIRING_CODE_TTL_MS = 10 * 60_000
const PAIRING_ATTEMPTS = 3

function mintPairingCode(): string {
  let code = ''
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += String(randomInt(0, 10))
  return code
}

interface PairingOffer {
  model: string
  enginePort: number
  window?: number
  version?: string
  chip?: string
  key?: string
  name?: string
}

interface PairingServer {
  name: string
  code: string
  port: number
  announcer: AnnouncerHandle | undefined
  expiresAt: number
  stop(): Promise<void>
}

interface PairingReply {
  baseUrl: string
  model: string
  key?: string
  window?: number
  version?: string
  chip?: string
  name: string
}

export const PAIRING_WORDS = {
  shown: (code: string, name: string): string => `pairing code ${code} · another Mac on your network lists ${name} under TENSORFOLD HOST and asks for it once · plain HTTP on your home or office network, not across the internet`,
  wrong: 'that pairing code is not the one shown on the serving Mac',
  spent: 'that pairing code was used or has expired · the serving Mac shows a new one',
}

function codesMatch(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function startPairingServer(offer: PairingOffer, io: AnnouncerIo & { listenHost?: string; port?: number; now?: () => number; code?: string; announce?: boolean } = {}): Promise<PairingServer> {
  const name = offer.name ?? announcerMachineName()
  const code = io.code ?? mintPairingCode()
  const now = io.now ?? Date.now
  const expiresAt = now() + PAIRING_CODE_TTL_MS
  let attempts = 0
  let spent = false
  const server: Server = createServer((req, res) => {
    const answer = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/offer') {
      answer(200, { name, model: offer.model, ...(offer.window !== undefined ? { window: offer.window } : {}), ...(offer.version !== undefined ? { version: offer.version } : {}), ...(offer.chip !== undefined ? { chip: offer.chip } : {}), keyed: offer.key !== undefined })
      return
    }
    if (req.method !== 'POST' || req.url !== '/pair') {
      answer(404, { error: 'unknown path' })
      return
    }
    let raw = ''
    req.on('data', chunk => {
      raw += String(chunk)
      if (raw.length > 4096) req.destroy()
    })
    req.on('end', () => {
      let asked = ''
      try {
        asked = String((JSON.parse(raw || '{}') as { code?: unknown }).code ?? '')
      } catch {
        asked = ''
      }
      if (spent || now() > expiresAt || attempts >= PAIRING_ATTEMPTS) {
        answer(410, { error: PAIRING_WORDS.spent })
        return
      }
      attempts += 1
      if (!codesMatch(asked, code)) {
        answer(403, { error: PAIRING_WORDS.wrong, attemptsLeft: PAIRING_ATTEMPTS - attempts })
        return
      }
      spent = true
      const reply: Omit<PairingReply, 'baseUrl'> & { enginePort: number } = {
        name,
        model: offer.model,
        enginePort: offer.enginePort,
        ...(offer.key !== undefined ? { key: offer.key } : {}),
        ...(offer.window !== undefined ? { window: offer.window } : {}),
        ...(offer.version !== undefined ? { version: offer.version } : {}),
        ...(offer.chip !== undefined ? { chip: offer.chip } : {}),
      }
      answer(200, reply)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(io.port ?? 0, io.listenHost ?? '0.0.0.0', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      const announcement: Announcement = {
        name,
        port,
        txt: {
          model: offer.model,
          engine: offer.enginePort,
          pair: port,
          keyed: offer.key !== undefined ? '1' : '0',
          ...(offer.window !== undefined ? { window: offer.window } : {}),
          ...(offer.version !== undefined ? { version: offer.version } : {}),
          ...(offer.chip !== undefined ? { chip: offer.chip } : {}),
        },
      }
      const announcer = io.announce === false ? undefined : startAnnouncer(announcement, io)
      resolve({
        name,
        code,
        port,
        announcer,
        expiresAt,
        stop: () =>
          new Promise<void>(done => {
            announcer?.stop()
            server.close(() => done())
          }),
      })
    })
  })
}

export async function pairWithHost(target: { host: string; pairPort: number; code: string }, io: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<{ ok: true; reply: PairingReply } | { ok: false; reason: string }> {
  const fetchImpl = io.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), io.timeoutMs ?? 5000)
  try {
    const response = await fetchImpl(`http://${target.host}:${target.pairPort}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: target.code }),
      signal: controller.signal,
    })
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok) return { ok: false, reason: typeof body.error === 'string' ? body.error : `the serving Mac answered ${response.status}` }
    const enginePort = Number(body.enginePort)
    if (!Number.isInteger(enginePort) || enginePort <= 0 || typeof body.model !== 'string') return { ok: false, reason: 'the serving Mac answered without its server' }
    return {
      ok: true,
      reply: {
        baseUrl: `http://${target.host}:${enginePort}`,
        model: body.model,
        name: typeof body.name === 'string' ? body.name : target.host,
        ...(typeof body.key === 'string' ? { key: body.key } : {}),
        ...(typeof body.window === 'number' ? { window: body.window } : {}),
        ...(typeof body.version === 'string' ? { version: body.version } : {}),
        ...(typeof body.chip === 'string' ? { chip: body.chip } : {}),
      },
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.name === 'AbortError' ? 'the serving Mac did not answer in time' : 'the serving Mac could not be reached' }
  } finally {
    clearTimeout(timer)
  }
}

export function mintTensorFoldKey(): string {
  return randomBytes(24).toString('hex')
}
