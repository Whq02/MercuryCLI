import * as React from 'react'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { PromptsPanel } from '../../components/prompts-panel/PromptsPanel.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import { saveSwarmSwitch } from '../../utils/sessionStorage/logs.js'
import { closeIdleSwarm, setSwarmUncapped, swarmMasterEnabled, swarmSessionEnabled, swarmStore } from '../../services/crewBoard/seam.js'

export function runSwarmCommand(raw: string): string {
  const op = raw.trim().toLowerCase()
  if (!['', 'on', 'off', 'uncap', 'cap', 'status'].includes(op)) return 'usage: /swarm on|off|uncap|cap|status — /swarm opens Crew chat'
  if (!swarmMasterEnabled()) {
    if (op === 'off') saveSwarmSwitch(false)
    return 'Swarm is off — enable swarm.enabled in your user settings.json (/config → Swarm).'
  }
  if (op === 'on' || op === 'off') saveSwarmSwitch(op === 'on')
  if (op === 'off') closeIdleSwarm()
  const off = 'Swarm off for new crewmates — existing board crewmates keep their board; /swarm on enables it.'
  if (!swarmSessionEnabled() && !['uncap', 'cap', 'status'].includes(op)) return off
  try {
    const board = swarmStore()
    if (!board) return off
    if (op === 'uncap' || op === 'cap') setSwarmUncapped(op === 'uncap')
    if (op === 'on' && board.chat().on) board.setChat(board.chat())
    const words = (value: number): string => board.uncapped || value === 0 ? 'no limit' : value.toLocaleString('en-US')
    return `Swarm ${swarmSessionEnabled() ? 'on' : 'off'} for new crewmates — board context ${words(board.limits.seatAllowance)} per agent, ${words(board.limits.waveAllowance)} per wave; ${board.uncapped || board.limits.postChars === 0 ? 'no limit per post' : `${words(board.limits.postChars)} characters per post`}${board.uncapped ? '; /swarm uncap is on' : ''}; ${board.limits.postsPerMinute} posts/min, ${board.limits.postsPerSeat} posts per seat.`
  } catch (error) {
    saveSwarmSwitch(false)
    return `Swarm could not open: ${error instanceof Error ? error.message : String(error)}`
  }
}

export const call: LocalJSXCommandCall = async (onDone, context, raw) => {
  if (!context.options.isNonInteractiveSession && hasFocusedSession()) {
    const connector = getFocusedSessionConnector()
    if (!raw.trim() && connector.swarmBoard?.()?.on) return React.createElement(PromptsPanel, { initialSection: 'crew', onClose: () => onDone(undefined, { display: 'skip' }) })
    if (['on', 'off', 'uncap', 'cap', 'status'].includes(raw.trim().toLowerCase())) {
      const receipt = await connector.sendWords(`/swarm ${raw.trim().toLowerCase()}`)
      onDone(receipt.state === 'refused' ? receipt.detail : undefined, { display: receipt.state === 'refused' ? 'system' : 'skip' })
      return null
    }
  }
  onDone(runSwarmCommand(raw))
  return null
}
