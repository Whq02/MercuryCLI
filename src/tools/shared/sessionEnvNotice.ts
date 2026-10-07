export function scrubbedSessionEnvNotice(scrubbed: readonly string[] | undefined): string {
  if (scrubbed === undefined || scrubbed.length === 0) return ''
  return `[session env scrubbed: ${scrubbed.join(', ')} — Mercury's own stamps, not the operator's; inherit_session_env: true keeps them]`
}

export function shortScrubbedSessionEnvNotice(named: readonly string[]): string {
  if (named.length === 0) return ''
  return `[session env scrubbed: ${named.join(', ')}]`
}

let fullSessionEnvNoticeShown = false

export function sessionEnvNoticeForResult(args: {
  scrubbed: readonly string[] | undefined
  commandText: string | undefined
}): string {
  const scrubbed = args.scrubbed
  if (scrubbed === undefined || scrubbed.length === 0) return ''
  if (!fullSessionEnvNoticeShown) {
    fullSessionEnvNoticeShown = true
    return scrubbedSessionEnvNotice(scrubbed)
  }
  const text = args.commandText ?? ''
  const named = scrubbed.filter(name => text.includes(name))
  return shortScrubbedSessionEnvNotice(named)
}

export function resetSessionEnvNoticeOnCompaction(): void {
  fullSessionEnvNoticeShown = false
}

export function resetSessionEnvNoticeForTesting(): void {
  fullSessionEnvNoticeShown = false
}
