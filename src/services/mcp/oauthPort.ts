/**
 * Loopback OAuth redirect-port selection and redirect-URI construction.
 *
 * Per RFC 8252 §7.3 loopback redirect URIs match on path regardless of port,
 * which is what makes a random port usable. Extracted into its own module
 * specifically to break an import cycle with the MCP auth module.
 */
import { createServer } from 'node:http'

/** The fixed fallback port tried after random selection exhausts. */
const FALLBACK_PORT = 3118

/**
 * The platform port range, resolved ONCE at module load. Windows reserves the
 * IANA dynamic range for its own dynamic allocation, so a lower band is used
 * there.
 */
const PORT_RANGE: { min: number; max: number } =
  process.platform === 'win32' ? { min: 39152, max: 49151 } : { min: 49152, max: 65535 }

const MAX_RANDOM_ATTEMPTS = 100

/** The loopback redirect URI; defaults to the fallback port. */
export function buildRedirectUri(port: number = FALLBACK_PORT): string {
  return `http://localhost:${port}/callback`
}

/** Probe a candidate port by actually binding a throwaway server. */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer()
    server.once('error', () => {
      resolve(false)
    })
    // Loopback like the server this probes for: an unspecified bind both
    // exposes a momentary listener on every interface and mis-answers for
    // ports busy on non-loopback interfaces only.
    server.listen(port, '127.0.0.1', () => {
      server.close(() => {
        resolve(true)
      })
    })
    server.unref()
  })
}

/**
 * Choose a callback port: the `MCP_OAUTH_CALLBACK_PORT` override when it
 * parses to a positive base-10 number; otherwise uniformly-random candidates
 * from the platform range (each validated by a real bind), then the fixed
 * fallback, then failure.
 */
export async function findAvailablePort(): Promise<number> {
  const override = process.env.MCP_OAUTH_CALLBACK_PORT
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
