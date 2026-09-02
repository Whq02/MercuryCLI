export type PeerScheme = 'uds' | 'bridge' | 'other'

export function parseAddress(to: string): { scheme: PeerScheme; target: string } {
  if (to.startsWith('uds:')) return { scheme: 'uds', target: to.slice('uds:'.length) }
  if (to.startsWith('bridge:')) return { scheme: 'bridge', target: to.slice('bridge:'.length) }
  if (to.startsWith('/')) return { scheme: 'uds', target: to }
  return { scheme: 'other', target: to }
}
