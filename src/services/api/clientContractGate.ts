export function clientContractGateText(text: string): boolean {
  return (
    (text.includes('does not support this model') && text.includes('or newer is required')) ||
    text.includes('claude_code_version_too_old')
  )
}
