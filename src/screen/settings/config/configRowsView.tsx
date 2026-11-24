import { Text } from '../../themedRenderer.js'
import { DUCKDUCKGO_SETTING_KEY, DUCKDUCKGO_SETTING_LABEL, DUCKDUCKGO_TERMS, duckduckgoScrapingEnabled, duckduckgoScrapingPinned } from '../../../tools/engines/web-search/searchSetting.js'
import { formatTokens } from '../../../platform/text/format.js'
import { isFullscreenActive } from '../../fullscreen-layout/fullscreen.js'
import screenInstances from '../../renderer/instances.js'
import { stripFacts } from '../../routes/surfaceRoute.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../../engine/connector/focusedConnector.js'
import { SEAT_DOORS, seatCeilingValueWords, seatCostWarning, setOperatorSeats, type SeatCeilingFacts } from '../../../daemon/switchboard-capacity/capacityCheck.js'
import { MOTION_DOORS, MOTION_SETTINGS, motionDetailLines, motionValueWords, readMotionSetting, setMotionSetting } from '../../cockpit/motionSetting.js'
import { settingsChangeDetector } from '../../../platform/settings/changeDetector.js'
import { jevSessionFacts, jevSessionStatus } from '../../../models/jev/jevSessionFacts.js'
import { jevSettingLines, jevValueWords, readJevSettings, setJevEnabled } from '../../../models/jev/jevSetting.js'
import { jevStatusLine } from '../../../models/jev/jevStatus.js'
import { type SettingsItem, cycleIn, type ConfigRowKit } from './configItems.js'

export function configFoldRows({ config, tokens, boolValue, writeGlobal, recordToggle, recordSet }: ConfigRowKit): SettingsItem[] {
  const items: SettingsItem[] = []
  items.push({
    id: 'autoCompact',
    label: 'Auto-compact',
    kind: 'boolean',
    setByYou: config.autoCompactEnabled === false,
    value: boolValue(config.autoCompactEnabled !== false),
    change: () => {
      writeGlobal(c => ({ ...c, autoCompactEnabled: c.autoCompactEnabled === false }))
      recordToggle('autoCompact', `set auto-compact to ${config.autoCompactEnabled === false ? 'on' : 'off'}`)
    },
  })
  const WINDOW_RUNGS: ReadonlyArray<number | undefined> = [undefined, 100_000, 200_000, 500_000, 1_000_000]
  const windowIdx = Math.max(0, WINDOW_RUNGS.findIndex(rung => rung === config.autoCompactWindow))
  const windowWords = (rung: number | undefined): string => (rung === undefined ? 'auto' : formatTokens(rung))
  items.push({
    id: 'autoCompactWindow',
    label: 'Auto-compact window',
    searchText: 'auto compact window context tokens condense threshold',
    kind: 'enum',
    setByYou: config.autoCompactWindow !== undefined,
    value: <Text>{windowWords(WINDOW_RUNGS[windowIdx])}</Text>,
    warning: `the window auto-compact aims for; ${windowIdx === 0 ? 'auto picks one tuned to the model' : 'a manual override can cost more tokens on long sessions'}`,
    change: direction => {
      const nextIdx = Math.min(WINDOW_RUNGS.length - 1, Math.max(0, windowIdx + (direction > 0 ? 1 : -1)))
      if (nextIdx === windowIdx) return
      const next = WINDOW_RUNGS[nextIdx]
      writeGlobal(c => ({ ...c, autoCompactWindow: next }))
      recordSet('autoCompactWindow', `set the auto-compact window to ${windowWords(next)}`)
    },
  })
  const world = stripFacts()
  items.push({
    id: 'concourse',
    label: 'Session concourse',
    searchText: 'session concourse live view concourse-off chat plain world',
    kind: 'boolean',
    setByYou: config.concourseEnabled === false,
    value: world.chatBoot ? (
      <Text>
        {boolValue(config.concourseEnabled !== false)}
        <Text color={tokens.textSecondary}> · off this boot (--chat)</Text>
      </Text>
    ) : (
      boolValue(config.concourseEnabled !== false)
    ),
    ...(world.chatBoot
      ? { warning: 'this boot is --chat: the plain world whatever the switch says — the switch governs the next plain `mercury` boot' }
      : {}),
    change: () => {
      const next = config.concourseEnabled === false
      writeGlobal(c => ({ ...c, concourseEnabled: next }))
      recordToggle('concourse', `set the session concourse to ${next ? 'on' : 'off (live view only)'}`)
    },
  })
  return items
}

