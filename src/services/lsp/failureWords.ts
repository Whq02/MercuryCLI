import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

import type { LSPServerInstance } from './LSPServerInstance.js'

const LANGUAGE_LABELS: Record<string, string> = {
  typescript: 'TypeScript',
  typescriptreact: 'TypeScript',
  javascript: 'JavaScript',
  javascriptreact: 'JavaScript',
  python: 'Python',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  gdscript: 'GDScript',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  json: 'JSON',
  jsonc: 'JSON',
  yaml: 'YAML',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  kotlin: 'Kotlin',
  swift: 'Swift',
  ruby: 'Ruby',
  php: 'PHP',
  lua: 'Lua',
  shellscript: 'shell',
  markdown: 'Markdown',
  terraform: 'Terraform',
  dockerfile: 'Dockerfile',
  elixir: 'Elixir',
  vue: 'Vue',
  svelte: 'Svelte',
  astro: 'Astro',
  zig: 'Zig',
}

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

export function languageLabel(id: string | undefined): string {
  if (id === undefined || id === '') return 'this'
  return LANGUAGE_LABELS[id] ?? id
}

export function serverLanguage(server: Pick<LSPServerInstance, 'config'>, path: string): string {
  const ext = extname(path).toLowerCase()
  const map = server.config.extensionToLanguage as Record<string, string>
  for (const [key, language] of Object.entries(map)) {
    if (key.toLowerCase() === ext) return languageLabel(language)
  }
  const first = Object.values(map)[0]
  return languageLabel(first)
}

export function serverTitle(server: Pick<LSPServerInstance, 'name' | 'config'>, path: string): string {
  return `the ${serverLanguage(server, path)} language server (${server.name})`
}

export function typecheckCommand(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    const script = pkg.scripts ?? {}
    const name = ['typecheck', 'type-check', 'check-types', 'tsc'].find(candidate => typeof script[candidate] === 'string')
    if (name !== undefined) {
      const runner = existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb')) ? 'bun run' : 'npm run'
      return `${runner} ${name}`
    }
  } catch {
    return 'npx tsc --noEmit'
  }
  return 'npx tsc --noEmit'
}

export function secondsOf(ms: number): string {
  const seconds = ms / 1000
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`
}

function mentionsMissingTypescript(message: string): boolean {
  return /typescript/i.test(message) && /no resolvable|not found|cannot find|does not exist|missing/i.test(message)
}

export function startFailureCause(serverName: string, error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).trim()
  const timeout = /did not initialize within (\d+)ms/.exec(raw)
  if (timeout) return `did not start within ${secondsOf(Number(timeout[1]))}`
  const repeated = /did not start \((\d+) attempts? this session\): (.*)$/s.exec(raw)
  if (repeated) return repeated[2]!.trim()
  const stripped = raw.replace(new RegExp(`^LSP server ${serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `), '')
  return stripped.replace(/^failed to start:?\s*/i, '').replace(/^crashed/, 'exited').trim()
}

export function remedyForLanguageServer(server: Pick<LSPServerInstance, 'name' | 'config'>, path: string, cause: string, cwd: string): string {
  const language = serverLanguage(server, path)
  if (language === 'TypeScript' || language === 'JavaScript') {
    const typecheck = typecheckCommand(cwd)
    if (mentionsMissingTypescript(cause)) {
      return `install typescript in the project (npm install -D typescript), or check the files with ${typecheck}`
    }
    return `check the files with ${typecheck}; serverStatus shows the server's state`
  }
  return `check the files with the project's own ${language} tooling; serverStatus shows the server's state`
}

export function unclaimedCause(extension: string, cwd: string): { cause: string; remedy: string } {
  if (TS_EXTENSIONS.has(extension)) {
    const typecheck = typecheckCommand(cwd)
    try {
      const { probeBuiltinTsServer } = require('./builtinServers.js') as typeof import('./builtinServers.js')
      const probe = probeBuiltinTsServer()
      if (probe.available) {
        return {
          cause: 'the TypeScript language server was not configured when this session started (typescript resolves now)',
          remedy: `start a new session to use it, or check the files with ${typecheck}`,
        }
      }
      return {
        cause: probe.reason ?? `no typescript found from ${cwd} and none beside the bundle`,
        remedy: `install typescript in the project (npm install -D typescript), or check the files with ${typecheck}`,
      }
    } catch {
      return {
        cause: `no typescript found from ${cwd} and none beside the bundle`,
        remedy: `install typescript in the project (npm install -D typescript), or check the files with ${typecheck}`,
      }
    }
  }
  return { cause: `no language server in this session claims '${extension}' files`, remedy: '' }
}

export function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
