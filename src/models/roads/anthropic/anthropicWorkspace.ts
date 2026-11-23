export const ANTHROPIC_WORKSPACE_PROMPT = 'Enter your Anthropic workspace ID from Console → Settings → Workspaces.'
export const ANTHROPIC_WORKSPACE_FIX = 'Open /logins → Anthropic → API key and enter the key’s workspace ID from Console → Settings → Workspaces.'

export function needsAnthropicWorkspace(message: string): boolean {
  return /anthropic-workspace-id/i.test(message) && /not scoped|must include|required/i.test(message)
}