export function configViewRows({ config, merged, tokens, boolValue, writeGlobal, writeSource, recordToggle, recordSet, bump, seatFacts, setSeatFacts }: ConfigRowKit & {
  seatFacts: SeatCeilingFacts | null
  setSeatFacts: (facts: SeatCeilingFacts | null) => void
}): SettingsItem[] {
  const items: SettingsItem[] = []
  const seatWarning = seatFacts === null ? null : seatCostWarning(seatFacts)
  items.push({
    id: 'seats',
    label: 'Seats',
    searchText: 'seats seat ceiling capacity concurrency sessions crewmates in flight',
    kind: 'enum',
    value: <Text>{seatFacts === null ? 'reading capacity…' : seatCeilingValueWords(seatFacts)}</Text>,
    setByYou: seatFacts !== null && seatFacts.source === 'operator',
    warning: seatFacts === null ? 'reading capacity…' : seatWarning !== null ? seatWarning : `a seat is one model call in flight; ${seatFacts.readingSentence} · ←/→ move the ceiling by one · doors: ${SEAT_DOORS}`,
    change: direction => {
      if (seatFacts === null) return
      const next = direction > 0 ? seatFacts.seats + 1 : Math.max(1, seatFacts.seats - 1)
      const after = setOperatorSeats(next, writeGlobal)
      setSeatFacts(after)
      recordSet('seats', `set the seat ceiling to ${after.seats}`)
      bump()
    },
  })
  items.push({
    id: 'tips',
    label: 'Tips',
    kind: 'boolean',
    setByYou: merged.activity?.tips?.enabled !== undefined,
    value: boolValue(merged.activity?.tips?.enabled !== false),
    change: () => {
      const next = merged.activity?.tips?.enabled === false
      if (writeSource('localSettings', { activity: { tips: { enabled: next ? undefined : false } } })) {
        recordToggle('tips', `set tips to ${next ? 'on' : 'off'}`)
        bump()
      }
    },
  })
  items.push({
    id: 'reducedMotion',
    label: 'Reduced motion',
    kind: 'boolean',
    setByYou: merged.view?.reducedMotion !== undefined,
    value: boolValue(merged.view?.reducedMotion === true),
    change: () => {
      const next = merged.view?.reducedMotion !== true
      if (writeSource('localSettings', { view: { reducedMotion: next ? true : undefined } })) {
        recordToggle('reducedMotion', `set reduced motion to ${next ? 'on' : 'off'}`)
        bump()
      }
    },
  })
  items.push({
    id: 'ping',
    label: 'Ping',
    searchText: 'ping terminal bell iterm2 notification turn finished away',
    kind: 'boolean',
    setByYou: merged.view?.ping !== undefined,
    value: boolValue(merged.view?.ping !== false),
    warning: 'Notify when a turn finishes while you are away: iTerm2 notification or terminal bell.',
    change: () => {
      const next = merged.view?.ping === false
      if (writeSource('userSettings', { view: { ping: next ? undefined : false } })) {
        recordToggle('ping', `set the ping to ${next ? 'on' : 'off'}`)
        bump()
      }
    },
  })
  items.push({
    id: 'accountIdentity',
    label: 'Account identity',
    searchText: 'account identity email address username key tail hide hidden shown recording privacy',
    kind: 'boolean',
    setByYou: merged.view?.accountIdentity !== undefined,
    value: (
      <Text color={merged.view?.accountIdentity !== false ? tokens.success : tokens.textSecondary}>
        {merged.view?.accountIdentity !== false ? 'shown' : 'hidden'}
      </Text>
    ),
    warning: 'Hide addresses, usernames and key tails for recording. Logins, /accounts and /health still show them.',
    change: () => {
      const next = merged.view?.accountIdentity === false
      if (writeSource('userSettings', { view: { accountIdentity: next ? undefined : false } })) {
        recordToggle('accountIdentity', `set account identity to ${next ? 'shown' : 'hidden'}`)
        bump()
      }
    },
  })
  items.push({
    id: 'zen',
    label: 'Zen mode — rails hidden',
    searchText: 'zen mode rails hidden lanes vitals full width chat',
    kind: 'boolean',
    setByYou: merged.view?.zen !== undefined,
    value: boolValue(merged.view?.zen === true),
    warning: 'Hide the side rails for full-width chat. /zen also toggles this.',
    change: () => {
      const next = merged.view?.zen !== true
      if (!writeSource('userSettings', { view: { zen: next ? true : undefined } })) return
      settingsChangeDetector.notifyChange('userSettings')
      recordToggle('zen', `set zen mode to ${next ? 'on' : 'off'}`)
      bump()
    },
  })
  {
    const motionSetting = readMotionSetting()
    items.push({
      id: 'motion',
      label: 'Motion',
      kind: 'enum',
      setByYou: motionSetting !== 'auto',
      value: <Text>{motionValueWords(motionSetting)}</Text>,
      warning: `${motionDetailLines().slice(0, 2).join(' · ')} · auto = full until painting falls behind, then reduced · full never reduces · reduced slows the clock and stills the critter · off stops idle motion · doors: ${MOTION_DOORS}`,
      change: direction => {
        const next = cycleIn(MOTION_SETTINGS, motionSetting, direction)
        setMotionSetting(next, writeGlobal)
        recordSet('motion', `set motion to ${next}`)
        bump()
      },
    })
  }
  {
    const enabled = duckduckgoScrapingEnabled()
    const pinned = duckduckgoScrapingPinned()
    items.push({
      id: DUCKDUCKGO_SETTING_KEY,
      label: DUCKDUCKGO_SETTING_LABEL,
      searchText: 'web search keyless DuckDuckGo page scraping terms',
      kind: 'boolean',
      setByYou: config.duckduckgoScraping !== undefined || pinned,
      value: <Text>{enabled ? 'on' : 'off'}{pinned ? ' · set by env' : ''}</Text>,
      warning: `on by default; off keeps general queries to the official sources and your keys · ${DUCKDUCKGO_TERMS}${pinned ? ' · MERCURY_SEARCH_KEYLESS decides this process; change that environment variable to change the effective value' : ''}`,
      change: () => {
        if (pinned) return
        writeGlobal(current => ({ ...current, [DUCKDUCKGO_SETTING_KEY]: !enabled }))
        recordToggle(DUCKDUCKGO_SETTING_KEY, `set ${DUCKDUCKGO_SETTING_LABEL} ${enabled ? 'off' : 'on'}`)
        bump()
      },
    })
  }
  {
    const jevSettings = readJevSettings()
    items.push({
      id: 'jev',
      label: 'JEV',
      searchText: 'jev typesafe official openrouter road second opinion jeveval eval tool key allowance pace ceiling crewmates',
      kind: 'boolean',
      setByYou: jevSettings.enabled,
      value: <Text color={jevSettings.enabled ? tokens.success : tokens.textSecondary}>{jevValueWords(jevSettings)}</Text>,
      warning: [jevStatusLine(jevSessionStatus(jevSessionFacts(), jevSettings)), ...jevSettingLines(jevSettings)].join(' · '),
      change: () => {
        const next = !jevSettings.enabled
        setJevEnabled(next, undefined, writeGlobal)
        recordToggle('jev', `set JEV to ${jevValueWords({ ...jevSettings, enabled: next })}`)
        bump()
      },
    })
  }
  return items
}

