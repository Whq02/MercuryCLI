import { getShellCwd } from '../Shell.js'
import { getMercuryHome } from '../envUtils.js'
import { credentialStorePath, mercurySecretPath, spelling } from './protectedPaths.js'
import { pinnedCommandAnalysis, peelWrappers, PARSE_ABORTED, extractHeredocs, type Node } from './decision/commandAnalysis.js'
import { runtimeWritePath, runtimeProcessRefusal } from './runtimeProtection.js'
import { expandPath } from '../path.js'

function words(text: string, powershell: boolean): Array<string | { op?: string }> {
  const prepared = powershell ? text.replace(/`\r?\n/g, '').replace(/`([^\r\n])/g, '$1').replace(/\\/g, '\\\\') : text
  const parsed = pinnedCommandAnalysis.tryParseShellCommand(prepared, name => `$${name}`)
  return parsed.success ? parsed.tokens.flatMap<string | { op?: string }>(token => {
    if (typeof token === 'string') return [token]
    if ('op' in token && token.op === 'glob' && 'pattern' in token) return [token.pattern]
    return 'op' in token ? [token] : []
  }) : []
}

function groups(text: string, powershell: boolean): string[][] {
  const result: string[][] = []
  let group: string[] = []
  for (const word of words(text, powershell)) {
    if (typeof word === 'string') group.push(word)
    else if (word.op === '>' || word.op === '>>' || word.op === '>|' || word.op === '&>') group.push('>', '')
    else if (word.op === '<') group.push('<', '')
    else if (word.op !== undefined) {
      if (group.length) result.push(group)
      group = []
    }
  }
  if (group.length) result.push(group)
  return result
}

function verb(word: string): string {
  return word.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '')
}

function splitFusedOptions(argv: string[]): string[] {
  return argv.flatMap(word => {
    const fused = /^(-(?:literalpath|path|destination|filepath|newname)):(.+)$/i.exec(word)
    return fused ? [fused[1]!, fused[2]!] : [word]
  })
}

function unwrapCommand(argv: string[]): string[] {
  let unwrapped = splitFusedOptions(argv[0] === '&' ? argv.slice(1) : argv)
  for (;;) {
    while (['command', 'builtin', 'exec'].includes(verb(unwrapped[0] ?? ''))) {
      unwrapped = unwrapped.slice(1)
      while (unwrapped[0]?.startsWith('-')) unwrapped = unwrapped.slice(1)
    }
    const peeled = peelWrappers(unwrapped)
    if (!Array.isArray(peeled) || peeled.length === unwrapped.length) break
    unwrapped = splitFusedOptions(peeled)
  }
  return unwrapped
}

function writeOperands(argv: string[]): string[] {
  const out: string[] = []
  const command: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '>' || argv[i] === '<') {
      if (argv[i] === '>' && argv[i + 2]) out.push(argv[i + 2]!)
      i += 2
    } else command.push(argv[i]!)
  }
  const unwrapped = unwrapCommand(command)
  const name = verb(unwrapped[0] ?? '')
  const args = unwrapped.slice(1)
  if (args.some(arg => /^-whatif$/i.test(arg))) return []
  const writers = new Set([
    'tee', 'chmod', 'icacls', 'cp', 'mv', 'copy', 'move', 'copy-item', 'move-item', 'ci', 'cpi', 'mi',
    'sed', 'set-content', 'add-content', 'out-file', 'tee-object', 'ac', 'sc',
    'install', 'dd', 'rsync', 'ln', 'truncate', 'rm', 'unlink', 'rmdir', 'rd', 'ri', 'del', 'erase',
    'remove-item', 'clear-content', 'clc', 'new-item', 'ni', 'ren', 'rename', 'rename-item', 'sqlite3', 'find',
  ])
  if (!writers.has(name)) return out
  const operands = args.filter(arg => !arg.startsWith('-') && !/^\/[sq]$/i.test(arg))
  if (name === 'sed') {
    if (args.some(arg => /^-(?:[a-z]*i|-[iI]n-place)/.test(arg))) out.push(...operands.slice(1))
  } else if (name === 'dd') {
    out.push(...args.filter(arg => /^of=/i.test(arg)).map(arg => arg.slice(3)))
  } else if (name === 'sqlite3') {
    if (operands[0]) out.push(operands[0])
  } else if (name === 'find') {
    if (args.includes('-delete')) out.push(...operands)
  } else if (['cp', 'copy', 'copy-item', 'ci', 'cpi', 'rsync', 'install', 'ln'].includes(name)) {
    const target = args.findIndex(arg => arg === '-t' || arg === '--target-directory' || /^-dest(?:ination)?$/i.test(arg))
    const fused = args.find(arg => arg.startsWith('--target-directory='))?.slice('--target-directory='.length)
    const destination = fused ?? (target >= 0 ? args[target + 1] : operands.at(-1))
    if (destination) out.push(destination)
  } else if (['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item'].includes(name)) {
    const target = args.findIndex(arg => arg === '-t' || arg === '--target-directory' || /^-dest(?:ination)?$/i.test(arg))
    const fused = args.find(arg => arg.startsWith('--target-directory='))?.slice('--target-directory='.length)
    if (fused) out.push(fused)
    else if (target >= 0 && args[target + 1]) out.push(args[target + 1]!)
    out.push(...operands)
  } else out.push(...operands)
  return out
}

