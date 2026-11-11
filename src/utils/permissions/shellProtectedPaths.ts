import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { posix } from 'node:path'
import { getShellCwd } from '../Shell.js'
import { defaultMercuryHome, getAuthScope, getMercuryHome } from '../envUtils.js'
import { CREDENTIALS_SERVICE_SUFFIX, getMacOsKeychainStorageServiceName, getRawSpellingKeychainStorageServiceName } from '../secureStorage/macOsKeychainHelpers.js'
import { UNREAD_PART, absolutePath, layersOf, printedBy, readShellCommands, wordKnown, type Layer, type ReadCommand, type ReadWorld, type ShellRead } from '../wards/wardsShellRead.js'
import { credentialStorePath as storePathOf, mercurySecretPath as secretPathOf, protectedPathForms as pathFormsOf, spelling } from './protectedPaths.js'
import { pinnedCommandAnalysis, peelWrappers, PARSE_ABORTED, extractHeredocs, type Node } from './decision/commandAnalysis.js'
import { namesMercuryProcess, placedUnder, runtimeWritePath, runtimeProcessRefusal } from './runtimeProtection.js'
import { expandPath } from '../path.js'

const mercurySecretPath = (path: string, cwd?: string): string | null => secretPathOf(placedUnder(path, cwd), cwd)
const credentialStorePath = (path: string, cwd?: string): string | null => storePathOf(placedUnder(path, cwd), cwd)
const protectedPathForms = (path: string, cwd?: string): string[] => pathFormsOf(placedUnder(path, cwd), cwd)

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
  const readers = new Set([
    'cat', 'type', 'get-content', 'gc', 'head', 'tail', 'base64', 'xxd', 'od', 'hexdump', 'strings', 'grep', 'rg', 'cp', 'copy', 'copy-item', 'ci', 'cpi', 'mv', 'move', 'move-item', 'mi', 'rsync', 'install', 'dd', 'sqlite3',
    'xargs', 'sort', 'uniq', 'wc', 'cut', 'paste', 'column', 'nl', 'diff', 'jq', 'awk', 'sed', 'comm', 'cmp', 'tac', 'rev', 'fold', 'fmt', 'pr', 'expand', 'unexpand', 'tsort', 'info', 'man', 'pyright', 'du', 'date',
  ])
  if (readers.has(name)) {
    const args = unwrapped.slice(1)
    if (name === 'dd') {
      out.push(...args.filter(arg => /^if=/i.test(arg)).map(arg => arg.slice(3)))
    } else {
      const operands = args.filter(arg => !arg.startsWith('-'))
      out.push(...(['cp', 'copy', 'copy-item', 'ci', 'cpi', 'mv', 'move', 'move-item', 'mi', 'rsync', 'install'].includes(name) ? operands.slice(0, -1) : operands))
      out.push(...args.filter(arg => /^--[a-z-]+=./.test(arg)).map(arg => arg.slice(arg.indexOf('=') + 1)))
      const letters = READ_FILE_LETTERS[name]
      if (letters !== undefined) out.push(...args.filter(arg => /^-[A-Za-z]./.test(arg) && letters.includes(arg[1]!)).map(arg => arg.slice(2)))
    }
  }
  return out
}

const READ_FILE_LETTERS: Record<string, string> = { xargs: 'a', grep: 'f', rg: 'f', diff: 'X', du: 'X', jq: 'fL', info: 'fd', man: 'lMC', date: 'rf', pyright: 'p', awk: 'f', sed: 'f' }

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

