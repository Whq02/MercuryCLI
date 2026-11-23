import { Text } from '../../themedRenderer.js'
import { EDITOR_MODES } from '../../../platform/settings/config.js'
import { journalSettingOn } from '../../../sessions/mneme/journalSetting.js'
import { pinnedStatusPath, readPinnedStatus } from '../../../sessions/mneme/mnemeFrontPage.js'
import { mnemeUnreadSentence } from '../../../sessions/mneme/mnemeUnread.js'
import { runDueMaintenance } from '../../../sessions/mneme/mnemeMaintenance.js'
import { memoryAtStartStatus } from '../../../sessions/mneme/entryKnapsack.js'
import { formatTextSize, PINNED_TEXT_LIMIT_MIN, PINNED_TEXT_LIMIT_STEP, pinnedTextLimit, START_TEXT_LIMIT_MIN, START_TEXT_LIMIT_STEP, startTextLimit } from '../../../sessions/mneme/mnemeUsage.js'
import { describeSemanticReadiness, EMBED_DEFAULT_MODEL, servableEmbedModelNames, WORD_MATCH_ONLY_WORDS } from '../../../sessions/mneme/embedModels.js'
import type { ThemeSetting } from '../../theme/theme.js'
import { DEFAULT_THEME_SETTING } from '../../theme/systemTheme.js'
import { type SettingsItem, THEME_LABELS, cycleIn, validated, type ConfigRowKit } from './configItems.js'

