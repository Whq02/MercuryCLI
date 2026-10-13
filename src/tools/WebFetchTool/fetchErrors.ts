export class EgressBlockedError extends Error {
  public readonly domain: string
  constructor(domain: string) {
    super(JSON.stringify({ error_type: 'EGRESS_BLOCKED', domain, message: `Access to ${domain} is blocked by the network egress proxy.` }))
    this.name = 'EgressBlockedError'
    this.domain = domain
  }
}
