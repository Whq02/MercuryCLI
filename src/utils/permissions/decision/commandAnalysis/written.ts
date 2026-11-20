import type { ReadCommand } from './reading.js'

const written = new WeakMap<ReadCommand, readonly string[]>()

export function keepWordsAsWritten(command: ReadCommand | undefined, words: readonly string[]): void {
  if (command !== undefined) written.set(command, words)
}

export function wordsAsWritten(command: ReadCommand): readonly string[] | undefined {
  return written.get(command)
}
