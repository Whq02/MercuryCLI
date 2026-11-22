import React, { useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import TextInput from '../TextInput.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { keyHintLabel } from '../mercury-ui/keyHintLabel.js'
import { PermissionDialog } from '../permissions/PermissionDialog.js'
import { PermissionPrompt, type PermissionPromptOption } from '../permissions/PermissionPrompt.js'
import wrapText from '../../ink/wrap-text.js'
import { truncateToWidth } from '../../utils/truncate.js'
import { notBuilt } from '../../pi/holes.js'


type ContractOfferAnswer = 'yes' | 'no'

export const CONTRACT_ASK_BLURB = `a contract is the session's advisory work agreement in your words: the agent acknowledges it without being blocked by it. Yes opens a field to write one before the session starts; No starts the session plain (/contract can add one any time).`
export const CONTRACT_FIELD_BLURB = `the session's advisory work agreement in your words; the agent acknowledges it without being blocked.`
const CONTRACT_ASK_KEYS = '↑↓ choose · ↵ confirm · esc starts it plain'
const CONTRACT_ASK_CHROME_ROWS = 9
const CONTRACT_FIELD_CHROME_ROWS = 9
export const CONTRACT_CARD_MIN_ROWS = 7

type ContractCardFitV1 = {
  askBlurbRows: number | null
  liftMargin: boolean
  askGap: boolean
  fieldBlurbRows: number | null
  fieldLines: number
  fieldGaps: boolean
  fieldLift: boolean
}

export function contractCardTextColumns(width: number): number {
  return Math.max(8, width - 8)
}

export function cappedBlurb(text: string, textColumns: number, rows: number | null): string {
  const lines = wrapText(text, textColumns, 'wrap').split('\n')
  if (rows === null || rows <= 0 || rows >= lines.length) return text
  const kept = lines.slice(0, rows)
  const last = (kept.pop() ?? '').trimEnd()
  return [...kept, truncateToWidth(`${last}…`, textColumns)].join('\n')
}

export function contractCardFit(rows: number, textColumns: number): ContractCardFitV1 {
  const askLines = wrapText(CONTRACT_ASK_BLURB, textColumns, 'wrap').split('\n').length
  const keysRows = wrapText(CONTRACT_ASK_KEYS, textColumns, 'wrap').split('\n').length
  const askChrome = CONTRACT_ASK_CHROME_ROWS + keysRows - 1
  const fieldBlurbLines = wrapText(CONTRACT_FIELD_BLURB, textColumns, 'wrap').split('\n').length
  const visibleLines = Math.max(2, Math.min(6, rows - 11))
  const askBlurbRows = askChrome + askLines <= rows ? null : Math.min(askLines, Math.max(0, rows - askChrome))
  const fieldMin = Math.min(visibleLines, 2)
  const blurbRoom = rows - CONTRACT_FIELD_CHROME_ROWS - fieldMin
  const fieldBlurbRows = blurbRoom >= fieldBlurbLines ? null : Math.max(0, blurbRoom)
  const blurbShown = fieldBlurbRows ?? fieldBlurbLines
  const fieldGaps = CONTRACT_FIELD_CHROME_ROWS + blurbShown + 1 <= rows
  const chrome = fieldGaps ? CONTRACT_FIELD_CHROME_ROWS : CONTRACT_FIELD_CHROME_ROWS - 2
  const fieldLines = Math.max(1, Math.min(visibleLines, rows - chrome - blurbShown))
  const liftMargin = askBlurbRows === 0 && askChrome > rows
  const askGap = !(askBlurbRows === 0 && askChrome - (liftMargin ? 1 : 0) > rows)
  const fieldLift = chrome + blurbShown + fieldLines > rows
  return { askBlurbRows, liftMargin, askGap, fieldBlurbRows, fieldLines, fieldGaps, fieldLift }
}

export function ContractOfferCard(arg0: {
  onAnswer: (contractText: string | null) => void
  width: number
  rows: number
}): React.ReactNode {
  return notBuilt('src/components/concourse/ContractOfferCard.tsx:63')
}
