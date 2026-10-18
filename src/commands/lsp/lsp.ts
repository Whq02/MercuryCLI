import { getInitializationStatus, getLspServerManager, reinitializeLspServerManager, waitForInitialization } from '../../services/lsp/manager.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = 'Usage: `/lsp status` lists the language servers of this workspace · `/lsp restart [<server>]` restarts one of them, or all of them.'

function notRunning(): string {
  const status = getInitializationStatus()
  if (status.status === 'failed') return `The language servers did not start in this session: ${status.error.message}`
  if (status.status === 'pending') return 'The language servers are still starting — ask again in a moment.'
  return 'The language servers are not running in this session.'
}

export const call: LocalCommandCall = async args => {
  const [verb = '', target = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  if (verb === '' || rest.length > 0 || (verb !== 'status' && verb !== 'restart') || (verb === 'status' && target !== '')) {
    return { type: 'text', value: verb === '' ? USAGE : `\`/lsp ${args.trim()}\` is not a verb here. ${USAGE}` }
  }
  const { NO_LSP_SERVERS_CONFIGURED, serverStatusLines } = await import('../../tools/LSPTool/mercuryOps.js')
  const manager = getLspServerManager()
  if (verb === 'status') {
    if (manager === undefined) return { type: 'text', value: notRunning() }
    const lines = serverStatusLines(manager)
    return { type: 'text', value: lines.length === 0 ? NO_LSP_SERVERS_CONFIGURED : lines.join('\n') }
  }
  if (manager === undefined || getInitializationStatus().status === 'not-started') return { type: 'text', value: notRunning() }
  if (target === '') {
    reinitializeLspServerManager()
    await waitForInitialization()
    const fresh = getLspServerManager()
    if (fresh === undefined) return { type: 'text', value: notRunning() }
    const names = [...fresh.getAllServers().keys()]
    const roster = names.length === 0 ? NO_LSP_SERVERS_CONFIGURED : `${names.length} configured — ${names.join(', ')} — each starts on the first file it claims.`
    return { type: 'text', value: `Restarted the language servers of this workspace: ${roster}` }
  }
  const server = manager.getAllServers().get(target)
  if (server === undefined) {
    const names = [...manager.getAllServers().keys()]
    return { type: 'text', value: `No language server named \`${target}\` in this workspace — ${names.length === 0 ? 'none is configured.' : `the roster: ${names.join(', ')}.`}` }
  }
  try {
    await server.restart()
    return { type: 'text', value: `Restarted ${server.name} — ${server.state} (gen ${server.generation}, restarts ${server.restartCount}).` }
  } catch (err) {
    return { type: 'text', value: `${server.name} did not come back: ${err instanceof Error ? err.message : String(err)} — now ${server.state}; \`/lsp status\` shows the roster.` }
  }
}