function inlineScriptWrites(rawScript: string, spans?: Map<string, string>): string[] {
  const script = normalizeInlineScript(rawScript)
  const out: string[] = []
  const add = (call: RegExpMatchArray, ...paths: string[]): void => {
    const prefix = script.slice(0, call.index)
    const location = `${prefix.split('\n').length}:${prefix.length - prefix.lastIndexOf('\n')}`
    for (const path of paths) {
      out.push(path)
      spans?.set(path, `code at ${location}: ${call[0]}`)
    }
  }
  for (const call of script.matchAll(/(?:\b(?:write\w*|append\w*|rm\w*|unlink\w*|delete\w*|truncate\w*|rename\w*|remove\w*|rmtree|chmod\w*|chown\w*)|\.write_text|\.write_bytes)\s*\(\s*(['"])([^'"\r\n]+)\1/g)) {
    add(call, call[2]!)
  }
  for (const call of script.matchAll(/\b(?:copy\w*|move|rename)\s*\(\s*(['"])([^'"\r\n]+)\1\s*,\s*(['"])([^'"\r\n]+)\3/g)) {
    add(call, call[4]!, call[2]!)
  }
  const replacements = new Set(['os\\.replace'])
  const constructors = new Set(['Path', 'pathlib\\.Path'])
  for (const imported of script.matchAll(/\bimport\s+(os|pathlib)\s+as\s+(\w+)/g)) {
    if (imported[1] === 'os') replacements.add(`${imported[2]}\\.replace`)
    else constructors.add(`${imported[2]}\\.Path`)
  }
  for (const imported of script.matchAll(/\bfrom\s+(os|pathlib)\s+import\s+([^;\n]+)/g)) {
    for (const name of imported[2]!.split(',')) {
      const binding = /^\s*(replace|Path)(?:\s+as\s+(\w+))?\s*$/.exec(name)
      if (binding?.[1] === 'replace' && imported[1] === 'os') replacements.add(binding[2] ?? 'replace')
      if (binding?.[1] === 'Path' && imported[1] === 'pathlib') constructors.add(binding[2] ?? 'Path')
    }
  }
  const literal = String.raw`(['"])([^'"\r\n]+)\1`
  for (const call of script.matchAll(new RegExp(String.raw`\b(?:${[...replacements].join('|')})\s*\(\s*${literal}\s*,\s*(['"])([^'"\r\n]+)\3`, 'g'))) {
    add(call, call[4]!, call[2]!)
  }
  const constructor = String.raw`\b(?:${[...constructors].join('|')})\s*\(\s*${literal}\s*\)`
  for (const call of script.matchAll(new RegExp(String.raw`${constructor}\s*\.\s*(?:write_text|write_bytes|unlink|rmdir|touch|chmod|replace|rename)\b(?:\s*\(\s*(['"])([^'"\r\n]+)\3)?`, 'g'))) {
    add(call, call[2]!)
    if (/\.(?:replace|rename)\s*\(/.test(call[0]) && call[4]) add(call, call[4])
  }
  for (const assigned of script.matchAll(new RegExp(String.raw`\b(\w+)\s*=\s*(?:${[...constructors].join('|')})\s*\(\s*(['"])([^'"\r\n]+)\2\s*\)`, 'g'))) {
    for (const call of script.matchAll(new RegExp(String.raw`\b${assigned[1]}\s*\.\s*(?:replace|rename)\s*\(\s*${literal}`, 'g'))) {
      add(call, call[2]!, assigned[3]!)
    }
  }
  for (const call of script.matchAll(/\bopen\s*\(\s*(['"])([^'"\r\n]+)\1\s*(?:,\s*(?:mode\s*=\s*)?(['"])([^'"\r\n]*)\3)?/g)) {
    const mode = call[4] ?? ''
    if (/[wax+]/.test(mode) || /\.write(?:lines)?\s*\(/.test(script)) add(call, call[2]!)
  }
  return out
}

export function inlineScriptWriteTargets(script: string): string[] {
  return inlineScriptWrites(script)
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
    if (['cd', 'chdir', 'set-location', 'sl'].includes(name) && !argv.includes('-')) return expandPath(spelling('~'), cwd)
  }
  return cwd
}

async function walkShellCommands(
  command: string,
  powershell: boolean,
  visitor: (state: { argv: string[]; commands: string[][]; cwd: string; text: string; powershell: boolean }) => Promise<string | null> | string | null,
  cwd: string,
): Promise<string | null> {
  const pending = [{ text: command, cwd, powershell }]
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

export async function shellCredentialWritePath(command: string, powershell = false, cwd = getShellCwd()): Promise<string | null> {
  return (await credentialWriteWalked(command, powershell, cwd)) ?? credentialWriteAfterMove(command, powershell, cwd)
}

async function credentialWriteAfterMove(command: string, powershell: boolean, cwd: string): Promise<string | null> {
  const read = await readForFloors(command, powershell, cwd)
  if (read === null) return null
  for (const [at, simple] of read.commands.entries()) {
    const after = foldersAfter(read, at, cwd)
    if (after.lost) continue
    if (simple.cwd !== undefined && !GLOB_PART.test(simple.cwd) && !/^[A-Za-z]:\//.test(simple.cwd) && after.folders.length === 1) continue
    const written = simple.redirects.flatMap(redirect => (['>', '>>', '>|', '&>', '&>>'].includes(redirect.op) ? ['>', '', redirect.target] : []))
    for (const layer of layersOf(simple.argv)) {
      for (const path of writeOperands([...layer.argv, ...written])) {
        if (/^(?:[/~]|[A-Za-z]:)/.test(path)) continue
        for (const here of after.folders) {
          const full = posix.join(here, path)
          if (credentialStorePath(full, here) !== null) return full
        }
      }
    }
  }
  return null
}

function credentialWriteWalked(command: string, powershell: boolean, cwd: string): Promise<string | null> {
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
  }, cwd)
}

const SECRET_NAME_SAMPLES = ['.credentials.json', '.provider-secrets.json', 'mcp-auth.json', 'x-auth.json', 'browser-secrets.json', '.credentials.json.corrupt.1', '.provider-secrets.json.corrupt.1']
const CONVENTIONAL_USER_HOME = '(?:\\/(?:users|home)\\/[^/]+|\\/root|[a-z]:\\/users\\/[^/]+)'
const CONVENTIONAL_HOME = new RegExp(`^${CONVENTIONAL_USER_HOME}\\/\\.mercury$`)
const HOLDS_CONVENTIONAL_HOME = new RegExp(`^${CONVENTIONAL_USER_HOME}$`)
const DYNAMIC_PART = /[*?[{$]/

function currentUser(): { user?: string; uid?: string } {
  const named = process.env.USER || process.env.LOGNAME || process.env.USERNAME
  try {
    const info = userInfo()
    return { user: named || info.username, uid: String(info.uid) }
  } catch {
    return named ? { user: named } : {}
  }
}

function floorsWorld(cwd: string): ReadWorld {
  const home = (process.env.HOME || process.env.USERPROFILE || homedir()).replace(/\\/g, '/')
  return { cwd: cwd.replace(/\\/g, '/'), home, homesRoot: posix.dirname(home), ownNames: [], ...currentUser(), windows: process.platform === 'win32' }
}

async function readForFloors(command: string, powershell: boolean, cwd: string): Promise<ShellRead | null> {
  try {
    const read = await readShellCommands(command, powershell ? 'powershell' : 'posix', floorsWorld(cwd))
    return read
  } catch {
    return null
  }
}

function mercuryHomes(): string[] {
  return [...new Set([getMercuryHome(), getAuthScope(), defaultMercuryHome()].filter((path): path is string => !!path).flatMap(path => protectedPathForms(path)))]
}

function namesMercuryHome(word: string, cwd: string, homes: readonly string[]): boolean {
  if (word === '' || word.includes(UNREAD_PART)) return false
  return protectedPathForms(word, cwd).some(form => homes.includes(form) || CONVENTIONAL_HOME.test(form))
}

function wildcardSource(pattern: string): string {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === UNREAD_PART) out += '.*'
    else if (ch === '$') {
      const named = /^\$(?:\{[^}]*\}|\([^)]*\)|[a-z_][a-z0-9_]*)/i.exec(pattern.slice(i))
      out += '.*'
      i += named === null ? 0 : named[0].length - 1
    } else if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i++
      } else out += '[^/]*'
    } else if (ch === '?') out += '[^/]'
    else if (ch === '[') {
      const end = pattern.indexOf(']', i + 2)
      if (end < 0) out += '\\['
      else {
        out += `[${pattern.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i)
      if (end > 0 && pattern.slice(i, end).includes(',')) {
        out += `(?:${pattern.slice(i + 1, end).split(',').map(wildcardSource).join('|')})`
        i = end
      } else out += '\\{'
    } else out += ch.replace(/[.+^$()|\\\]}]/g, '\\$&')
  }
  return out
}

function secretsHeld(home: string): string[] {
  try {
    return readdirSync(home).filter(name => mercurySecretPath(`${home}/${name}`, home) !== null).map(name => name.toLowerCase())
  } catch {
    return []
  }
}

function couldNameSecret(word: string, cwd: string, homes: readonly string[], spelledHome = false): boolean {
  if (!DYNAMIC_PART.test(word) && !word.includes(UNREAD_PART)) return false
  const expanded = spelling(word)
  const segments = expanded.split(/[\\/]/)
  const at = segments.findIndex(segment => DYNAMIC_PART.test(segment) || segment.includes(UNREAD_PART))
  if (at < 0) return false
  const fixed = segments.slice(0, at).join('/') || (expanded.startsWith('/') ? '/' : '.')
  let pattern: RegExp
  try {
    pattern = new RegExp(`^${wildcardSource(segments.slice(at).join('/').toLowerCase())}$`)
  } catch {
    return false
  }
  for (const folder of protectedPathForms(fixed, cwd)) {
    const conventional = CONVENTIONAL_HOME.test(folder) ? [folder] : []
    for (const home of [...homes, ...conventional]) {
      if (home !== folder && (spelledHome || !home.startsWith(folder === '/' ? '/' : `${folder}/`))) continue
      const below = home === folder ? '' : `${home.slice(folder === '/' ? 1 : folder.length + 1)}/`
      for (const name of [...SECRET_NAME_SAMPLES, ...secretsHeld(home)]) if (pattern.test(below + name)) return true
    }
  }
  return false
}

function spellingsOf(word: string): string[] {
  const out = [word]
  const equals = word.indexOf('=')
  if (equals > 0) out.push(word.slice(equals + 1))
  for (const candidate of [...out]) {
    const plain = candidate.startsWith('@') ? candidate.slice(1).split(';')[0]! : candidate
    if (plain !== candidate) out.push(plain)
    const url = /^file:\/\/(?:localhost)?(\/[\s\S]*)$/i.exec(plain)
    if (url !== null) {
      try {
        out.push(decodeURIComponent(url[1]!))
      } catch {
        out.push(url[1]!)
      }
    }
  }
  return out
}

function underOtherHomes(word: string, homes: readonly string[]): string[] {
  if (word !== '~' && !word.startsWith('~/')) return []
  return homes.map(home => home + word.slice(1))
}

function readsWholeTree(layer: Layer): boolean {
  const { program, argv } = layer
  const flagged = (letters: RegExp, ...long: string[]): boolean => argv.slice(1).some(word => (word.startsWith('--') ? long.includes(word.split('=')[0]!) : /^-[A-Za-z]+$/.test(word) && letters.test(word)))
  switch (program) {
    case 'rg':
    case 'ag':
    case 'ack':
    case 'ditto':
    case 'rclone':
      return true
    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'zgrep':
      return flagged(/[rR]/, '--recursive', '--dereference-recursive')
    case 'cp':
    case 'scp':
    case 'copy-item':
    case 'cpi':
      return flagged(/[rRa]/, '--recursive', '--archive') || argv.slice(1).some(word => /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i.test(word))
    case 'rsync':
      return flagged(/[ra]/, '--recursive', '--archive')
    case 'tar':
    case 'bsdtar':
    case 'gtar':
      return /^-?[A-Za-z]*[cru]/.test(argv[1] ?? '') || flagged(/[cru]/, '--create', '--append', '--update')
    case 'zip':
      return flagged(/r/, '--recurse-paths')
    case '7z':
    case '7za':
      return argv[1] === 'a'
    case 'find':
      return argv.some(word => /^-(?:exec|execdir|ok|okdir|print0|fprint|fls)$/.test(word))
    case 'findstr':
      return argv.slice(1).some(word => FINDSTR_FLAG.test(word) && /s/i.test(word.split(':')[0]!))
    default:
      return false
  }
}

const TREE_COPIERS = new Set(['cp', 'scp', 'copy-item', 'cpi', 'rsync', 'ditto', 'rclone'])
const FILE_READERS = new Set([
  ...TREE_COPIERS, 'mv', 'move-item', 'mi', 'install', 'ln', 'dd', 'tar', 'bsdtar', 'gtar', 'zip', '7z', '7za', 'gzip', 'gunzip', 'zcat', 'bzip2', 'bzcat', 'xz', 'xzcat', 'zstd', 'zstdcat',
  'cat', 'tac', 'nl', 'head', 'tail', 'less', 'more', 'most', 'bat', 'view', 'strings', 'xxd', 'od', 'hexdump', 'base64', 'base32', 'openssl', 'jq', 'yq', 'awk', 'gawk', 'sed', 'cut', 'sort', 'uniq', 'paste', 'column', 'fold', 'rev', 'diff', 'cmp', 'comm',
  'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'source', '.', 'get-content', 'gc', 'type', 'select-string', 'sls', 'findstr',
])
const TREE_SEARCHERS = new Set(['rg', 'ag', 'ack', 'grep', 'egrep', 'fgrep', 'zgrep', 'findstr'])
const FINDSTR_FLAG = /^(?:\/\/?|-)[A-Za-z]+(?::.*)?$/
const POWERSHELL_LISTERS = new Set(['get-childitem', 'gci', 'dir', 'ls'])
const PIPED_FILE_READERS = new Set(['get-content', 'gc', 'cat', 'type', 'select-string', 'sls', 'copy-item', 'cpi', 'cp', 'copy', 'move-item', 'mi', 'mv', 'move', 'format-hex', 'fhx', 'compress-archive', 'import-csv', 'ipcsv', 'import-clixml'])
const LISTER_VALUED = ['path', 'literalpath', 'filter', 'include', 'exclude', 'depth', 'attributes', 'erroraction', 'errorvariable', 'warningaction', 'warningvariable', 'informationaction', 'informationvariable', 'outvariable', 'outbuffer', 'pipelinevariable']
const LISTER_VALUED_ALIASES = new Set(['pspath', 'lp', 'ea', 'ev', 'wa', 'wv', 'infa', 'iv', 'ov', 'ob', 'pv'])
const LISTER_SWITCHES = ['recurse', 'force', 'name', 'directory', 'file', 'hidden', 'readonly', 'system', 'followsymlink', 'verbose', 'debug']
const LISTER_SWITCH_ALIASES = new Set(['s', 'ad', 'af', 'ah', 'h', 'ar', 'as', 'vb', 'db'])

function powershellListing(argv: readonly string[]): { roots: string[]; deep: boolean } {
  const named: string[] = []
  const loose: string[] = []
  let deep = false
  let unsure = false
  const listOf = (value: string): string[] => value.split(',').map(part => part.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(part => part !== '')
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i]!
    if (!word.startsWith('-') || word === '-') {
      loose.push(...listOf(word))
      continue
    }
    const colon = word.indexOf(':')
    const name = (colon < 0 ? word.slice(1) : word.slice(1, colon)).toLowerCase()
    const valued = LISTER_VALUED_ALIASES.has(name) ? name : name === '' ? undefined : LISTER_VALUED.find(full => full.startsWith(name))
    const plain = LISTER_SWITCH_ALIASES.has(name) || (name !== '' && LISTER_SWITCHES.some(full => full.startsWith(name)))
    if (name === 's' || (name !== '' && 'recurse'.startsWith(name)) || valued === 'depth') deep = true
    if (valued === undefined || plain) {
      if (valued !== undefined || !plain) unsure = true
      continue
    }
    const value = colon < 0 ? argv[++i] : word.slice(colon + 1)
    if (value !== undefined && (valued === 'path' || valued === 'literalpath' || valued === 'pspath' || valued === 'lp')) named.push(...listOf(value))
  }
  const roots = (named.length > 0 ? named : loose).map(root => {
    const segments = root.split(/[\\/]/)
    const at = segments.findIndex(segment => GLOB_PART.test(segment))
    return at < 0 ? root : segments.slice(0, at).join('/') || (/^[\\/]/.test(root) ? '/' : '.')
  })
  if (roots.length === 0 || unsure || roots.some(root => /[$(@]/.test(root) || root.includes(UNREAD_PART))) roots.push('.')
  return { roots, deep }
}

const FIND_NON_READERS = new Set(['ls', 'stat', 'echo', 'printf', 'file', 'du', 'wc', 'basename', 'dirname', 'realpath', 'readlink', 'test', '[', 'true', 'touch', 'chmod', 'chown', 'rm', 'rmdir', 'unlink', 'mv'])

function holdsMercuryHome(word: string, cwd: string, homes: readonly string[], hidden = true): boolean {
  if (word === '' || word.includes(UNREAD_PART)) return false
  return protectedPathForms(word, cwd).some(form => (hidden && HOLDS_CONVENTIONAL_HOME.test(form)) || homes.some(home => home.startsWith(`${form}/`) && (hidden || !home.slice(form.length).includes('/.'))))
}

const GLOB_PART = /[*?[{]/

function globNamesStore(word: string, cwd: string, homes: readonly string[], hidden: boolean): boolean {
  if (!GLOB_PART.test(word) || word.includes(UNREAD_PART)) return false
  const expanded = spelling(word)
  const segments = expanded.split(/[\\/]/)
  const at = segments.findIndex(segment => GLOB_PART.test(segment))
  if (at < 0) return false
  const fixed = segments.slice(0, at).join('/') || (expanded.startsWith('/') ? '/' : '.')
  const patterns = segments.slice(at).filter(segment => segment !== '').map(segment => segment.toLowerCase())
  let tests: RegExp[]
  try {
    tests = patterns.map(pattern => new RegExp(`^${wildcardSource(pattern)}$`))
  } catch {
    return false
  }
  const dotLed = (pattern: string): boolean => pattern.startsWith('.') || /^\{(?:[^}]*,)?\./.test(pattern)
  for (const folder of protectedPathForms(fixed, cwd)) {
    const under = `${folder}/`
    for (const home of [...homes, ...(HOLDS_CONVENTIONAL_HOME.test(folder) ? [under + posix.basename(defaultMercuryHome().replace(/\\/g, '/')).toLowerCase()] : [])]) {
      if (!home.startsWith(under)) continue
      const below = home.slice(under.length).split(/[\\/]/)
      if (patterns.length > below.length) continue
      if (!patterns.every((pattern, index) => tests[index]!.test(below[index]!) && (dotLed(pattern) || !below[index]!.startsWith('.')))) continue
      if (hidden || !below.slice(patterns.length).some(segment => segment.startsWith('.'))) return true
    }
  }
  return false
}

const UPLOADERS = new Set(['curl', 'wget'])

function secretNameBehindUnread(word: string, homes: readonly string[]): boolean {
  if (wordKnown(word)) return false
  const name = posix.basename(word.replace(/\\/g, '/'))
  if (name === '' || !wordKnown(name) || GLOB_PART.test(name)) return false
  return homes.some(home => mercurySecretPath(name, home) !== null)
}

const CD_PROGRAMS = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'])
const FOLDER_CAP = 16
const ON_CONVENTIONAL_WAY = new RegExp(`^(?:\\/(?:users|home)|[a-z]:\\/users|${CONVENTIONAL_USER_HOME}(?:\\/\\.mercury(?:\\/.*)?)?)$`)
const namedFolders = new Map<string, { at: number; folders: string[] }>()

function onGuardedWay(folder: string, mercury: readonly string[], home: readonly string[]): boolean {
  const lower = folder.normalize('NFC').toLowerCase()
  if (ON_CONVENTIONAL_WAY.test(lower)) return true
  if (mercury.some(way => way === lower || way.startsWith(`${lower}/`) || lower.startsWith(`${way}/`))) return true
  if (home.some(way => way === lower || way.startsWith(`${lower}/`))) return true
  return (home.some(way => lower.startsWith(`${way}/`)) || /^\/(?:private\/)?(?:etc|library)(?:\/|$)/.test(lower)) && credentialStorePath(folder, '/') !== null
}

function foldersNamedBy(pattern: string): string[] {
  const known = namedFolders.get(pattern)
  if (known !== undefined && Date.now() - known.at < 2000) return known.folders
  const folders = foldersOnDisk(pattern)
  if (namedFolders.size >= 32) namedFolders.clear()
  namedFolders.set(pattern, { at: Date.now(), folders })
  return folders
}

function foldersOnDisk(pattern: string): string[] {
  let mercury: string[] | undefined
  let home: string[] = []
  const parts = spelling(pattern).split(/[\\/]/).filter(part => part !== '')
  let found = [/^[a-z]:$/i.test(parts[0] ?? '') ? `${parts.shift()}/` : '/']
  for (const part of parts) {
    const next: string[] = []
    for (const folder of found) {
      if (!GLOB_PART.test(part)) {
        next.push(posix.join(folder, part))
        continue
      }
      let test: RegExp
      try {
        test = new RegExp(`^${wildcardSource(part)}$`)
      } catch {
        continue
      }
      if (test.test('')) next.push(folder)
      let names: string[] = []
      try {
        names = readdirSync(folder)
      } catch {
      }
      const dotLed = part.startsWith('.') || /^\{(?:[^}]*,)?\./.test(part)
      const named = names.filter(name => test.test(name) && (dotLed || !name.startsWith('.')))
      next.push(...(named.length > 0 ? named : [part]).map(name => posix.join(folder, name)))
    }
    if (next.length > FOLDER_CAP) {
      if (mercury === undefined) {
        mercury = [...mercuryHomes(), ...protectedPathForms(process.env.MERCURY_DAEMON_DIR || getMercuryHome())]
        home = [process.env.HOME, process.env.USERPROFILE, homedir()].filter((path): path is string => !!path).flatMap(path => protectedPathForms(path))
      }
      const ways = mercury
      const guarded = next.filter(folder => onGuardedWay(folder, ways, home))
      found = [...guarded, ...next.filter(folder => !guarded.includes(folder)).slice(0, FOLDER_CAP)]
    } else found = next
    if (found.length === 0) return []
  }
  return found.filter(folder => {
    try {
      return statSync(folder).isDirectory()
    } catch {
      return false
    }
  })
}

function standsAsFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function foldersAfter(read: ShellRead, at: number, cwd: string): { folders: string[]; lost: boolean } {
  const reached = foldersRead(read, at, cwd)
  const simple = read.commands[at]
  const stands = simple?.cwd
  if (simple === undefined || stands === undefined) return reached
  const stayed: string[] = []
  for (let index = at - 1; index >= 0; index--) {
    const turn = read.commands[index]!
    const layer = layersOf(turn.argv)[0]
    if (layer === undefined || !CD_PROGRAMS.has(layer.program) || turn.cwd === undefined) continue
    const operands = layer.argv.slice(1).filter(word => !/^-[A-Za-z]+$/.test(word))
    const switched = process.platform === 'win32' && operands.length === 2 && /^\/d$/i.test(operands[0]!)
    const target = switched ? operands[1] : operands[0]
    if (target === undefined || target === '-' || !wordKnown(target)) continue
    const named = absolutePath(turn.dialect === 'powershell' ? target.replace(/\\/g, '/') : target, turn.cwd, floorsWorld(turn.cwd))
    if (named === undefined || (stands !== named && !stands.startsWith(`${named}/`))) continue
    const gated = (simple.gates ?? []).some(([from, to]) => index >= from && index < to)
    const ran =
      !turn.background &&
      (turn.maybes ?? []).every(context => (simple.maybes ?? []).includes(context)) &&
      (turn.gates ?? []).every(([from, to]) => (simple.gates ?? []).some(([start, end]) => (start === from && end === to) || (index >= start && index < end)))
    const moved = gated || ((operands.length === 1 || switched) && (GLOB_PART.test(named) ? foldersNamedBy(named).length > 0 : standsAsFolder(named)))
    if (ran && moved) continue
    stayed.push(posix.join(turn.cwd, stands.slice(named.length)), turn.cwd)
  }
  return stayed.length === 0 ? reached : { folders: [...new Set([...reached.folders, ...stayed])], lost: reached.lost }
}

function foldersRead(read: ShellRead, at: number, cwd: string): { folders: string[]; lost: boolean } {
  const simple = read.commands[at]
  if (simple === undefined) return { folders: [cwd], lost: false }
  if (simple.cwd !== undefined) {
    if (!GLOB_PART.test(simple.cwd)) return { folders: [simple.cwd], lost: false }
    return { folders: [...foldersNamedBy(simple.cwd), simple.cwd], lost: false }
  }
  for (let index = at - 1; index >= 0; index--) {
    const turn = read.commands[index]!
    const layer = layersOf(turn.argv)[0]
    if (layer === undefined || !CD_PROGRAMS.has(layer.program)) continue
    const before = turn.cwd ?? cwd
    let target = layer.argv.slice(1).find(word => !/^-[A-Za-z]+$/.test(word))
    if (target === UNREAD_PART) {
      const fed = turn.inner.flat()
      const printed = fed.length === 1 && read.commands[fed[0]!] !== undefined ? printedBy(read.commands[fed[0]!]!) : undefined
      if (printed !== undefined && printed.trim() !== '') target = printed.trim()
    }
    if (target === undefined || target === '-' || target.includes(UNREAD_PART) || /[$`\s]/.test(spelling(target))) return { folders: [before], lost: true }
    const pattern = /^[A-Za-z]:\//.test(spelling(target)) ? spelling(target) : placedUnder(target, before) !== target ? placedUnder(target, before) : expandPath(spelling(target), before)
    const named = GLOB_PART.test(pattern) ? foldersNamedBy(pattern) : standsAsFolder(pattern) ? [pattern] : []
    const gated = (simple.gates ?? []).some(([from, to]) => index >= from && index < to)
    return { folders: [...named, ...(named.includes(pattern) ? [] : [pattern]), ...(named.length > 0 || gated ? [] : [before])], lost: false }
  }
  return { folders: [cwd], lost: true }
}

function ripgrepReachesHidden(layer: Layer, simple: ReadCommand, read: ShellRead): boolean {
  const words = layer.argv.slice(1)
  if (words.some(word => word === '--hidden' || /^-[A-Za-z]*\.[A-Za-z.]*$/.test(word))) return true
  const unrestricted = words.reduce((count, word) => count + (word === '--unrestricted' ? 1 : /^-[A-Za-z.]+$/.test(word) ? (word.match(/u/g) ?? []).length : 0), 0)
  if (unrestricted >= 2) return true
  if (words.includes('--no-config')) return false
  const named = (entries: ReadonlyArray<{ name: string; value: string }>): boolean => entries.some(entry => entry.name === 'RIPGREP_CONFIG_PATH' && entry.value !== '')
  return named(simple.env) || named(layer.env) || (read.exported.get('RIPGREP_CONFIG_PATH') ?? []).some(value => value !== '') || !!process.env.RIPGREP_CONFIG_PATH
}

function treeReadRoots(layer: Layer, fed: boolean, cwd: string, cwdHolds: boolean): string[] {
  const words = layer.argv.slice(1)
  const plain = words.filter(word => word !== '' && !word.startsWith('-'))
  const { program } = layer
  if (TREE_COPIERS.has(program)) {
    const flag = words.findIndex(word => /^(?:-t|--target-directory|-destination)$/i.test(word))
    if (flag >= 0) return plain.filter(word => word !== words[flag + 1])
    return words.some(word => word.startsWith('--target-directory=')) ? plain : plain.slice(0, -1)
  }
  if (program === 'tar' || program === 'bsdtar' || program === 'gtar') {
    const roots: string[] = []
    let base: string | undefined
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!
      if (i === 0 && !word.startsWith('-')) {
        if (word.includes('f')) i++
      } else if (word === '-C' || word === '--directory') base = words[++i]
      else if (word.startsWith('--directory=')) base = word.slice('--directory='.length)
      else if (word === '--file' || /^-[A-Za-z]*f$/.test(word)) i++
      else if (!word.startsWith('-')) roots.push(base === undefined || /^[/~]/.test(word) ? word : `${base}/${word}`)
    }
    return roots
  }
  if (program === 'zip') return plain.slice(1)
  if (program === '7z' || program === '7za') return plain.slice(2)
  if (program === 'findstr') {
    const loose = words.filter(word => word !== '' && !FINDSTR_FLAG.test(word))
    const files = words.some(word => FINDSTR_FLAG.test(word) && /^[cg]$/i.test(word.replace(/^[-/]+/, '').split(':')[0]!)) ? loose : loose.slice(1)
    const named = words.flatMap(word => (FINDSTR_FLAG.test(word) && /^d$/i.test(word.replace(/^[-/]+/, '').split(':')[0]!) ? word.slice(word.indexOf(':') + 1).split(';').filter(part => part !== '') : []))
    return [...named, ...files.map(file => file.replace(/[\\/]?[^\\/]*$/, '') || (/^[\\/]/.test(file) ? '/' : '.'))]
  }
  if (TREE_SEARCHERS.has(program)) {
    const patterned = words.some(word => /^(?:-[A-Za-z]*[ef]|--regexp|--file)$/.test(word) || /^--(?:regexp|file)=/.test(word))
    const rest = patterned ? plain : plain.slice(1)
    return fed || !cwdHolds || rest.some(word => !wordKnown(word) || existsSync(expandPath(spelling(word), cwd))) ? rest : [...rest, '.']
  }
  return plain
}

function findNamesASecret(argv: readonly string[], homes: readonly string[]): boolean {
  if (argv.some(word => /^(?:-o|-or|-not|!|,)$/.test(word))) return true
  const names = argv.flatMap((word, index) => (/^-i?name$/.test(word) ? [argv[index + 1] ?? ''] : []))
  if (names.length === 0) return true
  const secrets = [...SECRET_NAME_SAMPLES, ...homes.flatMap(secretsHeld)].map(name => name.toLowerCase())
  return names.every(name => {
    try {
      const pattern = new RegExp(`^${wildcardSource(name.toLowerCase())}$`)
      return secrets.some(secret => pattern.test(secret))
    } catch {
      return true
    }
  })
}

function filesSentOrPrinted(layer: Layer): Set<string> {
  const { program, argv } = layer
  const out = new Set<string>()
  if (program === 'curl') {
    argv.forEach((word, at) => {
      const before = at > 0 ? argv[at - 1]! : ''
      if (before === '-T' || before === '--upload-file' || word.startsWith('--upload-file=')) out.add(word)
      if ((/^(?:-F|--form|-d|--data|--data-binary)$/.test(before) || /^--(?:form|data|data-binary)=/.test(word)) && word.includes('@')) out.add(word)
    })
  } else if (program === 'wget') {
    argv.forEach((word, at) => {
      if ((at > 0 && argv[at - 1] === '--post-file') || word.startsWith('--post-file=')) out.add(word)
    })
  } else if (program === 'gh') {
    const plain = argv.slice(1).filter(word => !word.startsWith('-'))
    if (plain[0] === 'gist' && plain[1] === 'create') for (const word of plain.slice(2)) out.add(word)
  } else if (program === 'git') {
    const at = argv.findIndex((word, index) => index > 0 && !word.startsWith('-') && !/^(?:-C|-c|--git-dir|--work-tree|--namespace)$/.test(argv[index - 1]!))
    const rest = at < 0 ? [] : argv.slice(at + 1)
    const verb = at < 0 ? '' : argv[at]!
    if (verb === 'hash-object' || verb === 'add' || (verb === 'diff' && rest.includes('--no-index'))) for (const word of rest) if (!word.startsWith('-')) out.add(word)
  }
  return out
}

function searcherOf(layer: Layer): Layer | undefined {
  if (TREE_SEARCHERS.has(layer.program)) return readsWholeTree(layer) ? layer : undefined
  if (layer.program !== 'git') return undefined
  const at = layer.argv.findIndex((word, index) => index > 0 && !word.startsWith('-') && !/^(?:-C|-c|--git-dir|--work-tree|--namespace)$/.test(layer.argv[index - 1]!))
  return at > 0 && layer.argv[at] === 'grep' ? { ...layer, program: 'grep', argv: ['grep', ...layer.argv.slice(at + 1)] } : undefined
}

function keychainItemRead(layer: Layer): string | null {
  if (layer.program !== 'security') return null
  const argv = layer.argv
  const at = argv.findIndex((word, i) => i > 0 && !word.startsWith('-'))
  const verb = at < 0 ? '' : argv[at]!.toLowerCase()
  if (verb === 'dump-keychain') return argv.slice(at + 1).some(word => /^-[A-Za-z]*d/.test(word)) ? 'the keychain' : null
  if (!['find-generic-password', 'find-internet-password', 'export'].includes(verb)) return null
  const own = [getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX), getMacOsKeychainStorageServiceName(), getRawSpellingKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX), getRawSpellingKeychainStorageServiceName()]
  const named = argv.slice(at + 1).find(word => own.includes(word) || /^mercury(?:-[a-z]+)*-[0-9a-f]{8}$/i.test(word))
  return named === undefined ? null : `the keychain item ${named}`
}

function sharesEarlierStage(earlier: ReadCommand, later: ReadCommand): boolean {
  for (const a of earlier.stages) for (const b of later.stages) if (a.pipeline === b.pipeline && a.stage < b.stage) return true
  return false
}

async function readSecretReach(command: string, powershell: boolean, cwd: string): Promise<string | null> {
  const read = await readForFloors(command, powershell, cwd)
  if (read === null) return null
  const homes = mercuryHomes()
  const fed = new Set<number>()
  for (const reader of read.commands) for (const at of [...reader.inner.flat(), ...reader.inputInner]) fed.add(at)
  const handed = new Map<number, boolean>()
  const handedToReader = (at: number, simple: ReadCommand): boolean => {
    const known = handed.get(at)
    if (known !== undefined) return known
    const answer = read.commands.some(other => {
      const readers = layersOf(other.argv).filter(found => FILE_READERS.has(found.program))
      if (readers.length === 0) return false
      return [...other.inner.flat(), ...other.inputInner].includes(at) || (sharesEarlierStage(simple, other) && readers.some(found => found.wrappers.includes('xargs')))
    })
    handed.set(at, answer)
    return answer
  }
  const whereItStays = (here: string): string => `the whole of ${here}, where this line stays if the cd before it fails (join them with && so the read runs only after the cd)`
  for (const { at, simple, here, stayed } of read.commands.flatMap((simple, at) => {
    const stands = foldersRead(read, at, cwd).folders
    return foldersAfter(read, at, cwd).folders.map(here => ({ at, simple, here, stayed: !powershell && !stands.includes(here) }))
  })) {
    const layers = layersOf(simple.argv)
    const fedNames = layers.some(layer => FILE_READERS.has(layer.program) && layer.wrappers.includes('xargs'))
    for (const redirect of simple.redirects) {
      if (redirect.op !== '<') continue
      for (const candidate of spellingsOf(redirect.target)) {
        if (mercurySecretPath(candidate, here) !== null || couldNameSecret(candidate, here, homes, !wordKnown(candidate))) return redirect.target
        if (secretNameBehindUnread(candidate, homes)) return candidate.replaceAll(UNREAD_PART, '$(…)')
      }
    }
    for (const word of simple.input === undefined ? [] : simple.input.split(/\s+/)) {
      for (const candidate of spellingsOf(word)) {
        if (mercurySecretPath(candidate, here) !== null || (fedNames && couldNameSecret(candidate, here, homes, !wordKnown(candidate)))) return word
        if (fedNames && secretNameBehindUnread(candidate, homes)) return candidate.replaceAll(UNREAD_PART, '$(…)')
      }
    }
    for (const layer of layers) {
      const item = keychainItemRead(layer)
      if (item !== null) return item
      const roots = layer.findRoots !== undefined && layer.argv !== simple.argv ? layer.findRoots : []
      const tree = readsWholeTree(layer)
      const sent = filesSentOrPrinted(layer)
      const lists = layer.program === 'find' || layer.program === 'ls' || layer.program === 'get-childitem' || layer.program === 'gci' || layer.program === 'dir'
      const listed = powershell && POWERSHELL_LISTERS.has(layer.program) && read.commands.some(later => sharesEarlierStage(simple, later) && layersOf(later.argv).some(found => PIPED_FILE_READERS.has(found.program))) ? powershellListing(layer.argv) : null
      const feeds = lists && (fed.has(at) || listed !== null || read.commands.some(later => sharesEarlierStage(simple, later) && layersOf(later.argv).some(found => found.wrappers.includes('xargs') || found.program === 'xargs')))
      for (const word of [...layer.argv.slice(1), ...roots, ...(listed === null ? [] : listed.roots)]) {
        for (const candidate of [...spellingsOf(word), ...underOtherHomes(word, read.homes)]) {
          if (mercurySecretPath(candidate, here) !== null || ((FILE_READERS.has(layer.program) || sent.has(word) || handedToReader(at, simple)) && couldNameSecret(candidate, here, homes, !wordKnown(candidate)))) return word
          if ((FILE_READERS.has(layer.program) || UPLOADERS.has(layer.program) || sent.has(word)) && secretNameBehindUnread(candidate, homes)) return candidate.replaceAll(UNREAD_PART, '$(…)')
          if ((tree || feeds) && namesMercuryHome(candidate, here, homes)) return word
        }
      }
      const searcher = searcherOf(layer)
      const piped = simple.input !== undefined || simple.stages.some(stage => stage.stage > 0) || simple.redirects.some(redirect => redirect.op === '<')
      if (searcher !== undefined && !piped && namesMercuryHome('.', here, homes) && treeReadRoots(searcher, false, here, true).includes('.')) return stayed ? whereItStays(here) : '.'
      const finder = layer.program === 'find' ? layer : layer.findRoots === undefined ? undefined : layers.find(outer => outer.program === 'find')
      const whole = finder === undefined ? tree || (listed !== null && listed.deep) : findNamesASecret(finder.argv, homes) && (layer === finder ? feeds : !FIND_NON_READERS.has(layer.program))
      if (!whole) continue
      const handed = simple.input !== undefined || simple.stages.some(stage => stage.stage > 0) || simple.redirects.some(redirect => redirect.op === '<')
      const hidden = layer.program !== 'rg' || ripgrepReachesHidden(layer, simple, read)
      const held = finder !== undefined ? (finder.findRoots === undefined || finder.findRoots.length === 0 ? ['.'] : finder.findRoots) : listed !== null ? listed.roots : treeReadRoots(layer, handed, here, holdsMercuryHome('.', here, homes, hidden))
      for (const root of held) {
        for (const candidate of [...spellingsOf(root), ...underOtherHomes(root, read.homes)]) {
          if (holdsMercuryHome(candidate, here, homes, hidden) || globNamesStore(candidate, here, homes, hidden)) return stayed && root === '.' ? whereItStays(here) : `the whole of ${root === '.' ? 'this folder' : root} (name a folder beneath it)`
        }
      }
    }
  }
  for (const [at, simple] of read.commands.entries()) {
    if (!foldersAfter(read, at, cwd).lost) continue
    for (const word of [...simple.redirects.filter(redirect => redirect.op === '<').map(redirect => redirect.target), ...layersOf(simple.argv).flatMap(layer => layer.argv.slice(1))]) {
      if (word === '' || /^(?:[/~-]|[A-Za-z]:)/.test(word) || word.includes(UNREAD_PART)) continue
      for (const home of homes) if (mercurySecretPath(word, home) !== null) return word
    }
  }
  return null
}

export async function shellMercurySecretPath(command: string, powershell = false, cwd = getShellCwd()): Promise<string | null> {
  const named = await namedMercurySecretPath(command, powershell, cwd)
  const reached = named ?? (await readSecretReach(command, powershell, cwd))
  return reached === null ? null : reached.replaceAll(UNREAD_PART, '$(…)')
}

async function namedMercurySecretPath(command: string, powershell: boolean, cwd: string): Promise<string | null> {
  const expanded = expandShellConstants(command, powershell)
  const pending = [expanded]
  while (pending.length) {
    const text = pending.pop()!
    for (const match of text.matchAll(/"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'();|<>=]+)/g)) {
      const token = match[1] ?? match[2] ?? match[3]!
      if (mercurySecretPath(token, cwd) !== null) return token
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
  }, cwd)
}

const GIT_OPTION_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path'])
const GIT_WRITES = new Set(['checkout', 'clean', 'reset', 'restore', 'switch', 'pull', 'merge', 'rebase', 'stash', 'apply', 'am', 'cherry-pick', 'revert', 'rm', 'mv', 'init', 'clone', 'worktree', 'submodule', 'read-tree', 'checkout-index'])
const PACKAGE_WRITES = new Set(['install', 'i', 'ci', 'add', 'uninstall', 'remove', 'rm', 'update', 'up', 'upgrade', 'dedupe', 'prune', 'rebuild', 'link'])
const ATTRIBUTE_WRITERS = new Set(['chown', 'chgrp', 'chflags', 'xattr', 'touch', 'setfacl', 'lchown'])
const TREE_REMOVERS = new Set(['rm', 'unlink', 'rmdir', 'rd', 'ri', 'del', 'erase', 'remove-item', 'shred'])
const SCRIPT_LANGUAGES = /^(?:node|nodejs|bun|deno|python[\d.]*|ruby|perl|php|lua)$/
const PATTERN_READERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'awk', 'gawk', 'sed', 'pgrep', 'pidof'])

function valuesOf(argv: string[], ...names: string[]): string[] {
  const out: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i]!
    const named = names.find(name => word === name || word.startsWith(`${name}=`) || (name.length === 2 && word.startsWith(name) && word.length > 2 && !word.startsWith('--')))
    if (named === undefined) continue
    if (word === named) {
      if (argv[i + 1] !== undefined) out.push(argv[++i]!)
    } else out.push(word.slice(word.startsWith(`${named}=`) ? named.length + 1 : named.length))
  }
  return out
}

function plainOperands(argv: string[]): string[] {
  return argv.slice(1).filter(word => !word.startsWith('-'))
}

function runtimeTargetsOf(layer: Layer): Array<{ path: string; removesTree: boolean }> {
  const { program, argv } = layer
  const at = (paths: string[], removesTree = false): Array<{ path: string; removesTree: boolean }> => paths.map(path => ({ path, removesTree }))
  switch (program) {
    case 'tar':
    case 'bsdtar':
    case 'gtar': {
      const extracts = /^-?[A-Za-z]*x/.test(argv[1] ?? '') || argv.slice(1).some(word => word === '--extract' || word === '--get' || (/^-[A-Za-z]+$/.test(word) && word.includes('x')))
      if (!extracts) return []
      const into = valuesOf(argv, '-C', '--directory', '--cd')
      return at(into.length > 0 ? into : ['.'])
    }
    case 'unzip': {
      const into = valuesOf(argv, '-d')
      return at(into.length > 0 ? into : ['.'])
    }
    case 'curl': {
      const named = [...valuesOf(argv, '-o', '--output'), ...valuesOf(argv, '--output-dir')]
      return at(named.length > 0 ? named : argv.some(word => word === '--remote-name' || /^-[A-Za-z]*O/.test(word)) ? ['.'] : [])
    }
    case 'wget': {
      const named = [...valuesOf(argv, '-O', '--output-document'), ...valuesOf(argv, '-P', '--directory-prefix')]
      return at(named.length > 0 ? named : ['.'])
    }
    case 'patch': {
      const into = valuesOf(argv, '-d', '--directory')
      return at(into.length > 0 ? into : ['.'])
    }
    case 'git': {
      let i = 1
      const folders: string[] = []
      while (i < argv.length && argv[i]!.startsWith('-')) {
        const word = argv[i]!
        if (word === '-C' || word === '--work-tree' || word === '--git-dir') folders.push(argv[i + 1] ?? '')
        else if (word.startsWith('--work-tree=') || word.startsWith('--git-dir=')) folders.push(word.slice(word.indexOf('=') + 1))
        i += GIT_OPTION_VALUED.has(word) ? 2 : 1
      }
      return GIT_WRITES.has(argv[i] ?? '') ? at(folders.length > 0 ? folders : ['.'], argv[i] === 'clean') : []
    }
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      const folders = valuesOf(argv, '--prefix', '--dir', '--cwd', '-C')
      const verb = plainOperands(argv).find(word => !folders.includes(word)) ?? ''
      return PACKAGE_WRITES.has(verb) ? at(folders.length > 0 ? folders : ['.']) : []
    }
    case 'ditto': {
      const operands = plainOperands(argv)
      return operands.length >= 2 ? at([operands[operands.length - 1]!]) : []
    }
    default:
      return ATTRIBUTE_WRITERS.has(program) ? at(plainOperands(argv)) : []
  }
}

function inlineScriptOf(layer: Layer): string | null {
  if (!SCRIPT_LANGUAGES.test(layer.program)) return null
  const flag = layer.argv.findIndex((word, i) => i > 0 && /^-(?:e|c|p|E|r)$/.test(word))
  return flag >= 0 ? layer.argv.slice(flag + 1).join(' ') : null
}

async function killOfNamedPid(text: string): Promise<string | null> {
  if (!/kill|terminate/i.test(text)) return null
  for (const number of [...new Set([...text.matchAll(/\b\d{2,}\b/g)].map(match => match[0]))].slice(0, 32)) {
    const reason = await runtimeProcessRefusal([['kill', number]])
    if (reason) return reason
  }
  return null
}

function withinMercuryRecords(word: string, cwd: string, homes: readonly string[]): boolean {
  if (word === '' || word.startsWith('-') || word.includes(UNREAD_PART)) return false
  return protectedPathForms(word, cwd).some(form => homes.some(home => form === home || form.startsWith(`${home}/`)))
}

async function readSelfProtection(command: string, powershell: boolean, cwd: string): Promise<string | null> {
  const read = await readForFloors(command, powershell, cwd)
  if (read === null) return null
  const homes = [...mercuryHomes(), ...protectedPathForms(process.env.MERCURY_DAEMON_DIR || getMercuryHome())]
  const changing = (path: string, hit: string): string => 'Changing ' + path + ' is refused: ' + hit + ' is part of Mercury’s running runtime.'
  for (const { simple, here } of read.commands.flatMap((simple, at) => foldersAfter(read, at, cwd).folders.map(here => ({ simple, here })))) {
    const feeders = (piped: boolean): ReadCommand[] => {
      const out: ReadCommand[] = []
      const seen = new Set<number>()
      const visit = (indexes: readonly number[]): void => {
        for (const index of indexes) {
          const inner = read.commands[index]
          if (inner === undefined || seen.has(index)) continue
          seen.add(index)
          out.push(inner)
          visit(inner.inner.flat())
          visit(inner.inputInner)
        }
      }
      visit(simple.inner.flat())
      visit(simple.inputInner)
      if (piped) for (const earlier of read.commands) if (sharesEarlierStage(earlier, simple)) out.push(earlier)
      return out
    }
    for (const redirect of simple.redirects) {
      if (!['>', '>>', '>|', '&>', '&>>'].includes(redirect.op)) continue
      const hit = runtimeWritePath(redirect.target, here, false)
      if (hit !== null) return changing(redirect.target, hit)
    }
    for (const layer of layersOf(simple.argv)) {
      const reason = await runtimeProcessRefusal([layer.argv])
      if (reason) return reason
      const script = inlineScriptOf(layer)
      if (script !== null) {
        const killed = await killOfNamedPid(script)
        if (killed) return killed
      }
      const piped = layer.wrappers.includes('xargs')
      if (layer.program === 'kill' && (piped || layer.argv.some(word => word.includes(UNREAD_PART)))) {
        if (simple.input !== undefined) {
          const killed = await killOfNamedPid(`kill ${simple.input}`)
          if (killed) return killed
        }
        for (const feeder of feeders(piped)) {
          const there = foldersAfter(read, read.commands.indexOf(feeder), cwd).folders[0] ?? cwd
          for (const fed of layersOf(feeder.argv)) {
            const record = fed.argv.slice(1).find(word => withinMercuryRecords(word, there, homes))
            if (record !== undefined) return 'Killing a process named by ' + record + ' is refused: that file is Mercury’s own record of its running process or daemon.'
            let pattern: string | undefined
            for (const word of PATTERN_READERS.has(fed.program) ? fed.argv.slice(1) : []) {
              if (!word.startsWith('-') && (await namesMercuryProcess(word))) {
                pattern = word
                break
              }
            }
            if (pattern !== undefined) return 'Killing the processes that match ' + pattern + ' is refused: it can terminate Mercury’s running process or daemon. Use the pid of the unrelated process instead.'
          }
        }
      }
      for (const target of [...runtimeTargetsOf(layer), ...runtimeOperands(layer.argv)]) {
        const hit = runtimeWritePath(target.path, here, target.removesTree)
        if (hit !== null) return changing(target.path, hit)
      }
      if (TREE_REMOVERS.has(layer.program) && (piped || layer.argv.some(word => word.includes(UNREAD_PART)))) {
        for (const feeder of feeders(piped)) {
          const there = foldersAfter(read, read.commands.indexOf(feeder), cwd).folders[0] ?? cwd
          for (const fed of layersOf(feeder.argv)) {
            for (const word of [...fed.argv.slice(1), ...(fed.findRoots ?? [])]) {
              if (word.startsWith('-') || word.includes(UNREAD_PART)) continue
              const hit = runtimeWritePath(word, there, false)
              if (hit !== null) return changing(word, hit)
            }
          }
        }
      }
    }
  }
  return null
}

export async function shellSelfProtectionReason(command: string, powershell = false, cwd = getShellCwd()): Promise<string | null> {
  const named = await namedSelfProtectionReason(command, powershell, cwd)
  return named ?? readSelfProtection(command, powershell, cwd)
}

async function namedSelfProtectionReason(command: string, powershell: boolean, cwd: string): Promise<string | null> {
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
  }, cwd)
}

