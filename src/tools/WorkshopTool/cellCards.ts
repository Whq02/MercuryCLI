import type { WorkshopCellResult, WorkshopLanguage, WorkshopShellCall } from '../../services/workshop/contracts.js'

export type WorkshopCellCardFacts = {
  cellId: string
  language: WorkshopLanguage
  title?: string
  code: string
  state: 'failed' | 'timed-out'
  error: string
  outputTail: string[]
  shellCalls?: WorkshopShellCall[]
  durationMs: number
  generation: number
  runtimeKilled: boolean
  artifactRef?: string
}

export function lastShellCallOf(facts: { shellCalls?: WorkshopShellCall[] | null }): WorkshopShellCall | undefined {
  const calls = Array.isArray(facts.shellCalls) ? facts.shellCalls : []
  return calls.length > 0 ? calls[calls.length - 1] : undefined
}

export function shellCallHeadline(call: WorkshopShellCall): string {
  if (call.refused === true) return call.command
  return typeof call.code === 'number' ? `${call.command} · exit ${call.code}` : call.command
}

const CARD_LIMIT = 50
const cards = new Map<string, WorkshopCellCardFacts>()

export function cellOpensCard(cell: Pick<WorkshopCellResult, 'state'>): cell is WorkshopCellResult & { state: 'failed' | 'timed-out' } {
  return cell.state === 'failed' || cell.state === 'timed-out'
}

export function cellCardFactsOf(cell: WorkshopCellResult, code: string | undefined): WorkshopCellCardFacts | null {
  if (!cellOpensCard(cell)) return null
  return {
    cellId: cell.cellId,
    language: cell.language,
    ...(cell.title !== undefined ? { title: cell.title } : {}),
    code: code ?? '',
    state: cell.state,
    error: cell.error ?? '',
    outputTail: cell.outputTail,
    shellCalls: Array.isArray(cell.shellCalls) ? cell.shellCalls : [],
    durationMs: cell.durationMs,
    generation: cell.generation,
    runtimeKilled: cell.runtimeKilled,
    ...(cell.artifactRef !== undefined ? { artifactRef: cell.artifactRef } : {}),
  }
}

export function rememberCellCard(facts: WorkshopCellCardFacts): void {
  cards.delete(facts.cellId)
  cards.set(facts.cellId, facts)
  while (cards.size > CARD_LIMIT) {
    const oldest = cards.keys().next().value
    if (oldest === undefined) break
    cards.delete(oldest)
  }
}

export function cellCardOf(cellId: string): WorkshopCellCardFacts | undefined {
  return cards.get(cellId)
}

export function forgetCellCards(): void {
  cards.clear()
}
