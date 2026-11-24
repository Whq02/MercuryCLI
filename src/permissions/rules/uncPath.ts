import { getPlatform } from '../../platform/environment/platform.js'

type UncPathRisk = { risky: false } | { risky: true; host: string; form: string }

export type QuotedScript = { start: number; end: number }

type Marked = { text: string; escapes: boolean[] }

function escapesOf(input: string, scripts: readonly QuotedScript[]): boolean[] {
  const escapes = new Array<boolean>(input.length).fill(false)
  for (const { start, end } of scripts) {
    for (let at = start; at < end - 1; at++) {
      if (input[at] !== '\\' || input[at - 1] === '\\' || input[at + 1] === '\\') continue
      escapes[at] = true
      if (input[at + 1] === '/') escapes[at + 1] = true
    }
  }
  return escapes
}

function rewritten(from: Marked, pattern: RegExp, replacement: (match: RegExpExecArray) => string): Marked {
  const escapes: boolean[] = []
  let text = ''
  let last = 0
  for (const match of from.text.matchAll(pattern)) {
    text += from.text.slice(last, match.index)
    escapes.push(...from.escapes.slice(last, match.index))
    const written = replacement(match)
    let cursor = 0
    for (let at = 0; at < written.length; at++) {
      const found = match[0].indexOf(written.charAt(at), cursor)
      escapes.push(found !== -1 && from.escapes[match.index + found] === true)
      if (found !== -1) cursor = found + 1
    }
    text += written
    last = match.index + match[0].length
  }
  return { text: text + from.text.slice(last), escapes: [...escapes, ...from.escapes.slice(last)] }
}

export function uncPathRisk(input: string, opts: { command?: boolean; quotedScripts?: readonly QuotedScript[] } = {}): UncPathRisk {
  if (getPlatform() !== 'windows') return { risky: false }
  const decoded = rewritten({ text: input, escapes: escapesOf(input, opts.quotedScripts ?? []) }, /%(?:2f|5c|3a|40|7c)/gi, code => String.fromCharCode(parseInt(code[0].slice(1), 16)))
  const unquoted = rewritten(decoded, /[`'"]/g, () => '')
  const marked = rewritten(unquoted, /(^|[\s=(,;])((?:file:[\\/]{2,}[A-Za-z][:|]|[A-Za-z]:)[^\s|&;<>]*)/gi, match => {
    const lead = match[1] ?? ''
    const token = match[2] ?? ''
    const prefix = /^file:[\\/]{2,}/i.exec(token)?.[0] ?? ''
    return lead + prefix + token.slice(prefix.length).replace(/[\\/]{2,}/g, run => run[0]!)
  })
  const spelling = marked.text
  const text = spelling.replace(/\\/g, '/')
  const namespace = /\/{1,2}(?:\?\?|[?.])\/(?:UNC\/|GLOBALROOT\/Device\/(?:Mup|LanmanRedirector)\/)([^\s/]+)/ig
  const extended = namespace.exec(text)
  if (extended) return { risky: true, host: extended[1]!, form: 'namespace-unc' }
  const paths = /(?:\b(?:file|smb):)?\/{2,}([^\s/]+)/ig
  for (const match of text.matchAll(paths)) {
    const host = match[1]!
    if (host === '?' || host === '.' || host === '??') continue
    if (/^file:/i.test(match[0]) && /^[A-Za-z][:|]$/.test(host)) continue
    const before = text.slice(0, match.index)
    if (before.endsWith(':') && spelling[match.index] === '/' && spelling[match.index + 1] === '/') continue
    if (opts.command === true && !text.slice(match.index + match[0].length).startsWith('/') && !/[.:[\]]/.test(host)) continue
    const run = match.index + (/^(?:file|smb):/i.exec(match[0])?.[0].length ?? 0)
    if (marked.escapes.slice(run, match.index + match[0].length - host.length).filter(escape => !escape).length < 2) continue
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