function readOperands(argv: string[]): string[] {
  const out: string[] = []
  const command: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '<' || argv[i] === '>') {
      if (argv[i] === '<' && argv[i + 2]) out.push(argv[i + 2]!)
      i += 2
    } else command.push(argv[i]!)
  }
  const unwrapped = unwrapCommand(command)
  const name = verb(unwrapped[0] ?? '')
  const readers = new Set(['cat', 'type', 'get-content', 'gc', 'head', 'tail', 'base64', 'xxd', 'od', 'hexdump', 'strings', 'grep', 'rg', 'cp', 'copy', 'copy-item', 'ci', 'cpi', 'mv', 'move', 'move-item', 'mi', 'rsync', 'install', 'dd', 'sqlite3'])
  if (readers.has(name)) {
    const args = unwrapped.slice(1)
    if (name === 'dd') {
      out.push(...args.filter(arg => /^if=/i.test(arg)).map(arg => arg.slice(3)))
    } else {
      const operands = args.filter(arg => !arg.startsWith('-'))
      out.push(...(['cp', 'copy', 'copy-item', 'ci', 'cpi', 'mv', 'move', 'move-item', 'mi', 'rsync', 'install'].includes(name) ? operands.slice(0, -1) : operands))
    }
  }
  return out
}

function runtimeOperands(argv: string[]): Array<{ path: string; removesTree: boolean }> {
  const unwrapped = unwrapCommand(argv)
  const name = verb(unwrapped[0] ?? '')
  const args = unwrapped.slice(1)
  if (args.some(arg => /^-whatif$/i.test(arg))) return []
  const targets = writeOperands(argv).map(path => ({ path, removesTree: false }))
  const removers = ['rm', 'unlink', 'rmdir', 'rd', 'ri', 'del', 'erase', 'remove-item', 'mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item']
  if (removers.includes(name) || (name === 'find' && args.includes('-delete'))) {
    targets.push(...args.filter(arg => !arg.startsWith('-') && !/^\/[sq]$/i.test(arg)).map(path => ({ path, removesTree: true })))
  }
  return targets
}

function expandShellConstants(text: string, powershell: boolean): string {
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

function expandSubcommands(commands: string[][]): string[][] {
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
          out.push(unwrapCommand(sub.map(w => w === '{}' ? r : w.replace(/\{\}/g, r))))
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
          if (piped.length > 0) out.push(unwrapCommand([...sub, ...piped]))
        }
      }
    }
  }
  return out
}

