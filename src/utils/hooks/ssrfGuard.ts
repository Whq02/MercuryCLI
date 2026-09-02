import * as dns from 'node:dns'
import * as net from 'node:net'

/**
 * DNS-resolution guard for HTTP hooks: blocks private, link-local, and
 * other non-routable targets so a project-configured hook cannot reach
 * cloud metadata endpoints or internal infrastructure. Loopback is
 * deliberately allowed — local policy servers are a primary use case.
 *
 * Installed as the HTTP client's resolver option so the address validated
 * is the address the socket connects to, closing any rebinding window
 * between validation and connection.
 */

/** Contract data: callers match on this code. */
const BLOCKED_ADDRESS_CODE = 'ERR_HTTP_HOOK_BLOCKED_ADDRESS'

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = parseInt(part, 10)
    if (value > 255) return null
    octets.push(value)
  }
  return octets
}

// Blocked ranges (contract data): 0.0.0.0/8, 10/8, 100.64/10 (shared
// address space / carrier-grade NAT — used by at least one cloud provider's
// metadata endpoint), 169.254/16 (link-local, cloud metadata), 172.16/12,
// 192.168/16. 127/8 is allowed. A malformed quad is not blocked — the guard
// only ever sees validated resolver output.
function isBlockedIpv4(address: string): boolean {
  const octets = parseIpv4(address)
  if (!octets) return false
  const [a, b] = octets as [number, number, number, number]
  if (a === 0) return true
  if (a === 10) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

/**
 * Expand an IPv6 string to its eight 16-bit groups, or null when malformed.
 * Handles the compressed form (one `::`), hex groups, and a trailing
 * dotted-decimal quad (converted into the last two groups). Full expansion
 * is the point: a prefix-string check on `::ffff:` misses hex-form mapped
 * addresses entirely, which is a real bypass, not a theoretical one.
 */
function expandIpv6(address: string): number[] | null {
  let head = address
  let tailQuad: number[] | null = null
  const lastColon = address.lastIndexOf(':')
  if (lastColon !== -1 && address.slice(lastColon + 1).includes('.')) {
    tailQuad = parseIpv4(address.slice(lastColon + 1))
    if (!tailQuad) return null
    head = address.slice(0, lastColon + 1) + 'x' // placeholder consumed below
  }

  const tailGroups: number[] = tailQuad
    ? [((tailQuad[0]! << 8) | tailQuad[1]!) >>> 0, ((tailQuad[2]! << 8) | tailQuad[3]!) >>> 0]
    : []

  const doubles = head.split('::')
  if (doubles.length > 2) return null

  const parseGroups = (segment: string): number[] | null => {
    if (segment === '') return []
    const groups: number[] = []
    for (const raw of segment.split(':')) {
      if (raw === 'x') continue // the dotted-quad placeholder
      if (!/^[0-9a-fA-F]{1,4}$/.test(raw)) return null
      groups.push(parseInt(raw, 16))
    }
    return groups
  }

  const left = parseGroups(doubles[0]!)
  if (left === null) return null
  const right = doubles.length === 2 ? parseGroups(doubles[1]!) : null
  if (doubles.length === 2 && right === null) return null

  const rightGroups = [...(right ?? []), ...tailGroups]
  if (doubles.length === 2) {
    const missing = 8 - left.length - rightGroups.length
    if (missing < 1) return null
    return [...left, ...new Array<number>(missing).fill(0), ...rightGroups]
  }
  const full = [...left, ...tailGroups]
  return full.length === 8 ? full : null
}

function isBlockedIpv6(address: string): boolean {
  const groups = expandIpv6(address)
  if (!groups) return false
  const allZero = groups.every(g => g === 0)
  // The unspecified address is blocked; ::1 (loopback) is allowed.
  if (allZero) return true
  const first = groups[0]!
  // fc00::/7 — unique local.
  if ((first & 0xfe00) === 0xfc00) return true
  // fe80::/10 — link-local, checked across the whole fe80–febf band.
  if ((first & 0xffc0) === 0xfe80) return true
  // fec0::/10 — the deprecated site-local band is internal by definition
  // (FC-147): deprecation retired the PREFIX, not the networks still
  // answering on it.
  if ((first & 0xffc0) === 0xfec0) return true
  const embeddedV4 = (hi: number, lo: number): string =>
    `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  // An IPv4-mapped address (::ffff:a.b.c.d in ANY spelling) inherits the
  // embedded IPv4's verdict.
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    return isBlockedIpv4(embeddedV4(groups[6]!, groups[7]!))
  }
  // The OTHER v4-carrying spellings (FC-147 — the module's own header
  // argues a narrow check "is a real bypass, not a theoretical one"):
  // ::a.b.c.d (the deprecated IPv4-COMPATIBLE form node still parses).
  // groups[6] must be non-zero so ::1 keeps its DOCUMENTED loopback allow
  // (::0.0.x.x forms carry no routable target).
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0 && groups[6] !== 0) {
    return isBlockedIpv4(embeddedV4(groups[6]!, groups[7]!))
  }
  // 2002:a.b.c.d::/48 — 6to4 embeds the IPv4 in groups 1–2,
  if (first === 0x2002) {
    return isBlockedIpv4(embeddedV4(groups[1]!, groups[2]!))
  }
  // and 64:ff9b::/96 — the NAT64 well-known prefix embeds it in 6–7.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    return isBlockedIpv4(embeddedV4(groups[6]!, groups[7]!))
  }
  return false
}

export function isBlockedAddress(address: string): boolean {
  const version = net.isIP(address)
  if (version === 4) return isBlockedIpv4(address)
  if (version === 6) return isBlockedIpv6(address)
  return false
}

type LookupOptions = { all?: boolean; family?: number | string }
type LookupAddress = { address: string; family: number }
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number,
) => void

function blockedError(hostname: string, address: string): NodeJS.ErrnoException {
  const error = new Error(
    `HTTP hook blocked: ${hostname} resolved to ${address}, a private or link-local address. ` +
      'Loopback is allowed for local development.',
  ) as NodeJS.ErrnoException & { hostname?: string; address?: string }
  error.code = BLOCKED_ADDRESS_CODE
  error.hostname = hostname
  error.address = address
  return error
}

function normalisedFamily(address: string): number {
  return net.isIP(address) === 6 ? 6 : 4
}

/**
 * The lookup handed to the HTTP client. An IP-literal hostname is validated
 * directly without DNS (clearer errors, no platform literal quirks);
 * otherwise every resolved address is checked and one bad address in a
 * multi-address answer fails the whole lookup.
 */
export function ssrfGuardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  if (net.isIP(hostname) !== 0) {
    if (isBlockedAddress(hostname)) {
      callback(blockedError(hostname, hostname))
      return
    }
    const family = normalisedFamily(hostname)
    if (options.all) callback(null, [{ address: hostname, family }])
    else callback(null, hostname, family)
    return
  }

  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) {
      callback(err)
      return
    }
    if (!addresses || addresses.length === 0) {
      const notFound = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as NodeJS.ErrnoException & {
        hostname?: string
      }
      notFound.code = 'ENOTFOUND'
      notFound.hostname = hostname
      callback(notFound)
      return
    }
    for (const entry of addresses) {
      if (isBlockedAddress(entry.address)) {
        callback(blockedError(hostname, entry.address))
        return
      }
    }
    const normalised = addresses.map(entry => ({
      address: entry.address,
      family: normalisedFamily(entry.address),
    }))
    if (options.all) callback(null, normalised)
    else callback(null, normalised[0]!.address, normalised[0]!.family)
  })
}
