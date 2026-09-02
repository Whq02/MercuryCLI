import { homedir } from 'node:os'
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../../../ink.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { getGlobalConfig } from '../../../utils/config.js'
import { getMercuryHome } from '../../../utils/envUtils.js'
import { resolveLiveScopeIdentity } from '../../../utils/accounts/accountIdentity.js'
import { AMBER, FAINT, IVORY, SECOND, TEAL } from '../../mercuryPalette.js'
import {
  CommandCenter,
  KeyValueGrid,
  SectionHeader,
  StateBadge,
} from '../components.js'
import { padTo, truncateToWidth } from '../glyphs.js'
import {
  resolveProviderUsability,
  type ProviderId,
  type ProviderUsability,
} from '../../../services/providers/providerUsability.js'

function usabilityFor(familyId: string): ProviderUsability | undefined {
  const map = resolveProviderUsability()
  return (map as Partial<Record<string, ProviderUsability>>)[familyId as ProviderId]
}
import {
  deriveFamilySlotGroups,
  executeSlotRemoval,
  familyDisplayName,
  familySigninCeiling,
  familySigninHeaderNote,
  familySigninSummary,
  mainLoopIdentity,
  slotSigninState,
  type AccountSlot,
  type SlotIdentities,
  type SlotSigninState,
} from '../../../services/providers/accountSlots.js'
import type { ProviderFamilyPresence } from '../../../services/providers/providerUsage.js'
import { useAppState } from '../../../state/AppState.js'
import { getMainLoopModel, renderModelName } from '../../../utils/model/model.js'
import { useSessionAccent } from '../sessionAccent.js'
import { useInteractiveList } from '../useInteractiveList.js'
import { InteractiveRow } from '../InteractiveRow.js'


type BoardRow =
  | { type: 'slot'; slot: AccountSlot }
  | { type: 'absent'; family: ProviderFamilyPresence }

const rowKey = (row: BoardRow): string =>
  row.type === 'slot' ? row.slot.id : `absent:${row.family.id}`

const FAMILY_CONNECT_ROUTES: Record<string, string> = {
  zai: 'GLM connects at /logins zai (a Z.AI API key — general or GLM Coding Plan); ZAI_API_KEY in your shell wins',
  moonshot:
    'Kimi signs in at /logins moonshot (device code in the browser, or a Moonshot API key); MOONSHOT_API_KEY in your shell wins',
  deepseek:
    'DeepSeek connects at /logins deepseek (an API key from platform.deepseek.com); DEEPSEEK_API_KEY in your shell wins',
  'openai-compat':
    'The custom endpoint configures via MERCURY_COMPAT_BASE_URL (key optional — /router key compat)',
  huggingface:
    'Hugging Face signs in at /logins (device-code OAuth or a pasted token); HF_TOKEN in your shell wins',
  local:
    'Local models need no sign-in — start Ollama (:11434), LM Studio (:1234), vLLM (:8000) or llama.cpp-server (:8080), or set MERCURY_LOCAL_BASE_URL; /model re-probes on open',
}
function familyConnectRoute(id: string): string {
  return FAMILY_CONNECT_ROUTES[id] ?? `${familyDisplayName(id)} sign-in lives at /logins`
}

const MAX_ROWS_SHOWN = 8

const REMOVAL_CONFIRM_WINDOW_MS = 8_000

function tildify(p: string, home: string): string {
  return p.startsWith(home) ? `~${p.slice(home.length)}` || '~' : p
}

type Identities = SlotIdentities

function identityTail(state: SlotSigninState, id: Identities[string] | undefined): string {
  switch (state.basis) {
    case 'excluded':
      return "another tool's credential scope — never billable from Mercury"
    case 'checking':
      return 'verifying identity…'
    case 'verified-live':
      return `${id?.state === 'verified' ? id.email : 'signed in'} · verified live · ↵ opens Logins to re-login · ⌫ signs out`
    case 'expired':
      return `expired${id?.state === 'expired' && id.snapshotEmail ? ` (snapshot ${id.snapshotEmail})` : ''} · not signed in · ↵ opens Logins to reauth`
    case 'signed-out':
    case 'absent':
      return 'not signed in · ↵ opens Logins to sign in'
    case 'unverified':
      return id?.state === 'unverified'
        ? `unverified — ${id.note}${id.email ? ` · snapshot ${id.email}` : ''} · not counted as signed in`
        : 'unverified · not counted as signed in'
    case 'credential-present':
      return 'credential present'
  }
}

