import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { FetchRefusedError } from './fetchErrors.js'

const PRIVATE_NAME_SUFFIXES = /(?:^|\.)(?:localhost|local|internal|intranet|private|corp|home|lan|test|example|invalid|onion|arpa|localdomain)$/

export function isPrivateReaderHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return host === '' || !host.includes('.') || isIP(host) !== 0 || PRIVATE_NAME_SUFFIXES.test(host)
}

export const PRIVATE_ADDRESS_RULE = 'A private address is never sent to the hosted reader'

const metadataAddresses = new BlockList()
metadataAddresses.addSubnet('169.254.0.0', 16, 'ipv4')
metadataAddresses.addAddress('100.100.100.200', 'ipv4')
metadataAddresses.addAddress('fd00:ec2::254', 'ipv6')

function metadataHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'metadata.google.internal' || host === 'metadata.goog') return true
  const family = isIP(host)
  return family !== 0 && metadataAddresses.check(host, family === 6 ? 'ipv6' : 'ipv4')
}

export async function metadataSafeAddresses(url: string, resolver = lookup): Promise<LookupAddress[]> {
  const parsed = new URL(url)
  const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (metadataHost(host)) throw new FetchRefusedError(403, 'Cloud metadata destination ' + host + ' is refused in every permission mode.')
  const family = isIP(host)
  let addresses: LookupAddress[]
  try { addresses = family === 0 ? await resolver(host, { all: true }) : [{ address: host, family }] }
  catch { throw new FetchRefusedError(403, 'DNS lookup for ' + host + ' failed; the destination could not be checked for cloud metadata, so no request was sent.') }
  if (addresses.length === 0 || addresses.some(row => !isIP(row.address) || metadataHost(row.address))) {
    throw new FetchRefusedError(403, 'Cloud metadata destination for ' + host + ' is refused in every permission mode.')
  }
  return addresses
}

export function metadataRefusal(url: string): string | null {
  try {
    const host = new URL(url).hostname
    return metadataHost(host) ? 'Cloud metadata destination ' + host + ' is refused in every permission mode.' : null
  } catch { return null }
}
