
import { connect as tlsConnect, type PeerCertificate } from 'node:tls'
import { createHash } from 'node:crypto'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import { getSecureStorage } from './secureStorage/index.js'
import type { SecureStorageData } from './secureStorage/types.js'

export interface EnterpriseGateway {
  url: string
  expiresAt: number
  idpRefreshToken?: string
}

const GATEWAY_TLS_PROBE_TIMEOUT_MS = 3000

export function probeGatewayTlsFingerprint(
  gatewayUrl: string,
  timeoutMs: number = GATEWAY_TLS_PROBE_TIMEOUT_MS,
): Promise<{ hostname: string; fingerprint: string }> {
  const parsed = new URL(gatewayUrl)
  const hostname = parsed.hostname

  if (parsed.protocol !== 'https:') {
    return Promise.resolve({ hostname, fingerprint: 'http-loopback' })
  }

  const port = parsed.port ? Number(parsed.port) : 443

  return new Promise((resolve, reject) => {
    let done = false
    const finish = (outcome: {
      value?: { hostname: string; fingerprint: string }
      error?: Error
    }): void => {
      if (done) return
      done = true
      socket.removeListener('error', onError)
      socket.removeListener('timeout', onTimeout)
      socket.destroy()
      if (outcome.error) reject(outcome.error)
      else resolve(outcome.value!)
    }
    const onError = (err: Error) => finish({ error: new Error(errorMessage(err)) })
    const onTimeout = () =>
      finish({ error: new Error('TLS fingerprint probe timed out') })
    const onHandshake = (): void => {
      try {
        const der = (socket.getPeerCertificate(true) as PeerCertificate)?.raw
        if (!der || der.length === 0) {
          finish({ error: new Error('could not read TLS certificate fingerprint') })
          return
        }
        finish({
          value: {
            hostname,
            fingerprint: createHash('sha256').update(der).digest('hex').toLowerCase(),
          },
        })
      } catch (err) {
        finish({ error: new Error(errorMessage(err)) })
      }
    }

    const socket = tlsConnect(
      {
        host: hostname,
        port,
        servername: hostname,
      },
      onHandshake,
    )
    socket.setTimeout(timeoutMs)
    socket.once('error', onError)
    socket.once('timeout', onTimeout)
  })
}

function pinnedFingerprints(store: SecureStorageData | null): Record<string, string> {
  return store?.gatewayTrust ?? {}
}

export async function pinGatewayTrust(
  gatewayUrl: string,
): Promise<string | null> {
  try {
    const { hostname, fingerprint } =
      await probeGatewayTlsFingerprint(gatewayUrl)
    const storage = getSecureStorage()
    const data = (await storage.readAsync()) ?? {}
    const next: SecureStorageData = {
      ...data,
      gatewayTrust: { ...pinnedFingerprints(data), [hostname]: fingerprint },
    }
    const result = storage.update(next)
    if (result.success) {
      return fingerprint
    }
    logForDebugging(`[gateway] failed to persist trust pin for ${hostname}`, {
      level: 'warn',
    })
    return null
  } catch (err) {
    logForDebugging(
      `[gateway] could not pin trust for ${gatewayUrl} (${errorMessage(err)})`,
      { level: 'warn' },
    )
    return null
  }
}

export async function verifyGatewayTrust(
  gatewayUrl: string,
): Promise<'ok' | 'untrusted' | 'mismatch' | 'unverified'> {
  const host = new URL(gatewayUrl).hostname
  const storage = getSecureStorage()
  const data = await storage.readAsync()
  const pinned = pinnedFingerprints(data)[host]
  if (!pinned) return 'untrusted'
  try {
    const probe = await probeGatewayTlsFingerprint(gatewayUrl)
    return probe.fingerprint === pinned ? 'ok' : 'mismatch'
  } catch {
    return 'unverified'
  }
}

export async function restoreGatewayAuth(): Promise<void> {
  try {
    const tellUser = (line: string): void => {
      if (!getIsNonInteractiveSession()) process.stderr.write(line)
    }

    const data = await getSecureStorage().readAsync()
    const gateway = data?.enterpriseGateway
    if (!gateway) return

    const host = new URL(gateway.url).hostname
    const pin = pinnedFingerprints(data)[host]

    if (!pin) {
      tellUser(
        `Cloud gateway ${host} is not trusted on this machine — run /logins to reconnect.\n`,
      )
      return
    }

    if (gateway.expiresAt <= Date.now() && !gateway.idpRefreshToken) {
      tellUser('Cloud gateway session expired — run /logins to reconnect.\n')
      return
    }

    try {
      const probe = await probeGatewayTlsFingerprint(gateway.url)
      if (probe.fingerprint !== pin) {
        tellUser(
          `Cloud gateway ${host} TLS certificate changed since you connected — run /logins to verify and reconnect.\n`,
        )
        logForDebugging(
          `[gateway] TLS fingerprint mismatch on restore for ${host}: pinned ${pin}, live ${probe.fingerprint}`,
          { level: 'warn' },
        )
        await clearGatewaySession(host)
        return
      }
    } catch (err) {
      logForDebugging(
        `[gateway] TLS fingerprint probe failed on restore for ${host} (${errorMessage(err)}); proceeding without re-verify`,
        { level: 'warn' },
      )
    }

    activateEnterpriseGateway(gateway)
  } catch (err) {
    logForDebugging(`[gateway] restore failed: ${errorMessage(err)}`, {
      level: 'debug',
    })
  }
}

async function clearGatewaySession(host: string): Promise<void> {
  try {
    const storage = getSecureStorage()
    const data = (await storage.readAsync()) ?? {}
    const trust = { ...pinnedFingerprints(data) }
    delete trust[host]
    const next: SecureStorageData = { ...data }
    delete next.enterpriseGateway
    if (Object.keys(trust).length) next.gatewayTrust = trust
    else delete next.gatewayTrust
    storage.update(next)
  } catch (err) {
    logForDebugging(
      `[gateway] failed to clear session for ${host} (${errorMessage(err)})`,
      { level: 'warn' },
    )
  }
}

function activateEnterpriseGateway(gateway: EnterpriseGateway): void {
  logForDebugging(
    `[gateway] verified session for ${new URL(gateway.url).hostname} (transport wiring not yet present)`,
    { level: 'debug' },
  )
}
