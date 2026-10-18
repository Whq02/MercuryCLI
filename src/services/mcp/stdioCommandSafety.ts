import { shellCommandSegments } from '../../tools/BashTool/destructiveCommandWarning.js'
import { peelWrappers } from '../../utils/bash/ast.js'

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish', 'csh', 'tcsh', 'cmd', 'powershell', 'pwsh'])
const FETCHERS = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm'])
const EVALUATORS = new Set([...SHELLS, 'eval', 'iex', 'invoke-expression'])
const leaf = (word: string): string => (word.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(?:exe|com)$/, '')

function fetchPipedToShell(script: string): boolean {
  const pending = [script]
  while (pending.length > 0) {
    let fetched = false
    for (const segment of shellCommandSegments(pending.pop()!)) {
      let words = segment.words
      while (/^[a-z_][a-z0-9_]*=/i.test(words[0] ?? '')) words = words.slice(1)
      if (['command', 'exec'].includes(words[0] ?? '')) words = words.slice(1)
      const peeled = peelWrappers(words)
      if (Array.isArray(peeled)) words = peeled
      const name = leaf(words[0] ?? '').replace(/^\(+/, '')
      if (!segment.piped) fetched = false
      if (segment.piped && fetched && EVALUATORS.has(name)) return true
      const tcp = words.some((word, index) => /<\/dev\/tcp\//i.test(word) || /^\/dev\/tcp\//i.test(word) && /^[0-9]*<+$/.test(words[index - 1] ?? ''))
      if (FETCHERS.has(name) || tcp || (name === 'new-object' && /webclient\b/i.test(words.join(' ')))) fetched = true
      if (SHELLS.has(name)) {
        const at = words.findIndex(word => /^-(?:[a-z]*c|command)$|^\/[ck]$/i.test(word))
        if (at >= 0 && words[at + 1] !== undefined) pending.push(words[at + 1]!)
      }
    }
  }
  return false
}

export function mcpStdioCommandRefusal(name: string, config: { type?: string; command?: string; args?: string[] }): string | null {
  if (config.type !== undefined && config.type !== 'stdio' || typeof config.command !== 'string') return null
  const rawWords = [config.command, ...(config.args ?? [])]
  const peeled = peelWrappers(rawWords)
  const words = Array.isArray(peeled) && peeled.length > 0 ? peeled : rawWords
  const shell = leaf(words[0] ?? '')
  if (!SHELLS.has(shell)) return null
  const args = words.slice(1)
  const isPs = ['powershell', 'pwsh'].includes(shell)
  const at = args.findIndex(arg => shell === 'cmd' ? /^\/[ck]$/i.test(arg) : isPs ? /^-(?:c|command)$/i.test(arg) : /^-[a-z]*c[a-z]*$/.test(arg))
  const psPositional = isPs && at < 0 && !args.some(arg => /^-(?:f|file)$/i.test(arg)) ? args.filter(arg => !arg.startsWith('-')).join(' ') : ''
  if (at < 0 && psPositional === '') return null
  const script = at < 0 ? psPositional : shell === 'cmd' || isPs ? args.slice(at + 1).join(' ') : args[at + 1] ?? ''
  if (!fetchPipedToShell(script)) return null
  return `MCP server ${JSON.stringify(name)} refused: its shell command fetches code from the network and pipes it into a shell. Configure a local server executable or a package runner instead.`
}
