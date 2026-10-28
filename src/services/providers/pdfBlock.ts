export function pdfBlockData(block: unknown): string | undefined {
  if (typeof block !== 'object' || block === null || (block as { type?: unknown }).type !== 'document') return undefined
  const source = (block as { source?: { type?: unknown; media_type?: unknown; data?: unknown } }).source
  return source?.type === 'base64' && source.media_type === 'application/pdf' && typeof source.data === 'string' ? source.data : undefined
}