export function configSessionRows({ config, tokens, boolValue, writeGlobal, recordToggle }: ConfigRowKit): SettingsItem[] {
  const items: SettingsItem[] = []
  {
    items.push({
      id: 'fileCheckpointing',
      label: 'File checkpointing',
      kind: 'boolean',
      setByYou: config.fileCheckpointingEnabled === false,
      value: boolValue(config.fileCheckpointingEnabled !== false),
      change: () => {
        writeGlobal(c => ({ ...c, fileCheckpointingEnabled: c.fileCheckpointingEnabled === false }))
        recordToggle('fileCheckpointing', `set file checkpointing to ${config.fileCheckpointingEnabled === false ? 'on' : 'off'}`)
      },
    })
    const facts = getFocusedSessionConnector().checkpointFacts()
    const points = facts.restorable.size
    const sessionText = !hasFocusedSession()
      ? 'no chat open'
      : facts.capture === 'on'
        ? `capturing · ${points} restore point${points === 1 ? '' : 's'}`
        : facts.capture === 'off'
          ? 'not capturing in this session'
          : "not reported — this session started before checkpoint capture (start a new session when ready)"
    items.push({
      id: 'fileCheckpointsSession',
      label: 'Checkpoints in this session',
      searchText: 'checkpoints session rewind restore points capture',
      kind: 'info',
      value: <Text color={facts.capture === 'on' ? tokens.success : tokens.textSecondary}>{sessionText}</Text>,
    })
  }
  if (isFullscreenActive()) {
    items.push({
      id: 'copyOnSelect',
      label: 'Copy on select',
      kind: 'boolean',
      setByYou: config.copyOnSelect === false,
      value: boolValue(config.copyOnSelect !== false),
      change: () => {
        writeGlobal(c => ({ ...c, copyOnSelect: c.copyOnSelect === false }))
        recordToggle('copyOnSelect', `set copy-on-select to ${config.copyOnSelect === false ? 'on' : 'off'}`)
      },
    })
    items.push({
      id: 'mouseCapture',
      label: 'Mouse capture',
      kind: 'boolean',
      setByYou: config.mouseCapture === false,
      value: boolValue(config.mouseCapture !== false),
      change: () => {
        const next = config.mouseCapture === false
        writeGlobal(c => ({ ...c, mouseCapture: next }))
        screenInstances.get(process.stdout)?.setMouseTrackingEnabled(next)
        recordToggle('mouseCapture', `set mouse capture to ${next ? 'on' : 'off'}`)
      },
    })
  }
  return items
}