export function configMemoryRows({ config, merged, tokens, boolValue, writeGlobal, writeSource, recordToggle, recordSet, bump, themeSetting }: ConfigRowKit & {
  themeSetting: ThemeSetting
}): SettingsItem[] {
  const items: SettingsItem[] = []
  {
    const pinned = readPinnedStatus()
    const limit = pinnedTextLimit()
    const pinnedUnread = mnemeUnreadSentence([pinnedStatusPath()])
    const fill = pinned ? `${formatTextSize(pinned.used)} of ${formatTextSize(limit)}` : `0 of ${formatTextSize(limit)}`
    items.push({
      id: 'memory.pinnedLimit',
      label: 'Pinned memory limit',
      searchText: 'pinned memory limit rules shelf text size',
      kind: 'enum',
      value: <Text color={pinned?.over || pinnedUnread !== null ? tokens.warning : undefined}>{`${fill}${pinned?.over ? ' · over, all still loaded' : ''}`}</Text>,
      setByYou: merged.memory?.pinnedLimit !== undefined,
      warning: pinnedUnread ?? `how much pinned memory text loads into every session before Mercury says the shelf is full (${pinned?.pinned ?? 0} rule${pinned?.pinned === 1 ? '' : 's'} pinned) · every pinned rule still loads past it · ←/→ move the limit by ${formatTextSize(PINNED_TEXT_LIMIT_STEP)} · pin and unpin in /memory`,
      change: direction => {
        const next = Math.max(PINNED_TEXT_LIMIT_MIN, limit + direction * PINNED_TEXT_LIMIT_STEP)
        if (writeSource('userSettings', { memory: { pinnedLimit: next } })) {
          recordSet('memory.pinnedLimit', `set the pinned memory limit to ${formatTextSize(next)}`)
          void runDueMaintenance('operator', { force: true }).finally(() => bump())
        }
      },
    })
    const startLimit = startTextLimit()
    const atStart = memoryAtStartStatus()
    const rodeWords = atStart === null ? '' : ` · this session: ${atStart.rodeFacts} of ${atStart.facts} fact${atStart.facts === 1 ? '' : 's'}${atStart.notes > 0 ? ` and ${atStart.rodeNotes} of ${atStart.notes} earlier note${atStart.notes === 1 ? '' : 's'}` : ''} rode beside the ${atStart.pinnedCount} pinned rule${atStart.pinnedCount === 1 ? '' : 's'}`
    items.push({
      id: 'memory.startLimit',
      label: 'Memory at start, beyond the pins',
      searchText: 'memory at start beyond the pins allowance relevant facts branch files text size',
      kind: 'enum',
      value: <Text>{`${formatTextSize(atStart?.used ?? 0)} of ${formatTextSize(startLimit)}`}</Text>,
      setByYou: merged.memory?.startLimit !== undefined,
      warning: `how much memory text rides at the start of a session beyond the pinned rules, which always ride whole: the facts and earlier notes most relevant to the branch, the files touched lately and the last note${rodeWords} · what is left out is a Recall away · ←/→ move the allowance by ${formatTextSize(START_TEXT_LIMIT_STEP)} · the next session reads it`,
      change: direction => {
        const next = Math.max(START_TEXT_LIMIT_MIN, startLimit + direction * START_TEXT_LIMIT_STEP)
        if (writeSource('userSettings', { memory: { startLimit: next } })) {
          recordSet('memory.startLimit', `set the memory-at-start limit to ${formatTextSize(next)}`)
          bump()
        }
      },
    })
  }
  {
    const embedSpec = typeof merged.memory?.embeddingModel === 'string' ? merged.memory.embeddingModel.trim() : ''
    const embedReadiness = describeSemanticReadiness()
    const embedValue = embedReadiness.state === 'ok' ? embedReadiness.model : WORD_MATCH_ONLY_WORDS
    const servable = servableEmbedModelNames()
    const embedChoices = ['', ...servable.filter(name => name !== EMBED_DEFAULT_MODEL)]
    const choiceWords = servable.length > 1 ? `←/→ picks among the ${servable.length} models this install carries` : 'this install carries one model, the shipped default'
    items.push({
      id: 'memory.embeddingModel',
      label: 'Memory recall ranking',
      searchText: 'memory recall ranking embedding model semantic meaning word match',
      kind: 'enum',
      value: <Text color={embedReadiness.state === 'ok' ? undefined : tokens.textSecondary}>{embedValue}</Text>,
      setByYou: merged.memory?.embeddingModel !== undefined,
      warning: `${embedReadiness.state === 'ok' ? `recall ranks by meaning and words through ${embedValue} — everything stays on this machine` : `recall runs word match only — ${embedReadiness.note}`} · ${choiceWords}`,
      change: direction => {
        const current = embedSpec === '' || embedSpec === 'default' ? '' : embedSpec
        const next = cycleIn(embedChoices, embedChoices.includes(current) ? current : '', direction)
        if (writeSource('userSettings', { memory: { embeddingModel: next === '' ? undefined : next } })) {
          recordSet('memory.embeddingModel', `set the memory recall ranking to ${next === '' ? 'the shipped default' : next}`)
          bump()
        }
      },
    })
  }
  {
    const journalOn = journalSettingOn(merged)
    items.push({
      id: 'memory.journal',
      label: 'Session journal',
      searchText: 'session journal model own words what happened how you like to work',
      kind: 'boolean',
      value: boolValue(journalOn),
      setByYou: merged.memory?.journal !== undefined,
      warning: "off unless you turn it on · at session end the model writes, in its own words, what happened, what you wanted, how you like to work and what it got wrong · a file in the Mercury home beside the project's memory, never under the project tree · Mercury never pushes, syncs or shares it · read it in /memory",
      change: () => {
        if (writeSource('userSettings', { memory: { journal: !journalOn } })) {
          recordToggle('memory.journal', `set the session journal to ${journalOn ? 'off' : 'on'}`)
          bump()
        }
      },
    })
    const onEntryPage = merged.memory?.journalOnEntryPage === true
    items.push({
      id: 'memory.journalOnEntryPage',
      label: 'Journal on the entry page',
      searchText: 'journal entry page session start last entry model reads provider request',
      kind: 'boolean',
      value: boolValue(onEntryPage),
      setByYou: merged.memory?.journalOnEntryPage !== undefined,
      warning: "includes the journal's last entry in the session-start context sent to the model's provider (Mercury never syncs or shares the journal elsewhere)",
      change: () => {
        if (writeSource('userSettings', { memory: { journalOnEntryPage: !onEntryPage } })) {
          recordToggle('memory.journalOnEntryPage', `set the journal on the entry page to ${onEntryPage ? 'off' : 'on'}`)
          bump()
        }
      },
    })
  }
  items.push({
    id: 'files.honourGitignore',
    label: 'Respect .gitignore in file picker',
    kind: 'boolean',
    setByYou: merged.files?.honourGitignore !== undefined,
    value: boolValue(merged.files?.honourGitignore !== false),
    change: () => {
      const next = merged.files?.honourGitignore === false
      if (writeSource('userSettings', { files: { honourGitignore: next } })) {
        recordToggle('files.honourGitignore', `set honour-gitignore to ${next ? 'on' : 'off'}`)
        bump()
      }
    },
  })
  items.push({
    id: 'theme',
    label: 'Theme',
    kind: 'managed-enum',
    setByYou: themeSetting !== DEFAULT_THEME_SETTING,
    value: <Text>{THEME_LABELS[themeSetting] ?? themeSetting}</Text>,
    open: 'theme',
  })
  items.push({
    id: 'language',
    label: 'Language',
    kind: 'managed-enum',
    setByYou: merged.voice?.language !== undefined,
    value: <Text>{merged.voice?.language ?? 'auto'}</Text>,
    open: 'language',
  })
  items.push({
    id: 'editorMode',
    label: 'Editor mode',
    kind: 'enum',
    setByYou: validated(EDITOR_MODES, config.editorMode, 'normal') !== 'normal',
    value: <Text>{validated(EDITOR_MODES, config.editorMode, 'normal')}</Text>,
    change: direction => {
      const current = validated(EDITOR_MODES, config.editorMode, 'normal')
      const next = cycleIn(EDITOR_MODES, current, direction)
      writeGlobal(c => ({ ...c, editorMode: next }))
      recordSet('editorMode', `set editor mode to ${next}`)
    },
  })
  items.push({
    id: 'prStatusFooter',
    label: 'PR status footer',
    kind: 'boolean',
    setByYou: config.prStatusFooterEnabled === false,
    value: boolValue(config.prStatusFooterEnabled !== false),
    change: () => {
      writeGlobal(c => ({ ...c, prStatusFooterEnabled: c.prStatusFooterEnabled === false }))
      recordToggle('prStatusFooter', `set PR status footer to ${config.prStatusFooterEnabled === false ? 'on' : 'off'}`)
    },
  })
  return items
}
