import { PARSE_ABORTED, pinnedCommandAnalysis, type Node } from './decision/commandAnalysis.js'

type Run = { id: string; state: string[]; pending: string; reading: Promise<void> }

const runs = new Map<string, Run>()
const MAX_RUNS = 64
const MAX_STATE_CHARS = 4000
const MAX_PENDING_CHARS = 8000
const LINE_EDITING = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const STATE_COMMANDS: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd', 'alias', 'unalias'])
const STATE_STATEMENTS: ReadonlySet<string> = new Set(['variable_assignment', 'variable_assignments', 'declaration_command', 'unset_command', 'function_definition'])
const OPENED_STATEMENTS: ReadonlySet<string> = new Set(['program', 'list', 'redirected_statement', 'compound_statement'])

function stateLeftBy(node: Node, kept: string[]): void {
  if (STATE_STATEMENTS.has(node.type)) {
    kept.push(node.text)
    return
  }
  if (node.type === 'command') {
    const name = node.children.find(child => child.type === 'command_name')?.text ?? ''
    if (STATE_COMMANDS.has(name)) kept.push(node.text)
    return
  }
  if (OPENED_STATEMENTS.has(node.type)) for (const child of node.children) stateLeftBy(child, kept)
}

async function stateStatements(script: string): Promise<string[]> {
  const root = await pinnedCommandAnalysis.parseCommandRaw(script)
  if (!root || root === PARSE_ABORTED) return []
  const kept: string[] = []
  stateLeftBy(root, kept)
  return kept
}

export function serviceInputKey(project: string, name: string): string {
  return `${project}\u0000${name}`
}

export function noteServiceInput(service: string, run: string, text: string, submitted: boolean): void {
  let known = runs.get(service)
  if (known === undefined || known.id !== run) {
    known = { id: run, state: [], pending: '', reading: Promise.resolve() }
    runs.delete(service)
    runs.set(service, known)
    if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value as string)
  }
  if (LINE_EDITING.test(text)) {
    known.pending = ''
    return
  }
  const typed = text.replace(/\r\n?/g, '\n')
  const whole = known.pending + typed + (submitted && !typed.endsWith('\n') ? '\n' : '')
  const cut = whole.lastIndexOf('\n')
  known.pending = whole.slice(cut + 1).slice(-MAX_PENDING_CHARS)
  const lines = whole.slice(0, cut + 1)
  if (lines.trim() === '') return
  const held = known
  held.reading = held.reading
    .then(async () => {
      held.state.push(...(await stateStatements(lines)))
      while (held.state.length > 1 && held.state.join('\n').length > MAX_STATE_CHARS) held.state.shift()
    })
    .catch(() => undefined)
}

export function serviceInputSoFar(service: string, text: string, run?: string): string {
  const known = runs.get(service)
  if (known === undefined || (run !== undefined && known.id !== run)) return text
  const line = known.pending + text
  return known.state.length === 0 ? line : `${known.state.join('\n')}\n${line}`
}

export async function serviceInputAsSent(service: string, text: string, run?: string): Promise<string> {
  await runs.get(service)?.reading
  return serviceInputSoFar(service, text, run)
}
