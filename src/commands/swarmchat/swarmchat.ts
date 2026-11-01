import type { LocalJSXCommandCall } from '../../types/command.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import { swarmMasterEnabled, swarmSessionEnabled, swarmStore } from '../../services/crewBoard/seam.js'

const USAGE = 'usage: /swarmchat [all|team <name>|main] — /swarmchat alone toggles board messages in the chat'

export function runSwarmchatCommand(raw: string): string {
  const words = raw.trim().split(/\s+/).filter(Boolean)
  const verb = words[0] ?? ''
  if (!['', 'all', 'team', 'main'].includes(verb) || words.length > (verb === 'team' ? 2 : 1) || (verb === 'team' && words.length < 2)) return USAGE
  if (!swarmMasterEnabled()) return 'Swarm is off — enable swarm.enabled in your user settings.json (/config → Swarm).'
  const board = swarmSessionEnabled() ? swarmStore() : null
  if (!board) return 'Swarm is off for this session — /swarm on enables it.'
  const chat = board.chat()
  if (verb === '') {
    board.setChat({ on: !chat.on, filter: chat.filter })
    return chat.on ? 'Swarm chat off' : 'Swarm chat on'
  }
  if (verb === 'team') {
    const labels = [...new Set(board.seats().flatMap(seat => (seat.team === undefined ? [] : [seat.team])))]
    const team = labels.find(label => label.toLowerCase() === words[1]!.toLowerCase())
    if (team === undefined) return `No team ${words[1]} on the board${labels.length ? ` — teams: ${labels.join(', ')}` : ''}.`
    board.setChat({ on: true, filter: { kind: 'team', team } })
    return `Swarm chat · team ${team}`
  }
  board.setChat({ on: true, filter: { kind: verb === 'all' ? 'all' : 'main' } })
  return `Swarm chat · ${verb}`
}

export const call: LocalJSXCommandCall = async (onDone, context, raw) => {
  if (!context.options.isNonInteractiveSession && hasFocusedSession()) {
    const receipt = await getFocusedSessionConnector().sendWords(`/swarmchat ${raw.trim()}`.trim())
    onDone(receipt.state === 'refused' ? receipt.detail : undefined, { display: receipt.state === 'refused' ? 'system' : 'skip' })
    return null
  }
  onDone(runSwarmchatCommand(raw))
  return null
}
