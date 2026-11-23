import type { LocalModelRecord } from './localDiscovery.js'

let whoHearsALocalTurn: ((record: LocalModelRecord | undefined) => void) | undefined

export function tellWhoHearsALocalTurn(hear: (record: LocalModelRecord | undefined) => void): void {
  whoHearsALocalTurn = hear
}

export function localTurnTakesTheServer(record: LocalModelRecord | undefined): void {
  if (whoHearsALocalTurn !== undefined) whoHearsALocalTurn(record)
}
