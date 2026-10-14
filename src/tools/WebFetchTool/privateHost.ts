import { isIP } from 'node:net'

const PRIVATE_NAME_SUFFIXES = /(?:^|\.)(?:localhost|local|internal|intranet|private|corp|home|lan|test|example|invalid|onion|arpa|localdomain)$/

export function isPrivateReaderHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return host === '' || !host.includes('.') || isIP(host) !== 0 || PRIVATE_NAME_SUFFIXES.test(host)
}

export const PRIVATE_ADDRESS_RULE = 'A private address is never sent to the hosted reader'
