import React, { cloneElement, isValidElement } from 'react'
import { ModalContext } from '../../overlays/modalContext.js'
import { Box, Text } from '../../themedRenderer.js'
import { PopupListViewport } from '../../select/popup-list.js'
import type { GlobalConfig } from '../../../platform/settings/config.js'
import type { SettingsJson } from '../../../platform/settings/settingsSchema.js'
import { REACHABLE_THEME_SETTINGS, type ThemeSetting } from '../../theme/theme.js'
import { InteractiveRow } from '../../widgets/InteractiveRow.js'
import { SearchBox } from '../../composer/text-input/SearchBox.js'
import { Select } from '../../select/Select.js'
import { LanguagePicker } from './LanguagePicker.js'
import { ExternalInstructionIncludesDialog } from './ExternalInstructionIncludesDialog.js'
import type { ExternalInstructionInclude } from '../../../sessions/instructions/instructionFiles.js'
import type { crewmateDefaultsOf } from '../../../crew/agents/agentDefaults.js'
import { MercuryModelChoicePicker, modelChoiceLabel, modelChoiceRow } from '../../../commands/model/mercuryModel.js'
import { parseUserSpecifiedModel } from '../../../models/catalogue/engineModel.js'
import { LOCAL_SERVER_APPLY_MENU, LocalServerApplyDialog, type LocalServerConfigState } from '../LocalServer.js'
import { MediaConfigPicker, type useMediaConfig } from '../Media.js'
import type { MercuryThemeTokens } from '../../theme/mercuryTokens.js'
import { CONFIG_SEARCH_PLACEHOLDER, CONFIG_ROW_MARK, configMoreRow, type ConfigListWindow } from './configLayout.js'
import { type SubMenu, CREWMATE_INHERIT_ROW, type SettingsItem, THEME_LABELS } from './configItems.js'

const LABEL_CELLS = 36
function valueOnOneLine(value: React.ReactNode): React.ReactNode {
  return isValidElement<{ wrap?: string }>(value) && value.type === Text && value.props.wrap === undefined ? cloneElement(value, { wrap: 'truncate-end' }) : value
}

export function configSubMenuView({
  subMenu,
  media,
  contentHeight,
  width,
  compact,
  themeSetting,
  setThemeSetting,
  setSubMenu,
  agentDefaults,
  writeAgents,
  recordSet,
  signInFromDoor,
  merged,
  writeSource,
  externalIncludes,
  localServer,
}: {
  subMenu: SubMenu | null
  media: ReturnType<typeof useMediaConfig>
  contentHeight: number
  width: number
  compact: boolean
  themeSetting: ThemeSetting
  setThemeSetting: (setting: ThemeSetting) => void
  setSubMenu: (menu: SubMenu | null) => void
  agentDefaults: ReturnType<typeof crewmateDefaultsOf>
  writeAgents: (patch: Partial<NonNullable<GlobalConfig['agents']>>) => void
  recordSet: (key: string, text: string) => void
  signInFromDoor: () => void
  merged: SettingsJson
  writeSource: (source: 'localSettings' | 'userSettings', partial: Partial<SettingsJson>) => boolean
  externalIncludes: ExternalInstructionInclude[] | undefined
  localServer: LocalServerConfigState
}): React.ReactNode {
  if (subMenu === 'media-root' || subMenu === 'media-image' || subMenu === 'media-video') return <MediaConfigPicker key={subMenu} menu={subMenu} media={media} rows={contentHeight} width={width} onClose={() => setSubMenu(null)} />
  if (subMenu === 'theme') {
    return (
      <Select
        {...(compact ? { visibleOptionCount: Math.max(1, contentHeight) } : {})}
        options={REACHABLE_THEME_SETTINGS.map(setting => ({
          label: THEME_LABELS[setting] ?? setting,
          value: setting,
        }))}
        defaultValue={themeSetting}
        defaultFocusValue={themeSetting}
        onChange={value => {
          setThemeSetting(value)
          setSubMenu(null)
        }}
        onCancel={() => setSubMenu(null)}
      />
    )
  }
  if (subMenu === 'agent-model') {
    return (
      <ModalContext.Provider value={{ rows: contentHeight, columns: width, scrollRef: null }}>
      <MercuryModelChoicePicker
        leading={[CREWMATE_INHERIT_ROW]}
        current={agentDefaults.model === undefined || agentDefaults.model === CREWMATE_INHERIT_ROW.id ? CREWMATE_INHERIT_ROW.id : modelChoiceRow(agentDefaults.model)}
        onSelect={id => {
          const next = id === CREWMATE_INHERIT_ROW.id ? undefined : parseUserSpecifiedModel(id)
          writeAgents({ defaultModel: next })
          recordSet('agentsDefaultModel', `set the crewmate default model to ${next === undefined ? CREWMATE_INHERIT_ROW.name : modelChoiceLabel(next)}`)
          setSubMenu(null)
        }}
        onSignIn={signInFromDoor}
        onClose={() => setSubMenu(null)}
      />
      </ModalContext.Provider>
    )
  }
  if (subMenu === 'language') {
    return (
      <LanguagePicker
        initialLanguage={merged.voice?.language}
        onComplete={language => {
          if (writeSource('userSettings', { voice: { language: language } })) {
            recordSet('language', `set language to ${language ?? 'auto'}`)
          }
          setSubMenu(null)
        }}
        onCancel={() => setSubMenu(null)}
      />
    )
  }
  if (subMenu === 'external-includes') {
    return (
      <ExternalInstructionIncludesDialog
        isStandaloneDialog={false}
        externalIncludes={externalIncludes}
        onDone={() => {
          setSubMenu(null)
        }}
      />
    )
  }
  if (subMenu === LOCAL_SERVER_APPLY_MENU && localServer.plan !== null) {
    return (
      <LocalServerApplyDialog
        plan={localServer.plan}
        width={width}
        rows={contentHeight}
        onDone={() => setSubMenu(null)}
        onApplied={outcome => {
          if (outcome.outcome === 'applied') recordSet('localServer.apply', `applied the local server knobs (${outcome.restarted ? 'server restarted' : 'restart pending'})`)
        }}
      />
    )
  }
  return null
}

