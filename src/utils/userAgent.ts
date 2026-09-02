
export function getMercuryUserAgent(): string {
  return `mercury/${MACRO.VERSION}`
}

export function getAnthropicClientUserAgent(): string {
  return getMercuryUserAgent()
}