export async function evalCodePermission(code: string, cwd = getShellCwd()): Promise<{ behavior: 'deny'; message: string; decisionReason: { type: 'other'; reason: string } } | null> {
  const denyVerdict = (message: string) => ({ behavior: 'deny' as const, message, decisionReason: { type: 'other' as const, reason: message } })
  const spans = new Map<string, string>()
  const writes = inlineScriptWrites(code, spans)
  for (const target of writes) {
    const runtime = runtimeWritePath(target, cwd, true)
    if (runtime !== null) return denyVerdict('Changing ' + target + ' is refused: ' + runtime + ' is part of Mercury’s running runtime.\n' + spans.get(target))
  }
  for (const killCall of code.matchAll(/\b(?:process|os)\.kill\s*\(\s*(\d+)/g)) {
    const reason = await runtimeProcessRefusal([['kill', killCall[1]!]])
    if (reason) return denyVerdict(reason)
  }
  const killed = await killOfNamedPid(code)
  if (killed) return denyVerdict(killed)
  const normalized = normalizeInlineScript(code)
  for (const target of [...inlineScriptReads(code), ...[...normalized.matchAll(/(['"])([^'"\r\n]+)\1/g)].map(m => m[2]!)]) {
    const secret = mercurySecretPath(target, cwd)
    if (secret !== null) return denyVerdict('Reading ' + target + ' is refused: ' + secret + " holds Mercury's own credentials; use the product's sign-in and account surfaces instead.")
  }
  const homes = mercuryHomes()
  for (const literal of normalized.matchAll(/(['"])([^'"\r\n]+)\1/g)) {
    for (const word of literal[2]!.split(/\s+/)) {
      for (const candidate of spellingsOf(word)) {
        if (mercurySecretPath(candidate, cwd) !== null || couldNameSecret(candidate, cwd, homes)) return denyVerdict('Reading ' + word + ' is refused: it can name a file that holds Mercury\'s own credentials; use the product\'s sign-in and account surfaces instead.')
      }
    }
  }
  for (const target of inlineScriptWrites(code)) {
    const credential = credentialStorePath(target, cwd)
    if (credential !== null) return denyVerdict('Writing ' + target + ' is refused: ' + credential + ' is a protected system or credential path.')
  }
  return null
}