function normalizeInlineScript(script: string): string {
  const home = (process.env.HOME || process.env.USERPROFILE || '').replace(/\\/g, '/')
  const config = getMercuryHome().replace(/\\/g, '/')
  const exe = process.execPath.replace(/\\/g, '/')
  return script
    .replace(/\bprocess\.execPath\b/g, JSON.stringify(exe))
    .replace(/(?:os\.environ(?:\.get)?\s*[\[(]\s*(['"])MERCURY_CONFIG_DIR\1\s*[\])]|process\.env\.MERCURY_CONFIG_DIR)\s*\+\s*(['"])([^'"\r\n]+)\2/g, (_m, _q1, q2, rest) => `${q2}${config}${rest}${q2}`)
    .replace(/(?:os\.environ(?:\.get)?\s*[\[(]\s*(['"])(?:HOME|USERPROFILE)\1\s*[\])]|os\.path\.expanduser\s*\(\s*(['"])~\2\s*\)|(?:os\.)?homedir\s*\(\s*\)|process\.env\.(?:HOME|USERPROFILE))\s*\+\s*(['"])([^'"\r\n]+)\3/g, (_m, _q1, _q2, q3, rest) => `${q3}${home}${rest}${q3}`)
}

function inlineScriptWrites(rawScript: string): string[] {
  const script = normalizeInlineScript(rawScript)
  const out: string[] = []
  for (const call of script.matchAll(/(?:\b(?:write\w*|append\w*|rm\w*|unlink\w*|truncate\w*|rename\w*|remove\w*|rmtree|chmod\w*|chown\w*)|\.write_text|\.write_bytes)\s*\(\s*(['"])([^'"\r\n]+)\1/g)) {
    out.push(call[2]!)
  }
  for (const call of script.matchAll(/\b(?:copy\w*|move|replace|rename)\s*\(\s*(['"])([^'"\r\n]+)\1\s*,\s*(['"])([^'"\r\n]+)\3/g)) {
    out.push(call[4]!, call[2]!)
  }
  for (const call of script.matchAll(/\bPath\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)\s*\.\s*(?:write_text|write_bytes|unlink|rmdir|touch|chmod|replace|rename)\b/g)) {
    out.push(call[2]!)
  }
  for (const call of script.matchAll(/\bopen\s*\(\s*(['"])([^'"\r\n]+)\1\s*(?:,\s*(?:mode\s*=\s*)?(['"])([^'"\r\n]*)\3)?/g)) {
    const mode = call[4] ?? ''
    if (/[wax+]/.test(mode) || /\.write(?:lines)?\s*\(/.test(script)) out.push(call[2]!)
  }
  return out
}

function inlineScriptReads(rawScript: string): string[] {
  const script = normalizeInlineScript(rawScript)
  if (!/\b(?:read\w*|open|load\w*|Get-Content|ReadAll\w*|ReadLines|OpenRead|Path|cat|type)\b/i.test(script)) return []
  const out: string[] = []
  for (const call of script.matchAll(/(['"])([^'"\r\n]+)\1/g)) out.push(call[2]!)
  return out
}

function updateTrackedCwd(argv: string[], cwd: string): string {
  const name = verb(argv[0] ?? '')
  if (['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location'].includes(name)) {
    const target = argv.slice(1).find(word => !word.startsWith('-'))
    if (target) return expandPath(spelling(target), cwd)
  }
  return cwd
}

async function walkShellCommands(
  command: string,
  powershell: boolean,
  visitor: (state: { argv: string[]; commands: string[][]; cwd: string; text: string; powershell: boolean }) => Promise<string | null> | string | null,
): Promise<string | null> {
  const pending = [{ text: command, cwd: getShellCwd(), powershell }]
  while (pending.length) {
    const current = pending.pop()!
    current.text = expandShellConstants(current.text, current.powershell)
    const extracted = extractHeredocs(current.text)
    const text = extracted.processedCommand
    const views: string[] = []
    const root = current.powershell ? null : await pinnedCommandAnalysis.parseCommandRaw(text)
    if (root !== null && root !== PARSE_ABORTED) {
      const visit = (node: Node): void => {
        if (['command', 'redirected_statement', 'pipeline', 'file_redirect'].includes(node.type)) {
          views.push(node.text)
          const substitutions = (child: Node): void => {
            if (child.type === 'command_substitution') visit(child)
            else for (const nested of child.children) substitutions(nested)
          }
          for (const child of node.children) substitutions(child)
        } else for (const child of node.children) visit(child)
      }
      visit(root)
    } else views.push(text)
    if (!current.powershell && extracted.heredocs.size > 0) {
      const original = await pinnedCommandAnalysis.parseCommandRaw(current.text)
      if (original !== null && original !== PARSE_ABORTED) {
        const substitutions = (node: Node): void => {
          if (node.type === 'command_substitution') views.push(node.text)
          else for (const child of node.children) substitutions(child)
        }
        substitutions(original)
      }
    }
    if (!current.powershell && root !== null && root !== PARSE_ABORTED) {
      const parsed = pinnedCommandAnalysis.parseForSecurityFromAst(text, root)
      if (parsed.kind === 'simple') {
        let cwd = current.cwd
        for (const simple of parsed.commands) {
          const argv = unwrapCommand([...simple.argv, ...simple.redirects.flatMap(redirect => ['>', '>>', '>|', '&>', '&>>'].includes(redirect.op) ? ['>', '', redirect.target] : redirect.op === '<' ? ['<', '', redirect.target] : [])])
          cwd = updateTrackedCwd(argv, cwd)
          const hit = await visitor({ argv, commands: [argv], cwd, text: current.text, powershell: current.powershell })
          if (hit !== null) return hit
        }
      }
    }
    let cwd = current.cwd
    for (const view of views) {
      const rawCommands = groups(view, current.powershell).map(unwrapCommand)
      const commands = expandSubcommands(rawCommands)
      for (const argv of commands) {
        cwd = updateTrackedCwd(argv, cwd)
        const hit = await visitor({ argv, commands, cwd, text: current.text, powershell: current.powershell })
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
  }
  return null
}

export async function shellCredentialWritePath(command: string, powershell = false): Promise<string | null> {
  return walkShellCommands(command, powershell, ({ argv, cwd, text, powershell: ps }) => {
    if (ps) {
      for (const call of text.matchAll(/(?:^|[;\n])\s*\[(?:System\.)?IO\.(?:File|Directory)\]::(?:WriteAllText|WriteAllBytes|AppendAllText|AppendAllLines|Delete|Move|Copy|Create|OpenWrite)\s*\(\s*(['"])([^'"\r\n]+)\1/gi)) {
        const hit = credentialStorePath(call[2]!, cwd)
        if (hit !== null) return call[2]!
      }
    }
    for (const path of writeOperands(argv)) {
      const hit = credentialStorePath(path, cwd)
      if (hit !== null) return path.includes('/') || path.includes('\\') ? path : hit
    }
    const name = verb(argv[0] ?? '')
    const flag = argv.findIndex((word, i) => i > 0 && /^-(?:e|c|p|command)$/i.test(word))
    if (/^(?:node|bun|python[\d.]*|ruby|perl)$/.test(name) && flag >= 0) {
      const script = argv.slice(flag + 1).join(' ')
      for (const target of inlineScriptWrites(script)) {
        const hit = credentialStorePath(target, cwd)
        if (hit !== null) return target.includes('/') || target.includes('\\') ? target : hit
      }
    }
    return null
  })
}

export async function shellMercurySecretPath(command: string, powershell = false): Promise<string | null> {
  const expanded = expandShellConstants(command, powershell)
  const pending = [expanded]
  while (pending.length) {
    const text = pending.pop()!
    for (const match of text.matchAll(/"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'();|<>=]+)/g)) {
      const token = match[1] ?? match[2] ?? match[3]!
      if (mercurySecretPath(token, getShellCwd()) !== null) return token
      if (token.length < text.length && /["']/.test(token)) pending.push(token)
    }
  }
  return walkShellCommands(command, powershell, ({ argv, cwd, text, powershell: ps }) => {
    if (ps) {
      for (const call of text.matchAll(/(?:^|[;\n])\s*\[(?:System\.)?IO\.File\]::(?:ReadAllText|ReadAllBytes|ReadAllLines|ReadLines|OpenRead)\s*\(\s*(['"])([^'"\r\n]+)\1/gi)) {
        const hit = mercurySecretPath(call[2]!, cwd)
        if (hit !== null) return hit
      }
    }
    for (const path of readOperands(argv)) {
      const hit = mercurySecretPath(path, cwd)
      if (hit !== null) return path.includes('/') || path.includes('\\') ? path : hit
    }
    const name = verb(argv[0] ?? '')
    const flag = argv.findIndex((word, i) => i > 0 && /^-(?:e|c|p|command)$/i.test(word))
    if (/^(?:node|bun|python[\d.]*|ruby|perl)$/.test(name) && flag >= 0) {
      const script = argv.slice(flag + 1).join(' ')
      for (const target of inlineScriptReads(script)) {
        const hit = mercurySecretPath(target, cwd)
        if (hit !== null) return target.includes('/') || target.includes('\\') ? target : hit
      }
    }
    return null
  })
}

export async function shellSelfProtectionReason(command: string, powershell = false): Promise<string | null> {
  return walkShellCommands(command, powershell, async ({ argv, commands, cwd, text, powershell: ps }) => {
    if (ps) {
      for (const call of text.matchAll(/(?:^|[;\n])\s*\[(?:System\.)?IO\.(?:File|Directory)\]::(?:WriteAllText|WriteAllBytes|AppendAllText|AppendAllLines|Delete|Move|Create|OpenWrite)\s*\(\s*(['"])([^'"\r\n]+)\1/gi)) {
        const hit = runtimeWritePath(call[2]!, cwd, true)
        if (hit) return 'Changing ' + call[2] + ' is refused: ' + hit + ' is part of Mercury’s running runtime.'
      }
    }
    const processReason = await runtimeProcessRefusal(commands)
    if (processReason) return processReason
    for (const target of runtimeOperands(argv)) {
      const hit = runtimeWritePath(target.path, cwd, target.removesTree)
      if (hit !== null) return 'Changing ' + target.path + ' is refused: ' + hit + ' is part of Mercury’s running runtime.'
    }
    const name = verb(argv[0] ?? '')
    const flag = argv.findIndex((word, i) => i > 0 && /^-(?:e|c|p|command)$/i.test(word))
    if (/^(?:node|bun|python[\d.]*|ruby|perl)$/.test(name) && flag >= 0) {
      const script = argv.slice(flag + 1).join(' ')
      for (const target of inlineScriptWrites(script)) {
        const hit = runtimeWritePath(target, cwd, true)
        if (hit) return 'Changing ' + target + ' is refused: ' + hit + ' is part of Mercury’s running runtime.'
      }
      for (const killCall of script.matchAll(/\b(?:process|os)\.kill\s*\(\s*(\d+)/g)) {
        const reason = await runtimeProcessRefusal([['kill', killCall[1]!]])
        if (reason) return reason
      }
    }
    return null
  })
}

export async function evalCodePermission(code: string, cwd = getShellCwd()): Promise<{ behavior: 'deny'; message: string; decisionReason: { type: 'other'; reason: string } } | null> {
  const denyVerdict = (message: string) => ({ behavior: 'deny' as const, message, decisionReason: { type: 'other' as const, reason: message } })
  for (const target of inlineScriptWrites(code)) {
    const runtime = runtimeWritePath(target, cwd, true)
    if (runtime !== null) return denyVerdict('Changing ' + target + ' is refused: ' + runtime + ' is part of Mercury’s running runtime.')
  }
  for (const killCall of code.matchAll(/\b(?:process|os)\.kill\s*\(\s*(\d+)/g)) {
    const reason = await runtimeProcessRefusal([['kill', killCall[1]!]])
    if (reason) return denyVerdict(reason)
  }
  const normalized = normalizeInlineScript(code)
  for (const target of [...inlineScriptReads(code), ...[...normalized.matchAll(/(['"])([^'"\r\n]+)\1/g)].map(m => m[2]!)]) {
    const secret = mercurySecretPath(target, cwd)
    if (secret !== null) return denyVerdict('Reading ' + target + ' is refused: ' + secret + " holds Mercury's own credentials; use the product's sign-in and account surfaces instead.")
  }
  for (const target of inlineScriptWrites(code)) {
    const credential = credentialStorePath(target, cwd)
    if (credential !== null) return denyVerdict('Writing ' + target + ' is refused: ' + credential + ' is a protected system or credential path.')
  }
  return null
}
