import { getShellCwd } from '../Shell.js'
import { credentialStorePath, mercurySecretPath } from './protectedPaths.js'
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

function writeOperands(argv: string[]): string[] {
  const out: string[] = []
  const command: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '>' || argv[i] === '<') {
      if (argv[i] === '>' && argv[i + 2]) out.push(argv[i + 2]!)
      i += 2
    } else command.push(argv[i]!)
  }
  const writers = new Set(['tee', 'chmod', 'icacls', 'cp', 'mv', 'copy', 'move', 'copy-item', 'move-item', 'ci', 'cpi', 'mi', 'sed', 'set-content', 'add-content', 'out-file', 'tee-object', 'ac', 'sc'])
  const peeled = peelWrappers(command)
  const argvWithoutWrappers = Array.isArray(peeled) ? peeled : command
  const name = verb(argvWithoutWrappers[0] ?? '')
  if (!writers.has(name)) return out
  const args = argvWithoutWrappers.slice(1)
  const operands = args.filter(arg => !arg.startsWith('-'))
  if (name === 'sed') {
    if (args.some(arg => /^-(?:[a-z]*i|-[iI]n-place)/.test(arg))) out.push(...operands.slice(1))
  } else if (['cp', 'mv', 'copy', 'move', 'copy-item', 'move-item', 'ci', 'cpi', 'mi'].includes(name)) {
    const target = args.findIndex(arg => arg === '-t' || arg === '--target-directory' || /^-dest(?:ination)?$/i.test(arg))
    const fused = args.find(arg => arg.startsWith('--target-directory='))?.slice('--target-directory='.length)
    const destination = fused ?? (target >= 0 ? args[target + 1] : operands.at(-1))
    if (destination) out.push(destination)
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
  const peeled = peelWrappers(command)
  const unwrapped = Array.isArray(peeled) ? peeled : command
  const name = verb(unwrapped[0] ?? '')
  const readers = new Set(['cat', 'type', 'get-content', 'gc', 'head', 'tail', 'base64', 'xxd', 'od', 'hexdump', 'strings', 'grep', 'rg', 'cp', 'copy', 'copy-item', 'ci', 'cpi'])
  if (readers.has(name)) {
    const args = unwrapped.slice(1).filter(arg => !arg.startsWith('-'))
    out.push(...(['cp', 'copy', 'copy-item', 'ci', 'cpi'].includes(name) ? args.slice(0, -1) : args))
  }
  return out
}

export function shellCredentialWritePath(command: string, powershell = false): Promise<string | null> {
  return shellProtectedPath(command, powershell, writeOperands, credentialStorePath)
}