export function AccountView({
  onClose,
}: {
  onClose: (value?: string, options?: { nextInput?: string; submitNextInput?: boolean }) => void
}): React.ReactNode {
  const accent = useSessionAccent().accent
  const home = homedir()
  const tailWidth = Math.max(24, useTerminalSize().columns - 36)
  const [version, setVersion] = useState(0)
  const [identities, setIdentities] = useState<Identities>({})
  const armedRemovalRef = useRef<{ id: string; at: number } | null>(null)

  useEffect(() => {
    let alive = true
    void import('../../../utils/router/providerDiscovery.js')
      .then(m => m.refreshProviderDiscovery('local'))
      .then(() => {
        if (alive) setVersion(v => v + 1)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  void version
  const groups = deriveFamilySlotGroups()
  const scopeSlots = groups.flatMap(group => group.slots.filter(slot => slot.scope !== undefined))

  const scopeDirsKey = scopeSlots.map(slot => slot.id).join('|')
  useEffect(() => {
    let alive = true
    for (const slot of scopeSlots) {
      if (slot.scope!.claudeFamily) continue
      setIdentities(prev => (prev[slot.id] ? prev : { ...prev, [slot.id]: { state: 'checking' } }))
      void resolveLiveScopeIdentity(slot.id).then(v => {
        if (alive) setIdentities(prev => ({ ...prev, [slot.id]: v }))
      })
    }
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeDirsKey])

  const acct = getGlobalConfig().oauthAccount
  const sessionModel = useAppState(state => state.mainLoopModelForSession ?? state.mainLoopModel)
  const mainLoopModel = sessionModel ?? getMainLoopModel()

  const rerouteToLogins = (family: string, why: string): string => {
    onClose(why, { nextInput: `/logins ${family}`, submitNextInput: true })
    return why
  }

  const listRows: BoardRow[] = groups.flatMap((group): BoardRow[] =>
    group.slots.length > 0
      ? group.slots.map((slot): BoardRow => ({ type: 'slot', slot }))
      : [{ type: 'absent', family: group.family }],
  )

  const activateScopeSlot = (slot: AccountSlot): string => {
    const s = slot.scope!
    if (s.claudeFamily) {
      return "another tool's credential scope — Mercury never bills through it; run under your Mercury home (no config-dir pin) to sign in"
    }
    if (s.isCurrent) return rerouteToLogins('anthropic', `opening Logins for the ${s.name} sign-in`)
    return `this login belongs to ${s.name} — run mercury there (MERCURY_CONFIG_DIR=${s.dir}) and /logins; ⌫ here signs it out`
  }

  const activateSlot = (slot: AccountSlot): string => {
    if (slot.scope) return activateScopeSlot(slot)
    if (slot.family === 'openai') {
      return rerouteToLogins('openai', 'opening Logins for the OpenAI sign-in')
    }
    if (slot.envPinned) {
      return `${slot.identity} — the shell owns this pin; Mercury reads it, never edits it`
    }
    switch (slot.removal.route) {
      case 'anthropic-managed-key':
        return 'the /logins managed key — ⌫ removes it (config + keychain)'
      case 'settings':
      case 'owner':
        return slot.removal.note
      default:
        return familyConnectRoute(slot.family)
    }
  }

  const { selectedIndex: sel, note, hints, rowProps } = useInteractiveList({
    rows: listRows,
    rowId: rowKey,
    idNamespace: 'accounts',
    onClose,
    active: true,
    actions: [
      {
        key: 'return',
        hint: 'opens Logins to sign in / re-login',
        run: row => {
          if (!row) return 'no accounts found — r rescans'
          if (row.type === 'absent') {
            if (row.family.id === 'openai') return rerouteToLogins('openai', 'opening Logins for the OpenAI sign-in')
            return familyConnectRoute(row.family.id)
          }
          return activateSlot(row.slot)
        },
      },
      {
        key: 'r',
        hint: 'rescan',
        run: () => {
          setVersion(v => v + 1)
          setIdentities({})
          return 'rescanned accounts (identities re-verify live)'
        },
      },
      {
        key: 'backspace',
        hint: 'remove slot (⌫ twice)',
        run: row => {
          if (!row) return 'no accounts found — r rescans'
          if (row.type === 'absent') {
            return `nothing to remove — ${row.family.id} has no login. ${familyConnectRoute(row.family.id)}`
          }
          const removable =
            row.slot.removal.route !== 'excluded' &&
            row.slot.removal.route !== 'owner' &&
            row.slot.removal.route !== 'settings' &&
            row.slot.removal.route !== 'env'
          const id = rowKey(row)
          const armed = armedRemovalRef.current
          const stillArmed = armed !== null && armed.id === id && Date.now() - armed.at <= REMOVAL_CONFIRM_WINDOW_MS
          if (removable && !stillArmed) {
            armedRemovalRef.current = { id, at: Date.now() }
            const what = row.slot.identity || row.slot.kindLabel
            return `⌫ again removes ${familyDisplayName(row.slot.family)} · ${what} (signs it out and drops the stored credential) — any other row keeps it`
          }
          armedRemovalRef.current = null
          const outcome = executeSlotRemoval(row.slot)
          if (outcome.mutated) setVersion(v => v + 1)
          return outcome.note
        },
      },
    ],
  })

  const billingSlot = scopeSlots.find(slot => slot.scope!.isCurrent)
  const mainLoop = mainLoopIdentity({
    model: mainLoopModel,
    presences: groups.map(group => group.family),
    currentScopeIdentity: billingSlot ? identities[billingSlot.id] : undefined,
    currentScopeClaudeFamily: billingSlot?.scope?.claudeFamily ?? false,
  })
  const mainLoopText = `${mainLoop.family} · ${renderModelName(mainLoopModel)} · ${mainLoop.text}`
  const orgText =
    mainLoop.route === 'anthropic' && mainLoop.basis === 'verified-live' && acct?.organizationName
      ? `${acct.organizationName} (snapshot)`
      : undefined

  const renderRow = (row: BoardRow, index: number): React.ReactNode => {
    const selected = index === sel
    let glyph: string
    let color: string
    let name: string
    let kindLabel: string
    let tail: string
    if (row.type === 'absent') {
      glyph = '⦿'
      color = AMBER
      name = row.family.id
      kindLabel = 'absent'
      tail =
        row.family.id === 'openai'
          ? 'not connected · ↵ opens Logins to sign in'
          : row.family.id === 'local'
            ? 'no server discovered · ↵ names the route — Ollama · LM Studio · vLLM · llama.cpp, or MERCURY_LOCAL_BASE_URL'
            : `not signed in · ↵ names the route — ${
                row.family.id === 'zai'
                  ? '/logins zai or ZAI_API_KEY'
                  : row.family.id === 'moonshot'
                    ? '/logins moonshot or MOONSHOT_API_KEY'
                    : row.family.id === 'deepseek'
                      ? '/logins deepseek or DEEPSEEK_API_KEY'
                      : row.family.id === 'openai-compat'
                        ? 'MERCURY_COMPAT_BASE_URL'
                        : row.family.id === 'huggingface'
                          ? '/logins or HF_TOKEN'
                          : '/logins'
              }`
    } else {
      const slot = row.slot
      name = slot.name
      kindLabel = slot.kindLabel
      if (slot.scope) {
        const s = slot.scope
        const id = identities[slot.id]
        const state = slotSigninState(slot, identities)
        glyph = state.basis === 'excluded' ? '⊘' : state.signedIn ? '●' : '⦿'
        color = state.basis === 'excluded' ? FAINT : state.signedIn ? TEAL : AMBER
        tail = [tildify(s.dir, home), s.isCurrent ? 'this session' : '', identityTail(state, id)]
          .filter(Boolean)
          .join(' · ')
      } else {
        glyph = slot.active ? '●' : '○'
        color = slot.active ? TEAL : slot.envPinned ? SECOND : AMBER
        const affordance =
          slot.family === 'openai'
            ? slot.kind === 'subscription'
              ? '↵ opens Logins to reconnect · ⌫ disconnects'
              : slot.envPinned
                ? "the shell's — ⌫ explains"
                : '↵ opens Logins (ChatGPT) · ⌫ clears'
            : slot.envPinned
              ? "the shell's — ⌫ explains"
              : slot.removal.route === 'moonshot-oauth'
                ? '↵ names the route · ⌫ disconnects'
                : slot.removal.route === 'zai-stored-key' ||
                    slot.removal.route === 'moonshot-stored-key' ||
                    slot.removal.route === 'deepseek-stored-key' ||
                    slot.removal.route === 'compat-stored-key'
                  ? '⌫ clears'
                : slot.removal.route === 'anthropic-managed-key'
                  ? '⌫ removes'
                  : '↵/⌫ name the owning route'
        tail = [
          slot.identity,
          slot.active && slot.kind !== 'oauth' ? 'active source' : '',
          slot.stateNote ?? '',
          affordance,
        ]
          .filter(Boolean)
          .join(' · ')
      }
    }
    return (
      <InteractiveRow key={rowKey(row)} {...rowProps(row, index)}>
        <Text>
          <Text color={selected ? accent : FAINT}>{selected ? '▸ ' : '  '}</Text>
          <Text color={color}>{glyph} </Text>
          <Text color={selected ? IVORY : SECOND}>{padTo(name, 12)}</Text>
          <Text color={FAINT}>{padTo(kindLabel, 15)}</Text>
          <Text color={FAINT} wrap="truncate-end">{truncateToWidth(tail, tailWidth)}</Text>
        </Text>
      </InteractiveRow>
    )
  }

  let cursor = 0
  const groupViews = groups.map(group => {
    const start = cursor
    const count = Math.max(1, group.slots.length)
    cursor += count
    return { group, start }
  })

  return (
    <CommandCenter view="accounts" onClose={onClose} captureInput={false} footer={hints}>
      <Box marginTop={1}>
        <Text>
          <StateBadge state="excluded" label="tokens never shown" />
          <Text color={FAINT}> · identity is live-verified from each slot's OWN credential (snapshots only as labeled offline fallback) · a key or token counts by presence</Text>
        </Text>
      </Box>

      <SectionHeader>This session</SectionHeader>
      <KeyValueGrid
        keyWidth={10}
        rows={[
          { k: 'scope', v: tildify(getMercuryHome(), home), tone: IVORY, fit: 'middle' as const },
          { k: 'main loop', v: mainLoopText, tone: IVORY, fit: 'end' as const },
          ...(orgText !== undefined ? [{ k: 'org', v: orgText, tone: SECOND, fit: 'end' as const }] : []),
        ]}
      />

      {groupViews.map(({ group, start }) => {
        const signedIn = familySigninSummary(group.slots, identities).signedIn
        const rowsOfGroup: BoardRow[] =
          group.slots.length > 0
            ? group.slots.map((slot): BoardRow => ({ type: 'slot', slot }))
            : [{ type: 'absent', family: group.family }]
        const localSel = Math.min(Math.max(0, sel - start), rowsOfGroup.length - 1)
        const winStart =
          rowsOfGroup.length > MAX_ROWS_SHOWN
            ? Math.max(0, Math.min(localSel - MAX_ROWS_SHOWN + 1, rowsOfGroup.length - MAX_ROWS_SHOWN))
            : 0
        const shown = rowsOfGroup.slice(winStart, winStart + MAX_ROWS_SHOWN)
        const hiddenAbove = winStart
        const hiddenBelow = Math.max(0, rowsOfGroup.length - winStart - shown.length)
        const ceiling = familySigninCeiling(group.family.id)
        const capacity = familySigninHeaderNote(group.family.id, group.slots, identities)
        const health = usabilityFor(group.family.id)
        const healthLine =
          health === undefined || (health.usable && health.limit !== 'allowed_warning')
            ? null
            : health.usable
              ? 'usage window warning — /usage shows the reset'
              : (health.blockers[0] ?? 'not ready')
        return (
          <React.Fragment key={group.family.id}>
            <SectionHeader {...(ceiling === undefined ? { count: signedIn } : {})}>{`${familyDisplayName(group.family.id)} accounts${capacity}`}</SectionHeader>
            {healthLine !== null ? (
              <Box paddingLeft={2}>
                <Text color={AMBER}>{`⚠\uFE0E ${healthLine}`}</Text>
              </Box>
            ) : null}
            {hiddenAbove > 0 ? <Text color={FAINT}>{`  +${hiddenAbove} above`}</Text> : null}
            {shown.map((row, i) => renderRow(row, start + winStart + i))}
            {hiddenBelow > 0 ? <Text color={FAINT}>{`  +${hiddenBelow} below — ↓ reaches them`}</Text> : null}
          </React.Fragment>
        )
      })}

      <Box marginTop={1}>
        <Text color={FAINT}>/logout signs out of everything, every provider · /logins adds accounts</Text>
      </Box>

      {note ? (
        <Box marginTop={1}>
          <Text color={IVORY} wrap="truncate-end">{note}</Text>
        </Box>
      ) : null}
    </CommandCenter>
  )
}
