// ============================================================================
//  messages/appendRow — the transcript append's ROW-IDENTITY invariant.
//
//  THE LAW (operator live-drive block C — doubled turns): one uuid, one row.
//  Every layer beneath the REPL settles exactly once by construction (the
//  lanes mint one message per block, the turn machine emits one
//  assistant_settled per yield, the projection is total), but the append
//  itself carried no invariant — any upstream double-emit, now or under a
//  future regression (a re-presented settlement, a compact re-yield whose
//  verbatim tail survives in retained scrollback, a provider retry), painted
//  twice and persisted twice. This owner makes the double STRUCTURALLY
//  impossible at the one seam every settled row passes through.
//
//  Semantics: an incoming message whose uuid already holds a row REPLACES
//  that row in place (the newest reference wins — the same law as the turn
//  machine's direct-mutation settle, where later facts land on the same
//  message), preserving position; anything else appends. Identity is the
//  UUID alone — byte-identical content under two uuids is two legitimate
//  rows (a model may genuinely repeat itself), so content never keys.
// ============================================================================

/** Append `message` to `rows` under the row-identity invariant. Returns a
 *  new array; `rows` is never mutated. */
export function appendRowWithIdentity<Row extends { uuid: string }>(
  rows: readonly Row[],
  message: Row,
): Row[] {
  const at = rows.findIndex(row => row.uuid === message.uuid)
  if (at < 0) return [...rows, message]
  const next = rows.slice()
  next[at] = message
  return next
}
