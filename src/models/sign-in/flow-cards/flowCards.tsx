import React from 'react'
import { Box, Text } from '../../../screen/themedRenderer.js'
import wrapText from '../../../screen/renderer/wrap-text.js'
import { Select } from '../../../screen/select/index.js'
import TextInput from '../../../screen/composer/text-input/TextInput.js'
import { PopupFormContext, PopupCompactContext } from '../../../screen/overlays/popupFormContext.js'
import { familyDisplayName } from '../../roads/accountSlots.js'
import { collectLoginsScreenFacts, loginsArmSlots, loginsCatalogue, loginsRowStateOf } from '../../../screen/boot-face/BootLoginsScreen.js'
import { mostRecentSignInFamily } from '../../catalogue/computedDefault.js'
import { type useAnthropicLoginModel, waitingHeadline, type AnthropicFlowState } from '../../../screen/widgets/faces/anthropicLoginModel.js'
import type { LoginFamilyRow } from './loginFamilyRows.js'
import { SignInCopyLine } from './SignInCopyLine.js'
import { loginFamilyFocusFor, loginFamilyInitialFocus, signInLaterRow, type LoginFamilyValue, type TensorFoldOffer } from './loginFamilyRows.js'
import type { localDiscoverySummary } from '../../roads/local/localCatalogue.js'
import type { MercuryThemeTokens } from '../../../screen/theme/mercuryTokens.js'
import { SuccessEnterConfirms, ErrorEnterRetries } from './enterKeys.js'
import { MORE_BELOW_ROW } from './readiness.js'

export type LoginFamilyFocus = LoginFamilyRow['value']

export type SignInCardFit = { introLines: number; roster: number }

export function signInCardFit(input: { bodyRows: number; textWidth: number; intro: string; rosterRows: number }): SignInCardFit {
  const introLines = wrapText(input.intro, Math.max(1, input.textWidth), 'wrap').split('\n').length
  const fixed = 1 + 1 + 1 + introLines + 1 + 1
  const forRoster = input.bodyRows - fixed
  if (forRoster < input.rosterRows) return { introLines, roster: Math.max(1, forRoster - 2) }
  return { introLines, roster: input.rosterRows }
}