export function configListView({
  filtered,
  win,
  windowFor,
  width,
  searchRowUp,
  query,
  searchMode,
  compact,
  tokens,
  setSearchMode,
  moveTo,
  activate,
}: {
  filtered: SettingsItem[]
  win: ConfigListWindow
  windowFor: (index: number) => number
  width: number
  searchRowUp: boolean
  query: string
  searchMode: boolean
  compact: boolean
  tokens: MercuryThemeTokens
  setSearchMode: (on: boolean) => void
  moveTo: (next: number) => void
  activate: (index: number) => void
}): React.ReactNode {
  const visible = filtered.slice(win.off, win.off + windowFor(win.sel))
  const band = width + 2 - (win.off > 0 || win.hiddenBelow > 0 ? 1 : 0)

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Box height={searchRowUp ? 1 : 0} overflow="hidden">
        <SearchBox
          query={query}
          isFocused={searchMode}
          isTerminalFocused={true}
          cursorOffset={query.length}
          placeholder={CONFIG_SEARCH_PLACEHOLDER}
          borderless={true}
        />
      </Box>
      <Box height={compact ? 0 : 1} />
      <PopupListViewport above={win.off} below={win.hiddenBelow} rows={visible.length}>
      {visible.map((item, index) => {
        const at = win.off + index
        const isSelected = !searchMode && at === win.sel
        return (
          <Box key={item.id} flexDirection="column" flexShrink={0}>
            <Box width={band} marginLeft={-1} marginRight={-1} flexShrink={0}>
              <InteractiveRow
                id={`config:row:${item.id}`}
                selected={isSelected}
                onSelect={() => {
                  setSearchMode(false)
                  moveTo(at)
                }}
                onActivate={() => activate(at)}
                width={band}
                height={1}
                flexShrink={0}
              >
                <Box width={1} flexShrink={0} />
                <Box width={LABEL_CELLS} flexShrink={0}>
                  <Text
                    bold={isSelected}
                    color={isSelected ? tokens.textPrimary : tokens.textSecondary}
                    wrap="truncate-end"
                  >
                    {isSelected ? `${CONFIG_ROW_MARK} ` : '  '}
                    {item.label}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} minWidth={0} height={1} overflow="hidden">
                  {valueOnOneLine(item.value)}
                </Box>
                <Box width={1} flexShrink={0} />
              </InteractiveRow>
            </Box>
            {isSelected && !compact && item.warning !== undefined ? (
              <Text color={tokens.warning}>{'  '}{item.warning}</Text>
            ) : null}
          </Box>
        )
      })}
      </PopupListViewport>
      {filtered.length === 0 ? (
        <Box height={1}>
          <Text color={tokens.textMuted}>no settings match “{query}”</Text>
        </Box>
      ) : null}
      <Box height={compact ? 0 : 1} overflow="hidden">
        <Text color={tokens.textMuted}>{configMoreRow(win.hiddenBelow)}</Text>
      </Box>
    </Box>
  )
}
