export function scrubbedSessionEnvNotice(scrubbed: readonly string[] | undefined): string {
  if (scrubbed === undefined || scrubbed.length === 0) return ''
  return `[session env scrubbed from this command: ${scrubbed.join(', ')} — the values Mercury stamped on this session, not the operator's; pass inherit_session_env: true to hand them to a command]`
}