export function idleCard({
  frame,
  compact,
  familyRows,
  onSkip,
  localRoad,
  initialFocus,
  popup,
  setupBody,
  startingMessage,
  columns,
  rows,
  popupFrame,
  menuFocus,
  rosterVisibleTo,
  tensorfold,
  setMenuFocus,
  setRosterVisibleTo,
  setAccountFamily,
  startFamily,
  onCancel,
}: {
  frame: (children: React.ReactNode) => React.ReactNode
  compact: boolean
  familyRows: LoginFamilyRow[]
  onSkip: (() => void) | undefined
  localRoad: ReturnType<typeof localDiscoverySummary> | null
  initialFocus: LoginFamilyFocus | undefined
  popup: boolean
  setupBody: { rows: number; width: number } | null
  startingMessage: string | undefined
  columns: number
  rows: number
  popupFrame: { width: number; rows: number } | null
  menuFocus: number
  rosterVisibleTo: number | null
  tensorfold: TensorFoldOffer | null | undefined
  setMenuFocus: React.Dispatch<React.SetStateAction<number>>
  setRosterVisibleTo: React.Dispatch<React.SetStateAction<number | null>>
  setAccountFamily: React.Dispatch<React.SetStateAction<LoginFamilyValue | null>>
  startFamily: (value: string) => void
  onCancel: (() => void) | undefined
}): React.ReactNode {
  const idleRows = [
    ...familyRows,
    ...(onSkip !== undefined ? [signInLaterRow(localRoad)] : []),
  ]
  const recordedFocus = loginFamilyFocusFor(mostRecentSignInFamily())
  const defaultFocus = loginFamilyInitialFocus(idleRows, recordedFocus, initialFocus)
  const facts = popup ? collectLoginsScreenFacts() : null
  const arms = popup ? loginsCatalogue() : []
  const intro = startingMessage ?? 'Choose a provider to sign in.'
  const refusalLayout = popup && facts !== null && Object.keys(facts.refusals ?? {}).length > 0
  const rosterCompact = compact || refusalLayout
  const fit =
    !compact && setupBody !== null
      ? signInCardFit({ bodyRows: setupBody.rows, textWidth: setupBody.width - 4, intro, rosterRows: idleRows.length })
      : { introLines: 0, roster: idleRows.length }
  const rowHeight = !compact && setupBody !== null
    ? Math.max(...idleRows.map(row => wrapText(row.label, Math.max(1, setupBody.width - 6), 'wrap').split('\n').length))
    : 1
  const focusedArm = arms.find(arm => arm.row.value === idleRows[menuFocus]?.value)
  const focusedState = facts && focusedArm ? loginsRowStateOf(focusedArm, facts) : null
  const refusalText = rosterCompact && focusedState?.refusal ? focusedState.chip : null
  const refusalRows = refusalText ? wrapText(refusalText, Math.max(1, popupFrame ? popupFrame.width - 4 : columns), 'wrap').split('\n').length : 0
  const singleLineRows = !rosterCompact && setupBody !== null && fit.roster < rowHeight
  const rosterWindow = rosterCompact ? Math.max(1, Math.min(rows - refusalRows, idleRows.length)) : Math.max(1, Math.floor(fit.roster / (singleLineRows ? 1 : rowHeight)))
  const rosterHidden = Math.max(0, idleRows.length - (rosterVisibleTo ?? Math.min(idleRows.length, rosterWindow)))
  const renderMenu = refusalLayout ? (children: React.ReactNode) => children : frame
  return renderMenu(
    <Box flexDirection="column" gap={rosterCompact ? 0 : 1}>
      {rosterCompact ? null : <Text>{intro}</Text>}
      <PopupFormContext.Provider value={popup || singleLineRows}>
      <PopupCompactContext.Provider value={{ compact: rosterCompact || singleLineRows, setMarker: () => {} }}>
      <Select
        key={tensorfold ? 'tensorfold' : 'roster'}
        hideIndexes
        disableSelection="numeric"
        visibleOptionCount={rosterWindow}
        defaultFocusValue={defaultFocus}
        layout={popup ? 'compact-vertical' : 'compact'}
        options={idleRows.map(row => {
          const arm = arms.find(candidate => candidate.row.value === row.value)
          const status = facts && arm ? loginsRowStateOf(arm, facts) : null
          if (rosterCompact && status?.refusal && arm) return { ...row, label: `${familyDisplayName(arm.familyId)} · refused (HTTP ${status.refusal.status})` }
          if (rosterCompact) return status && (status.signedIn || status.loud) ? { ...row, label: `${row.label} · ${status.chip}` } : row
          return { ...row, ...(status && (status.signedIn || status.loud) ? { description: status.chip } : {}) }
        })}
        onFocus={value => setMenuFocus(Math.max(0, idleRows.findIndex(row => row.value === value)))}
        onVisibleWindowChange={(_, to) => setRosterVisibleTo(to)}
        onChange={value => {
          const arm = arms.find(candidate => candidate.row.value === value)
          if (facts && arm && !arm.row.value.startsWith('compat/') && loginsArmSlots(arm, facts.groups.find(group => group.family.id === arm.familyId)).length > 0) {
            setAccountFamily(arm.row.value as LoginFamilyValue)
            return
          }
          startFamily(value)
        }}
        onCancel={onCancel}
      />
      </PopupCompactContext.Provider>
      </PopupFormContext.Provider>
      {refusalText ? <Text>{refusalText}</Text> : null}
      {!rosterCompact && rosterWindow < idleRows.length && rosterHidden > 0 ? <Text dimColor>{MORE_BELOW_ROW(rosterHidden)}</Text> : null}
    </Box>,
  )
}

