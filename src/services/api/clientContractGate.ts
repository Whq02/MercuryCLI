export function clientContractGateText(text: string): boolean {
  return (
    (text.includes('does not support this model') && text.includes('or newer is required')) ||
    text.includes('claude_code_version_too_old')
  )
}

export function isClientContractRefusalError(error: unknown): boolean {
  const record = error as { status?: unknown; message?: unknown } | null
  return record?.status === 400 && typeof record.message === 'string' && clientContractGateText(record.message)
}
