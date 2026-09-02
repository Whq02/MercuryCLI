/**
 * THE LETTER-VERB YIELD — the board's list focus carries two grammars on one
 * key stream: the single-letter row verbs (m/e/i/p/r/n/s, the broadcast
 * space, the / filter) and type-to-message (every printable lands in the
 * live composer for the selected row). Driven on the built product, "is it
 * done" typed from list focus INTERRUPTED the streaming turn on the `i`,
 * toggled split on the `s` and marked the row on the space before the rest
 * reached the composer — the operator's first board message would do the
 * same on any word starting with a verb letter.
 *
 * x is NOT in the roster (the close chord): the close verb the
 * yield could not save — the operator's close-press landed in a live chat
 * anyway — moved OFF the printable plane onto ⌃x ⌃x, and plain x is typing
 * in every state. A bare printable can never be a board control while any
 * composer is live; the yield protects the letters that remain verbs.
 *
 * Two facts declare the next keys WORDS, and on either the verbs yield to
 * the type-through:
 *   · the selected row is ARMED — the operator's own ↵ ("click Enter once
 *     and it selects it, then you can send a message", the ledger's L17);
 *   · the live composer already holds a draft (the broadcast space's
 *     empty-draft law, now one law for every letter).
 * esc disarms and the verbs return; a selection move disarms too. An
 * un-armed, empty-draft first key keeps its verb meaning — the list legend
 * prints those verbs, and the arm is the taught road to typing.
 */
export function letterVerbsYield(facts: {
  armedSessionId: string | null
  selectedSessionId: string | null
  liveDraftLength: number
}): boolean {
  if (facts.liveDraftLength > 0) return true
  return facts.armedSessionId !== null && facts.armedSessionId === facts.selectedSessionId
}
