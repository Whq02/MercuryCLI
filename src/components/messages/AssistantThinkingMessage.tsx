import React from 'react'
import { Box } from '../../ink.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { Markdown } from '../Markdown.js'
import { THINKING_COLOR, ThinkingLabel, WITHHELD_THINKING_WORDS } from './thinkingGrammar.js'
import { notBuilt } from '../../pi/holes.js'

export function thinkingTextWithheld(param: { thinking?: string; signature?: string }): boolean {
  return (param.thinking ?? '') === '' && typeof param.signature === 'string' && param.signature !== ''
}

export function AssistantThinkingMessage(arg0: {
  param: { type?: string; thinking?: string; signature?: string }
  addMargin?: boolean
  verbose?: boolean
  isTranscriptMode?: boolean
  hideInTranscript?: boolean
}): React.ReactNode {
  return notBuilt('src/components/messages/AssistantThinkingMessage.tsx:12')
}

export default AssistantThinkingMessage
