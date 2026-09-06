import { createServer } from 'node:http'
import { flagEnv } from '../../substrate/flagRegistry.js'

const FALLBACK_PORT = 3118

const PORT_RANGE: { min: number; max: number } =
  process.platform === 'win32' ? { min: 39152, max: 49151 } : { min: 49152, max: 65535 }

const MAX_RANDOM_ATTEMPTS = 100

export function buildRedirectUri(port: number = FALLBACK_PORT): string {
  return `http://localhost:${port}/callback`
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer()
    server.once('error', () => {
      resolve(false)
    })
    server.listen(port, '127.0.0.1', () => {
      server.close(() => {
        resolve(true)
      })
    })
    server.unref()
  })
}

export async function findAvailablePort(): Promise<number> {
  const override = flagEnv('MERCURY_MCP_OAUTH_CALLBACK_PORT')
  if (override !== undefined) {
    const parsed = parseInt(override, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  const rangeSize = PORT_RANGE.max - PORT_RANGE.min + 1
  const attempts = Math.min(MAX_RANDOM_ATTEMPTS, rangeSize)
  for (let attempt = 0; attempt < attempts; attempt++) {
    const candidate = PORT_RANGE.min + Math.floor(Math.random() * rangeSize)
    if (await isPortAvailable(candidate)) return candidate
  }
  if (await isPortAvailable(FALLBACK_PORT)) return FALLBACK_PORT
  throw new Error('No available ports found for OAuth redirect')
}
