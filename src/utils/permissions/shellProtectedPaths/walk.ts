import { extractHeredocs } from '../decision/commandAnalysis.js'
import { expandPath, hasNulByte } from '../../path.js'
import { spelling } from './paths.js'
import { groups, unwrapCommand, verb } from './words.js'

export function expandShellConstants(text: string, powershell: boolean): string {
  const values = new Map<string, string>()
  const pattern = powershell
    ? /(?:^|[;\n])\s*\$([a-z_]\w*)\s*=\s*('[^']*'|"(?:[^"`]|`.)*"|[^\s;|&><"']+)/gi
    : /(?:^|[;\n]|&&|\|\|)\s*(?:export\s+|local\s+)?([a-z_]\w*)=('[^']*'|"(?:[^"\\]|\\.)*"|[^\s;|&><"']+)/gi
  for (const match of text.matchAll(pattern)) {
    const key = match[1]!.toLowerCase()
    const raw = match[2]!
    const unquoted = (raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')) ? raw.slice(1, -1) : raw
    const resolved = unquoted.replace(/\$\{?([a-z_]\w*)\}?/gi, (tok, k: string) => values.get(k.toLowerCase()) ?? tok)
    values.set(key, resolved)
  }
  if (values.size === 0) return text
  const statements = text.split(/([;\n]|&&|\|\|)/)
  const kept = statements.filter(part => {
    const trimmed = part.trim()
    return !(powershell
      ? /^\$[a-z_]\w*\s*=\s*(?:'[^']*'|"(?:[^"`]|`.)*"|[^\s;|&><"']+)\s*$/i.test(trimmed)
      : /^(?:export\s+|local\s+)?[a-z_]\w*=(?:'[^']*'|"(?:[^"\\]|\\.)*"|[^\s;|&><"']+)\s*$/i.test(trimmed))
  })
  const body = kept.join('')
  let quote = ''
  return body.replace(/`.|\\.|''|['"]|\$\{([a-z_]\w*)\}|\$([a-z_]\w*)/gi, (token, braced: string | undefined, bare: string | undefined) => {
    if (token.startsWith('`') || token.startsWith('\\') || token === "''") return token
    if (token === "'" || token === '"') {
      if (!quote) quote = token
      else if (quote === token) quote = ''
      return token
    }
    const key = (braced ?? bare)?.toLowerCase()
    const value = key && quote !== "'" ? values.get(key) : undefined
    return value === undefined ? token : value
  })
}

function expandSubcommands(commands: string[][], operandEnds?: Map<string[], number>): string[][] {
  const out: string[][] = [...commands]
  for (let i = 0; i < commands.length; i++) {
    const argv = commands[i]!
    const name = verb(argv[0] ?? '')
    if (name === 'find') {
      const execIdx = argv.findIndex((w, idx) => idx > 0 && /^-(?:exec|execdir)$/i.test(w))
      if (execIdx > 0) {
        const firstFlag = argv.findIndex((w, idx) => idx > 0 && (w.startsWith('-') || w === '!' || w === '('))
        const roots = argv.slice(1, firstFlag > 0 ? firstFlag : execIdx)
        const sub = argv.slice(execIdx + 1).filter(w => w !== ';' && w !== '\\;' && w !== '+')
        for (const r of roots.length ? roots : ['.']) {
          const expanded = unwrapCommand(sub.map(w => w === '{}' ? r : w.replace(/\{\}/g, r)))
          const end = operandEnds?.get(argv)
          if (end !== undefined) {
            const prefix = argv.slice(execIdx + 1, end).filter(w => w !== ';' && w !== '\\;' && w !== '+')
            operandEnds!.set(expanded, unwrapCommand(prefix.map(w => w === '{}' ? r : w.replace(/\{\}/g, r))).length)
          }
          out.push(expanded)
        }
      }
    } else if (name === 'xargs') {
      const args = argv.slice(1)
      let j = 0
      while (j < args.length) {
        const w = args[j]!
        if (w === '--') { j++; break }
        if (/^-[nLIsdEJP]$/.test(w)) { j += 2; continue }
        if (w.startsWith('-')) { j++; continue }
        break
      }
      const sub = args.slice(j)
      if (sub.length > 0 && i > 0) {
        const prev = commands[i - 1]!
        const prevName = verb(prev[0] ?? '')
        if (['echo', 'printf', 'write-output'].includes(prevName)) {
          const piped = prev.slice(1).filter(w => !w.startsWith('-') && !(prevName === 'printf' && w.includes('%')))
          if (piped.length > 0) {
            const expanded = unwrapCommand([...sub, ...piped])
            const end = operandEnds?.get(argv)
            if (end !== undefined) operandEnds!.set(expanded, unwrapCommand(argv.slice(1 + j, end)).length)
            out.push(expanded)
          }
        }
      }
    }
  }
  return out
}

function updateTrackedCwd(argv: string[], cwd: string): string {
  const name = verb(argv[0] ?? '')
  if (['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location'].includes(name)) {
    const target = argv.slice(1).find(word => !word.startsWith('-'))
    if (target) return hasNulByte(target) ? cwd : expandPath(spelling(target), cwd)
    if (['cd', 'chdir', 'set-location', 'sl'].includes(name) && !argv.includes('-')) return expandPath(spelling('~'), cwd)
  }
  return cwd
}

export async function walkPowerShellCommands(
  command: string,
  visitor: (state: { argv: string[]; commands: string[][]; operandEnds: ReadonlyMap<string[], number>; cwd: string; text: string; powershell: boolean }) => Promise<string | null> | string | null,
  cwd: string,
): Promise<string | null> {
  const pending = [{ text: command, cwd, powershell: true }]
  while (pending.length) {
    const current = pending.pop()!
    current.text = expandShellConstants(current.text, current.powershell)
    const extracted = extractHeredocs(current.text)
    const view = extracted.processedCommand
    let cwd = current.cwd
    const operandEnds = new Map<string[], number>()
    const rawCommands = groups(view, current.powershell, operandEnds).map(group => {
      const argv = unwrapCommand(group)
      const end = operandEnds.get(group)
      if (end !== undefined) operandEnds.set(argv, unwrapCommand(group.slice(0, end)).length)
      return argv
    })
    const commands = expandSubcommands(rawCommands, operandEnds)
    for (const argv of commands) {
      cwd = updateTrackedCwd(argv, cwd)
      const hit = await visitor({ argv, commands, operandEnds, cwd, text: current.text, powershell: current.powershell })
      if (hit !== null) return hit
      const name = verb(argv[0] ?? '')
      if (/^(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd)$/.test(name)) {
        const flag = argv.findIndex((word, i) => i > 0 && /^(?:-(?:[a-z]*c|command)|\/[ck])$/i.test(word))
        if (flag >= 0 && argv[flag + 1] && argv[flag + 1]!.length < current.text.length) {
          pending.push({ text: argv[flag + 1]!, cwd, powershell: /^(?:pwsh|powershell|cmd)$/.test(name) })
        }
        for (const [placeholder, heredoc] of extracted.heredocs) {
          if (view.includes(placeholder)) pending.push({ text: current.text.slice(heredoc.contentStartIndex, heredoc.contentEndIndex), cwd, powershell: false })
        }
      }
      if (['eval', 'iex', 'invoke-expression'].includes(name)) {
        const script = argv.slice(1).join(' ')
        if (script.length < current.text.length) pending.push({ text: script, cwd, powershell: current.powershell })
      }
    }
  }
  return null
}
