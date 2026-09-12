const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g')

export type EngineLogErrorKind = 'script-error' | 'shader-error' | 'error'

export interface EngineLogError {
  kind: EngineLogErrorKind
  message: string
  file: string | null
  line: number | null
}

export function stripEngineAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

const ERROR_LINE_RE = /^(SCRIPT ERROR|SHADER ERROR|ERROR): (.*)$/
const AT_LINE_RE = /^\s+at:\s+(.*?)\s*\(([^()]*):(\d+)\)\s*$/

export function engineLogErrors(output: string): EngineLogError[] {
  const lines = stripEngineAnsi(output).split(/\r?\n/)
  const out: EngineLogError[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = ERROR_LINE_RE.exec(lines[i].trimEnd())
    if (!m) continue
    const kind: EngineLogErrorKind = m[1] === 'SCRIPT ERROR' ? 'script-error' : m[1] === 'SHADER ERROR' ? 'shader-error' : 'error'
    let file: string | null = null
    let line: number | null = null
    const next = lines[i + 1]
    const at = next !== undefined ? AT_LINE_RE.exec(next) : null
    if (at) {
      file = at[2].length > 0 ? at[2] : null
      line = Number(at[3])
    }
    out.push({ kind, message: m[2].trim(), file, line })
  }
  return out
}

export function engineFailLines(output: string): string[] {
  const out: string[] = []
  for (const raw of stripEngineAnsi(output).split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (/^FAIL:/i.test(line)) out.push(line)
  }
  return out
}

export function engineScriptErrorLines(output: string): string[] {
  const out: string[] = []
  for (const raw of stripEngineAnsi(output).split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (/^(SCRIPT ERROR|SHADER ERROR):/.test(line)) out.push(line)
  }
  return out
}

export function engineLogTail(output: string, chars: number): string {
  const text = stripEngineAnsi(output)
  return text.length > chars ? '…' + text.slice(-chars) : text
}
