import { getShellCwd } from '../Shell.js'
import { credentialStorePath } from './protectedPaths.js'
import { pinnedCommandAnalysis, peelWrappers, PARSE_ABORTED, type Node } from './decision/commandAnalysis.js'

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

export async function shellCredentialWritePath(command: string, powershell = false): Promise<string | null> {
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
      for (const path of writeOperands(argv)) {
        const hit = credentialStorePath(path, getShellCwd())
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