export async function shellMercurySecretPath(command: string, powershell = false): Promise<string | null> {
  const pending = [command]
  while (pending.length) {
    const text = pending.pop()!
    for (const match of text.matchAll(/"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'();|<>=]+)/g)) {
      const token = match[1] ?? match[2] ?? match[3]!
      if (mercurySecretPath(token, getShellCwd()) !== null) return token
      if (token.length < text.length && /["']/.test(token)) pending.push(token)
    }
  }
  return shellProtectedPath(command, powershell, readOperands, mercurySecretPath)
}

async function shellProtectedPath(command: string, powershell: boolean, operands: (argv: string[]) => string[], match: (path: string, cwd: string) => string | null): Promise<string | null> {
  const pending = [command]
  while (pending.length) {
    const text = pending.pop()!
    let views: string[] = [text]
    if (!powershell) {
      const root = await pinnedCommandAnalysis.parseCommandRaw(text)
      if (root !== null && root !== PARSE_ABORTED) {
        views = []
        const nodes: Node[] = [root]
        while (nodes.length) {
          const node = nodes.pop()!
          if (node.type === 'command' || node.type === 'file_redirect') views.push(node.text)
          nodes.push(...node.children)
        }
      }
    }
    for (const view of views) for (const argv of groups(view, powershell)) {
      for (const path of operands(argv)) {
        const hit = match(path, getShellCwd())
        if (hit !== null) return path
      }
      const peeled = peelWrappers(argv)
      const unwrapped = Array.isArray(peeled) ? peeled : argv
      if (/^(?:bash|sh|zsh|dash|pwsh|powershell)$/.test(verb(unwrapped[0] ?? ''))) {
        const flag = unwrapped.findIndex((word, i) => i > 0 && /^-(?:[a-z]*c|command)$/i.test(word))
        if (flag >= 0 && unwrapped[flag + 1] && unwrapped[flag + 1]!.length < text.length) pending.push(unwrapped[flag + 1]!)
      }
    }
  }
  return null
}

function runtimeOperands(argv: string[]): Array<{ path: string; removesTree: boolean }> {
  argv = argv.flatMap(word => {
    const fused = /^(-(?:literalpath|path|destination|filepath|newname)):(.+)$/i.exec(word)
    return fused ? [fused[1]!, fused[2]!] : [word]
  })
  const name = verb(argv[0] ?? '')
  const args = argv.slice(1)
  if (args.some(arg => /^-whatif$/i.test(arg))) return []
  const targets = writeOperands(argv).map(path => ({ path, removesTree: false }))
  const removers = ['rm', 'unlink', 'rmdir', 'rd', 'ri', 'del', 'erase', 'remove-item', 'mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item']
  if (removers.includes(name) || (name === 'find' && args.includes('-delete'))) {
    targets.push(...args.filter(arg => !arg.startsWith('-') && !/^\/[sq]$/i.test(arg)).map(path => ({ path, removesTree: true })))
  }
  if (['truncate', 'clear-content', 'clc', 'new-item', 'ni'].includes(name)) {
    targets.push(...args.filter(arg => !arg.startsWith('-')).map(path => ({ path, removesTree: false })))
  }
  if (['install', 'ln'].includes(name)) {
    const target = args.filter(arg => !arg.startsWith('-')).at(-1)
    if (target) targets.push({ path: target, removesTree: false })
  }
  if (name === 'dd') targets.push(...args.filter(arg => arg.startsWith('of=')).map(arg => ({ path: arg.slice(3), removesTree: false })))
  return targets
}

function expandPowerShellConstants(text: string): string {
  const values = new Map<string, string>()
  let rest = text
  for (;;) {
    const assignment = /^\s*\$([a-z_]\w*)\s*=\s*(['"])([^'"$`\r\n]*)\2\s*[;\n]/i.exec(rest)
    if (!assignment) break
    values.set(assignment[1]!.toLowerCase(), assignment[3]!)
    rest = rest.slice(assignment[0].length)
  }
  let quote = ''
  return rest.replace(/`.|''|['"]|\$([a-z_]\w*)/gi, (token, key: string | undefined) => {
    if (token.startsWith('`') || token === "''") return token
    if (token === "'" || token === '"') {
      if (!quote) quote = token
      else if (quote === token) quote = ''
      return token
    }
    const value = key && quote !== "'" ? values.get(key.toLowerCase()) : undefined
    return value === undefined ? token : quote ? value : '"' + value + '"'
  })
}

export async function shellSelfProtectionReason(command: string, powershell = false): Promise<string | null> {
  const pending = [{ text: command, cwd: getShellCwd(), powershell }]
  while (pending.length) {
    const current = pending.pop()!
    if (current.powershell) {
      current.text = expandPowerShellConstants(current.text)
      for (const call of current.text.matchAll(/(?:^|[;\n])\s*\[(?:System\.)?IO\.(?:File|Directory)\]::(?:WriteAllText|WriteAllBytes|AppendAllText|AppendAllLines|Delete|Move|Create|OpenWrite)\s*\(\s*(['"])([^'"\r\n]+)\1/gi)) {
        const hit = runtimeWritePath(call[2]!, current.cwd, true)
        if (hit) return 'Changing ' + call[2] + ' is refused: ' + hit + ' is part of Mercury’s running runtime.'
      }
    }
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
          if (verb(simple.argv[0] ?? '') === 'cd' && simple.argv[1]) cwd = expandPath(simple.argv[1], cwd)
          const reason = await runtimeProcessRefusal([simple.argv])
          if (reason) return reason
          const argv = [...simple.argv, ...simple.redirects.flatMap(redirect => ['>', '>>', '>|', '&>', '&>>'].includes(redirect.op) ? ['>', '', redirect.target] : [])]
          for (const target of runtimeOperands(argv)) {
            const hit = runtimeWritePath(target.path, cwd, target.removesTree)
            if (hit) return 'Changing ' + target.path + ' is refused: ' + hit + ' is part of Mercury’s running runtime.'
          }
        }
      }
    }
    let cwd = current.cwd
    for (const view of views) {
      const commands = groups(view, current.powershell).map(argv => {
        let unwrapped = argv[0] === '&' ? argv.slice(1) : argv
        while (['command', 'builtin', 'exec'].includes(verb(unwrapped[0] ?? ''))) {
          unwrapped = unwrapped.slice(1)
          while (unwrapped[0]?.startsWith('-')) unwrapped = unwrapped.slice(1)
        }
        const peeled = peelWrappers(unwrapped)
        return Array.isArray(peeled) ? peeled : unwrapped
      })
      const processReason = await runtimeProcessRefusal(commands)
      if (processReason) return processReason
      for (const argv of commands) {
        const name = verb(argv[0] ?? '')
        if (['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location'].includes(name)) {
          const target = argv.slice(1).find(word => !word.startsWith('-'))
          if (target) cwd = expandPath(target, cwd)
        }
        for (const target of runtimeOperands(argv)) {
          const hit = runtimeWritePath(target.path, cwd, target.removesTree)
          if (hit !== null) return 'Changing ' + target.path + ' is refused: ' + hit + ' is part of Mercury’s running runtime.'
        }
        const shell = /^(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd)$/.test(name)
        if (shell) {
          const flag = argv.findIndex((word, i) => i > 0 && /^(?:-(?:[a-z]*c|command)|\/[ck])$/i.test(word))
          if (flag >= 0 && argv[flag + 1] && argv[flag + 1]!.length < current.text.length) pending.push({ text: argv[flag + 1]!, cwd, powershell: /^(?:pwsh|powershell|cmd)$/.test(name) })
          for (const [placeholder, heredoc] of extracted.heredocs) {
            if (view.includes(placeholder)) pending.push({ text: current.text.slice(heredoc.contentStartIndex, heredoc.contentEndIndex), cwd, powershell: false })
          }
        }
        if (['eval', 'iex', 'invoke-expression'].includes(name)) {
          const script = argv.slice(1).join(' ')
          if (script.length < current.text.length) pending.push({ text: script, cwd, powershell: current.powershell })
        }
        if (/^(?:node|bun|python[\d.]*|ruby|perl)$/.test(name) && argv.some(word => /^-(?:e|c|p|command)$/.test(word))) {
          const script = argv.slice(2).join(' ')
          for (const call of script.matchAll(/\b(?:write\w*|append\w*|rm\w*|unlink\w*|truncate\w*|rename\w*|remove\w*|rmtree)\s*\(\s*(['"])([^'"\r\n]+)\1/g)) {
            const hit = runtimeWritePath(call[2]!, cwd, true)
            if (hit) return 'Changing ' + call[2] + ' is refused: ' + hit + ' is part of Mercury’s running runtime.'
          }
        }
      }
    }
  }
  return null
}
