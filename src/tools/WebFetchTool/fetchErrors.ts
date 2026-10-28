export class EgressBlockedError extends Error {
  public readonly domain: string
  constructor(domain: string) {
    super(JSON.stringify({ error_type: 'EGRESS_BLOCKED', domain, message: `Access to ${domain} is blocked by the network egress proxy.` }))
    this.name = 'EgressBlockedError'
    this.domain = domain
  }
}
export class FetchRefusedError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
    this.name = 'FetchRefusedError'
  }
}
export function networkFailureClass(error: unknown): string {
  let current = error
  const codes: string[] = []
  const names: string[] = []
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const e = current as { code?: unknown; name?: unknown; cause?: unknown }
    if (typeof e.code === 'string') codes.push(e.code)
    if (typeof e.name === 'string') names.push(e.name)
    current = e.cause
  }
  const code = codes.find(value => /^(?:E|UND_|CERT_|ERR_|DEPTH_|UNABLE_)/.test(value)) ?? names[0] ?? 'unknown'
  const all = [...codes, ...names].join(' ')
  const kind = /ENOTFOUND|EAI_AGAIN/.test(all) ? 'DNS failure'
    : /ECONNRESET|EPIPE|UND_ERR_SOCKET/.test(all) ? 'connection reset'
    : /TIMEOUT|ETIMEDOUT|ECONNABORTED|TimeoutError/.test(all) ? 'timeout'
    : /CERT|TLS|SSL|DEPTH_|UNABLE_TO_VERIFY|SELF_SIGNED/.test(all) ? 'TLS failure'
    : /ECONNREFUSED/.test(all) ? 'connection refused'
    : 'network failure'
  return `${kind} (${code})`
}
