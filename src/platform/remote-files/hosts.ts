import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse } from 'node:path'
import picomatch from 'picomatch'
import { authorityText, parseRemotePath } from '../remote-file-target/target.js'
import { passedOver } from '../errors/passedOver.js'
import { hostEnv } from '../environment/hostEnv.js'

const INCLUDE_DEPTH = 16

export function sshUserConfigPath(): string {
  return join(homedir(), '.ssh', 'config')
}

function sshSystemConfigPath(): string {
  return process.platform === 'win32' ? join(hostEnv().PROGRAMDATA ?? 'C:\\ProgramData', 'ssh', 'ssh_config') : '/etc/ssh/ssh_config'
}

function wordsOf(text: string): string[] {
  const words: string[] = []
  let at = 0
  while (at < text.length) {
    while (at < text.length && /\s/.test(text[at]!)) at++
    if (at >= text.length || text[at] === '#') break
    let word = ''
    while (at < text.length && !/\s/.test(text[at]!)) {
      if (text[at] !== '"') {
        word += text[at]
        at++
        continue
      }
      const close = text.indexOf('"', at + 1)
      word += text.slice(at + 1, close === -1 ? text.length : close)
      at = close === -1 ? text.length : close + 1
    }
    words.push(word)
  }
  return words
}

function isHostName(name: string): boolean {
  if (name === '' || name.startsWith('!') || /[*?]/.test(name)) return false
  try {
    return parseRemotePath(`ssh://${authorityText({ host: name })}/`)?.authority.host === name
  } catch (error) {
    passedOver(error)
    return false
  }
}

function isAbsentPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function unreadWords(path: string, error: unknown): string {
  return `${path} (${error instanceof Error ? error.message : String(error)})`
}

function includedFiles(pattern: string, base: string, unread: string[]): string[] {
  const home = pattern === '~' || pattern.startsWith('~/') || pattern.startsWith('~\\') ? join(homedir(), pattern.slice(1)) : pattern
  const whole = isAbsolute(home) ? home : join(base, home)
  if (!/[*?[]/.test(whole)) return [whole]
  const root = parse(whole).root
  let found = [root]
  for (const segment of whole.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    if (!/[*?[]/.test(segment)) {
      found = found.map(folder => join(folder, segment))
      continue
    }
    const matches = picomatch(segment, { dot: false })
    const next: string[] = []
    for (const folder of found) {
      let names: string[]
      try {
        names = readdirSync(folder)
      } catch (error) {
        passedOver(error)
        if (!isAbsentPathError(error)) unread.push(unreadWords(folder, error))
        continue
      }
      for (const name of names.sort()) if (matches(name)) next.push(join(folder, name))
    }
    found = next
  }
  return found
}

export function remoteHostNames(mayRead: (file: string) => boolean, unread: string[] = []): string[] {
  const names = new Set<string>()
  const opened = new Set<string>()
  const walk = (file: string, base: string, depth: number): void => {
    if (depth > INCLUDE_DEPTH || opened.has(file)) return
    opened.add(file)
    if (!mayRead(file)) return
    let text: string
    try {
      if (!statSync(file).isFile()) return
      text = readFileSync(file, 'utf8')
    } catch (error) {
      passedOver(error)
      if (!isAbsentPathError(error)) unread.push(unreadWords(file, error))
      return
    }
    for (const line of text.split(/\r?\n/)) {
      const row = /^\s*([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/.exec(line)
      if (row === null) continue
      const keyword = row[1]!.toLowerCase()
      if (keyword === 'host') {
        for (const name of wordsOf(row[2]!)) if (isHostName(name)) names.add(name)
      } else if (keyword === 'include') {
        for (const pattern of wordsOf(row[2]!)) for (const included of includedFiles(pattern, base, unread)) walk(included, base, depth + 1)
      }
    }
  }
  const user = sshUserConfigPath()
  walk(user, dirname(user), 0)
  const system = sshSystemConfigPath()
  walk(system, dirname(system), 0)
  return [...names]
}

export function renderRemoteHosts(names: readonly string[], unread: readonly string[] = []): { content: string; numLines: number } {
  const lines = [
    `(target: ssh hosts · owner: Read · ${names.length} from the ssh configuration)`,
    ...names.map(name => `ssh://${authorityText({ host: name })}/`),
    ...unread.map(words => `Not read, so its hosts are not listed: ${words} — make it readable to list them.`),
    'Any destination ssh accepts is a path too: ssh://user@host:port/absolute/path.',
  ]
  return { content: lines.join('\n'), numLines: lines.length }
}
