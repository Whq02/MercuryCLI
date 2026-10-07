import { getPlatform } from '../platform.js'

export type UncPathRisk = { risky: false } | { risky: true; host: string; form: string }

export function uncPathRisk(input: string): UncPathRisk {
  if (getPlatform() !== 'windows') return { risky: false }
  const decoded = input.replace(/%(?:2f|5c|3a|40)/gi, code => String.fromCharCode(parseInt(code.slice(1), 16)))
  const spelling = decoded.replace(/[`'"]/g, '')
  const text = spelling.replace(/\\/g, '/')
  const namespace = /\/{1,2}(?:\?\?|[?.])\/(?:UNC\/|GLOBALROOT\/Device\/(?:Mup|LanmanRedirector)\/)([^\s/]+)/ig
  const extended = namespace.exec(text)
  if (extended) return { risky: true, host: extended[1]!, form: 'namespace-unc' }
  const paths = /(?:\b(?:file|smb):)?\/{2,}([^\s/]+)/ig
  for (const match of text.matchAll(paths)) {
    const host = match[1]!
    if (host === '?' || host === '.' || host === '??') continue
    const before = text.slice(0, match.index)
    if (before.endsWith(':') && spelling[match.index] === '/' && spelling[match.index + 1] === '/') continue
    return { risky: true, host, form: /@|DavWWWRoot/i.test(match[0] + text.slice(match.index + match[0].length)) ? 'webdav' : 'unc' }
  }
  const marker = /([^\s/;|<>()]*)(?:@SSL@\d+|@\d+@SSL)/i.exec(text)
  if (marker) return { risky: true, host: marker[1] || '(unspecified)', form: 'webdav-marker' }
  if (/DavWWWRoot/i.test(text)) return { risky: true, host: '(unspecified)', form: 'webdav-marker' }
  return { risky: false }
}

export function uncPathMessage(input: string, risk: Extract<UncPathRisk, { risky: true }>): string {
  const host = risk.host === '(unspecified)' ? 'a remote host' : `the remote host ${risk.host}`
  return `${input} may reach ${host} over SMB/WebDAV; a UNC path can leak this machine's login — Mercury does not open it without explicit permission.`
}
