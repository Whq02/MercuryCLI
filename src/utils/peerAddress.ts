/**
 * Peer address parsing. Kept apart from the peer registry on purpose: the
 * messaging tool parses addresses while tools are enumerated at startup, and
 * the registry's transitive imports (HTTP client, socket layer) must not load
 * that early.
 */
export type PeerScheme = 'uds' | 'bridge' | 'other'

/**
 * `uds:` and `bridge:` are the wire prefixes; a bare leading slash is a
 * pre-prefix sender's socket path and must still route as a socket (as
 * "other" it would fall to teammate-name routing and be lost). There is
 * deliberately no bare-identifier-as-bridge fallback: teammate names are bare
 * identifiers.
 */
export function parseAddress(to: string): { scheme: PeerScheme; target: string } {
  if (to.startsWith('uds:')) return { scheme: 'uds', target: to.slice('uds:'.length) }
  if (to.startsWith('bridge:')) return { scheme: 'bridge', target: to.slice('bridge:'.length) }
  if (to.startsWith('/')) return { scheme: 'uds', target: to }
  return { scheme: 'other', target: to }
}
