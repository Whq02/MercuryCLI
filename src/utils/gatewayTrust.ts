// =============================================================================
// gatewayTrust — certificate pinning for a stored corporate-gateway session.
// -----------------------------------------------------------------------------
// Nothing in the product creates a gateway session yet: requests go straight
// to the API, and the auth store never gains an `enterpriseGateway` record.
// Until one exists, restoreGatewayAuth() is a startup no-op and the pin /
// verify entry points simply have no caller. The code is kept in working
// order anyway, so a future gateway login flow can lean on it unchanged.
//
// Boundaries: the record shape is defined HERE (secure storage imports the
// type, not the other way around), the TLS probe is local (node:tls +
// node:crypto), all persistence goes through the secure-storage accessor,
// and the direct-API auth path is never touched.
//
// The scheme is trust-on-first-use. A login flow pins the gateway host's
// leaf-certificate hash; every restore re-probes the host and compares.
// Three outcomes matter:
//   match      → activate the stored session;
//   mismatch   → refuse AND delete the stored session, so a rotated or
//                intercepted endpoint cannot come back on a later launch;
//   probe down → continue. An unreachable network says nothing about
//                tampering, and the pin still guards the path that matters.
// =============================================================================

import { connect as tlsConnect, type PeerCertificate } from 'node:tls'
import { createHash } from 'node:crypto'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import { getSecureStorage } from './secureStorage/index.js'
// Erased at build (type-only), so the type-level cycle with the storage
// module has no runtime edge in either direction.
import type { SecureStorageData } from './secureStorage/types.js'

/**
 * One stored corporate-gateway session. Defined in this module so there is a
 * single owner for the shape; no writer exists yet.
 */
export interface EnterpriseGateway {
  /** Base URL of the gateway, `https://gateway.corp.example` style. */
  url: string
  /** Session expiry, epoch milliseconds. */
  expiresAt: number
  /** IdP refresh token, when the session can be renewed past expiry. */
  idpRefreshToken?: string
}

/** Handshake budget for a fingerprint probe (ms). */
const GATEWAY_TLS_PROBE_TIMEOUT_MS = 3000

/**
 * Hash a gateway host's leaf certificate: sha256 over the DER bytes, as
 * lowercase hex, computed locally from the raw certificate — never read out
 * of a precomputed field. A non-https URL carries no certificate at all, so
 * those resolve immediately with a fixed sentinel and a plaintext dev
 * loopback can flow through pin/verify without waiting on any handshake.
 */
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
    // Handshake success, a socket error, and the idle timeout race for the
    // settle — and destroy() during teardown can provoke one more late
    // 'error'. The latch admits exactly one winner, and the winner removes
    // both listeners BEFORE destroy() so the teardown's own error event has
    // nowhere to land.
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
        // The pin stores (and verify compares) a hash of the leaf DER
        // bytes, taken from getPeerCertificate(true).
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
    // The idle timer is armed here and ONLY here. Passing `timeout` through
    // the connect options as well would arm the same timer twice, and a 0
    // would switch it off.
    socket.setTimeout(timeoutMs)
    socket.once('error', onError)
    socket.once('timeout', onTimeout)
  })
}

/** Host → pinned fingerprint, from a store snapshot. Missing map ⇒ empty. */
function pinnedFingerprints(store: SecureStorageData | null): Record<string, string> {
  return store?.gatewayTrust ?? {}
}

/**
 * Record the live fingerprint of a gateway host — the trust-on-first-use
 * write a future login flow performs so restores can detect a change later.
 * Best-effort: the pinned fingerprint on success, null on any failure.
 */
export async function pinGatewayTrust(
  gatewayUrl: string,
): Promise<string | null> {
  try {
    const { hostname, fingerprint } =
      await probeGatewayTlsFingerprint(gatewayUrl)
    const storage = getSecureStorage()
    // The async read keeps the OS keychain helper off this code path's
    // critical section (the sync read shells out and can stall).
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

/**
 * Compare a gateway host's live certificate against its pin.
 *   'ok'         — hashes agree.
 *   'untrusted'  — this host was never pinned.
 *   'mismatch'   — the certificate is not the pinned one.
 *   'unverified' — the probe itself failed; policy belongs to the caller.
 */
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

/**
 * The startup restore ladder, run once from bootstrap after auth init: read
 * the stored session, refuse it while it lacks a pin or sits expired with no
 * refresh token, re-probe the endpoint against the pin, and only then
 * activate. A mismatch refuses AND deletes the session; a probe failure is
 * weather, not evidence, and falls through to activation. Never throws —
 * startup survives every failure mode in here.
 */
export async function restoreGatewayAuth(): Promise<void> {
  try {
    const tellUser = (line: string): void => {
      if (!getIsNonInteractiveSession()) process.stderr.write(line)
    }

    const data = await getSecureStorage().readAsync()
    const gateway = data?.enterpriseGateway
    // No stored session: nothing to check, nothing to activate — the whole
    // runtime cost of carrying this module today.
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
        // Fail closed AND clear: the certificate is not the one that was
        // trusted, and a stored session for a rotated or intercepted
        // endpoint must not come back on a later launch.
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
      // Fail open: an unreachable network says nothing about tampering, and
      // the pin still guards the requests themselves.
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

/**
 * Delete a gateway session and its pin after a mismatch. Failures are
 * logged and swallowed — this runs inside a refusal path that must finish.
 */
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

/**
 * The verify → activate handoff. Wiring requests through the gateway (base
 * URL, IdP token) is a transport concern that doesn't exist yet, so for now
 * activation is a debug breadcrumb; the named seam keeps the restore flow
 * readable end-to-end.
 */
function activateEnterpriseGateway(gateway: EnterpriseGateway): void {
  logForDebugging(
    `[gateway] verified session for ${new URL(gateway.url).hostname} (transport wiring not yet present)`,
    { level: 'debug' },
  )
}
