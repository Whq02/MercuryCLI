
const CONNECTOR_NAME_PREFIX = 'claude.ai '

export function normalizeNameForMCP(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (!name.startsWith(CONNECTOR_NAME_PREFIX)) return normalized
  return normalized.replace(/_+/g, '_').replace(/^_+/, '').replace(/_+$/, '')
}
