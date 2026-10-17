import { extname } from 'node:path'

import { getLspServerManager } from '../../services/lsp/manager.js'

type ParseFormat = 'JSON' | 'YAML' | 'TOML'

function formatForPath(filePath: string): ParseFormat | undefined {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.json') return 'JSON'
  if (ext === '.yaml' || ext === '.yml') return 'YAML'
  if (ext === '.toml') return 'TOML'
  return undefined
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function parseOnce(format: ParseFormat, text: string): string | undefined {
  const body = stripBom(text)
  try {
    if (format === 'JSON') {
      JSON.parse(body)
    } else if (format === 'YAML') {
      const yaml = (Bun as unknown as { YAML?: { parse: (input: string) => unknown } }).YAML
      yaml?.parse(body)
    } else {
      Bun.TOML.parse(body)
    }
    return undefined
  } catch (err) {
    const raw =
      err instanceof Error
        ? err.message
        : typeof (err as { message?: unknown } | null)?.message === 'string'
          ? (err as { message: string }).message
          : String(err)
    const cleaned = raw
      .replace(/^(?:(?:JSON|YAML|TOML)\s+Parse error|BuildMessage):\s*/i, '')
      .trim()
    const pos = (err as { position?: { line?: number; column?: number } } | null)?.position
    if (typeof pos?.line === 'number') {
      const col = typeof pos.column === 'number' ? `, column ${pos.column}` : ''
      return `${format} parse error (line ${pos.line}${col}): ${cleaned}`
    }
    return `${format} parse error: ${cleaned}`
  }
}

function normalizeParseError(err: string): string {
  return err
    .replace(/\s*\(line \d+(?:, column \d+)?\)/gi, '')
    .replace(/\b(?:line|column|position|offset)\s+\d+/gi, '')
}

export function checkIntroducedParseError(
  filePath: string,
  beforeContent: string | null,
  afterContent: string,
  hasLspServer?: boolean,
): string | undefined {
  const format = formatForPath(filePath)
  if (format === undefined) return undefined
  const coveredByLsp =
    hasLspServer ?? ((getLspServerManager()?.getServersForFile(filePath).length ?? 0) > 0)
  if (coveredByLsp) return undefined
  const afterErr = parseOnce(format, afterContent)
  if (afterErr === undefined) return undefined
  if (beforeContent !== null) {
    const beforeErr = parseOnce(format, beforeContent)
    if (beforeErr !== undefined && normalizeParseError(beforeErr) === normalizeParseError(afterErr)) {
      return undefined
    }
  }
  return afterErr
}