export function waitingCard({
  state,
  frame,
  compact,
  model,
  columns,
  tokens,
  pastePromptUp,
  copied,
  copyNote,
  code,
  setCode,
  submitCode,
  codeCursor,
  setCodeCursor,
}: {
  state: Extract<AnthropicFlowState, { name: 'waiting' }>
  frame: (children: React.ReactNode) => React.ReactNode
  compact: boolean
  model: ReturnType<typeof useAnthropicLoginModel>
  columns: number
  tokens: MercuryThemeTokens
  pastePromptUp: boolean
  copied: boolean
  copyNote: string | null
  code: string
  setCode: (next: string) => void
  submitCode: (raw: string) => void
  codeCursor: number
  setCodeCursor: React.Dispatch<React.SetStateAction<number>>
}): React.ReactNode {
  const promptLabel = 'Paste code here if prompted > '
  const inputColumns = Math.max(10, columns - promptLabel.length - 1)
  const headline = waitingHeadline(model)
  return frame(
    <Box flexDirection="column" gap={compact ? 0 : 1}>
      {compact ? (
        headline.warns ? <Text color={tokens.warning} wrap="wrap">{headline.words}</Text> : null
      ) : (
        <Text color={headline.warns ? tokens.warning : undefined} wrap="wrap">
          {headline.words}
          {state.forcedMethod
            ? ` (login method pre-selected: ${state.forcedMethod})`
            : ''}
        </Text>
      )}
      {pastePromptUp ? (
        <Box flexDirection="column" gap={compact ? 0 : 1}>
          {compact ? (
            <Text dimColor wrap={copyNote === null ? 'truncate-end' : 'wrap'}>{state.url}</Text>
          ) : (
            <Text dimColor wrap="wrap">
              Browser did not open? Use this URL:{'\n'}
              {state.url}
            </Text>
          )}
          {copied || copyNote !== null ? (
            <SignInCopyLine said={{ copied, copyNote }} />
          ) : compact ? null : (
            <Text dimColor>press c to copy the URL</Text>
          )}
          <Box>
            <Text>{promptLabel}</Text>
            <TextInput
              value={code}
              onChange={setCode}
              onSubmit={submitCode}
              mask="*"
              columns={inputColumns}
              cursorOffset={codeCursor}
              onChangeCursorOffset={setCodeCursor}
            />
          </Box>
          {compact ? <Text dimColor>c copies the URL · esc cancels</Text> : null}
        </Box>
      ) : null}
    </Box>,
  )
}

export function successCard({
  state,
  frame,
  compact,
  onDone,
  tokens,
  setupToken,
  accountLabel,
  shadowWarning,
}: {
  state: Extract<AnthropicFlowState, { name: 'success' }>
  frame: (children: React.ReactNode) => React.ReactNode
  compact: boolean
  onDone: () => void
  tokens: MercuryThemeTokens
  setupToken: boolean
  accountLabel: string | null
  shadowWarning: string | null
}): React.ReactNode {
  if (setupToken && state.token !== undefined) {
    return frame(
      <Box flexDirection="column" gap={compact ? 0 : 1}>
        <Text color={tokens.success}>Token created. It is valid for one year.</Text>
        <Text bold>{state.token}</Text>
        <Text color={tokens.warning}>
          It will not be shown again — store it now.
        </Text>
        <Text dimColor>
          Export it as MERCURY_OAUTH_TOKEN to use it.
        </Text>
      </Box>,
    )
  }
  return frame(
    <Box flexDirection="column" gap={compact ? 0 : 1}>
      <SuccessEnterConfirms onDone={onDone} />
      <Text color={tokens.success}>
        Signed in{accountLabel !== null ? ` as ${accountLabel}` : ''}.
      </Text>
      {state.warning !== undefined ? (
        <Text color={tokens.warning}>{state.warning}</Text>
      ) : null}
      {shadowWarning !== null ? (
        <Text color={tokens.warning}>{shadowWarning}</Text>
      ) : null}
      <Text dimColor>press Enter to continue</Text>
    </Box>,
  )
}

export function errorCard({
  state,
  frame,
  compact,
  model,
  tokens,
  setCode,
  setCodeCursor,
}: {
  state: Extract<AnthropicFlowState, { name: 'error' }>
  frame: (children: React.ReactNode) => React.ReactNode
  compact: boolean
  model: ReturnType<typeof useAnthropicLoginModel>
  tokens: MercuryThemeTokens
  setCode: (next: string) => void
  setCodeCursor: React.Dispatch<React.SetStateAction<number>>
}): React.ReactNode {
  return frame(
    <Box flexDirection="column" gap={compact ? 0 : 1}>
      <ErrorEnterRetries
        hasRetry={state.retry !== undefined}
        onRetry={() => {
          setCode('')
          setCodeCursor(0)
          model.retry()
        }}
      />
      <Text color={tokens.failureText}>{state.message}</Text>
      {state.retry !== undefined ? (
        <Text dimColor>press Enter to retry</Text>
      ) : null}
    </Box>,
  )
}
