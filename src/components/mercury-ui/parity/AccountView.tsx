import { homedir } from 'node:os'
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../../../ink.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { getGlobalConfig } from '../../../utils/config.js'
import { getMercuryHome } from '../../../utils/envUtils.js'
import { forgetScopeIdentity, resolveLiveScopeIdentity } from '../../../utils/accounts/accountIdentity.js'
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

/** The readiness lane for a slot-board family id, or undefined for ids the
 *  resolver does not know (nothing is invented for them). */
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
  scopeSlotTail,
  slotSigninState,
  type AccountSlot,
  type SlotIdentities,
} from '../../../services/providers/accountSlots.js'
import type { ProviderFamilyPresence } from '../../../services/providers/providerUsage.js'
import { useAppState } from '../../../state/AppState.js'
import { getMainLoopModel, renderModelName } from '../../../utils/model/model.js'
import { useSessionAccent } from '../sessionAccent.js'
import { useInteractiveList } from '../useInteractiveList.js'
import { InteractiveRow } from '../InteractiveRow.js'

// ============================================================================
//  AccountView — /accounts, the ACCOUNT SLOTS board (plain slots since the
//  account-slot simplification, operator ruling — the switching
//  and rotation machinery is retired; what remains is ordinary sign-in,
//  sign-out, and re-login per slot):
//
//    · ONE SLOT PER SIGNED-IN IDENTITY across EVERY provider family the
//      router catalogue knows — derived through the accountSlots seam
//      (providerFamilyPresences + each family's owning account resolvers),
//      never a hand-kept family list. A family added to the catalogue
//      appears here with no edit.
//    · Per-slot actions: ↵ REROUTES to the Logins screen (the one owner of
//      sign-in flows and their code entry; the row's family pre-focused via
//      the command chain) — the board hosts no flow and never re-points
//      a credential; ⌫ removes exactly THIS slot through its owning store
//      (executeSlotRemoval); env-pinned keys are the shell's — shown,
//      refused honestly, never edited. /logout stays the GLOBAL verb: it
//      signs out of everything, every provider.
//    · The Anthropic OAuth slot is the RESOLVED config home's login — the
//      account this session bills when the main loop routes to Anthropic
//      on the subscription. Identity is CREDENTIAL-DERIVED: the email is
//      live-verified against the OAuth profile endpoint (snapshots only as
//      the labeled offline fallback). CLASS ISOLATION holds: a CLAUDE-family
//      home renders for honesty and is never billable from Mercury.
//    · ONE sign-in derivation (accountSlots.slotSigninState) feeds BOTH the
//      family header's count and the row's state words — a header can never
//      count a credential the row calls expired or unverified. The "main
//      loop" row derives from the main model's ACTUAL route and that
//      family's owning resolver, never from the Anthropic snapshot.
//    · The OpenAI subscription connects/reconnects in place (browser PKCE
//      with the paste fallback); absent families show their absent row with
//      the sign-in route (/logins; families with no browser flow name their
//      real owner).
//  Tokens are read ONLY through the audited scoped reader for
//  verification/reauth; nothing token-shaped is ever rendered — identities
//  are emails, labels, sources, masked tails.
// ============================================================================

/** The board row: one slot, or a family's honest absent row (same list so
 *  arrows/↵/⌫ reach both). */
type BoardRow =
  | { type: 'slot'; slot: AccountSlot }
  | { type: 'absent'; family: ProviderFamilyPresence }

const rowKey = (row: BoardRow): string =>
  row.type === 'slot' ? row.slot.id : `absent:${row.family.id}`

/** Presentation facts for KNOWN family ids whose sign-in lives outside this
 *  board (present state — the owning route is NAMED, no flow is faked). An
 *  unknown id gets the generic /logins route, so a future family is never
 *  silent. */
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

/** ⌫ is a two-press gesture: the first press ARMS the removal on the
 *  focused slot and names what would leave; a second press on the SAME
 *  slot inside this window executes it. Another slot, or the window
 *  passing, disarms. A sign-out revokes tokens server-side and drops the
 *  stored credential — a single stray keypress must never do that. */
const REMOVAL_CONFIRM_WINDOW_MS = 8_000

function tildify(p: string, home: string): string {
  return p.startsWith(home) ? `~${p.slice(home.length)}` || '~' : p
}

type Identities = SlotIdentities

export function AccountView({
  onClose,
}: {
  /** Close the board. The reroute arms pass the settle note plus the
   *  command-chain options (nextInput/submitNextInput) so a login choice
   *  lands on the Logins screen with its family pre-focused. */
  onClose: (value?: string, options?: { nextInput?: string; submitNextInput?: boolean }) => void
}): React.ReactNode {
  const accent = useSessionAccent().accent
  const home = homedir()
  // The tail column budgets against the LIVE interior width (CommandCenter:
  // border 2 + paddingX 2 = 4; row fixed = indent 2 + glyph 2 + name 12 +
  // kind 15 = 31; 1 right slack). The old fixed 46 overflowed the border by
  // one cell at 80 cols and starved identity tails at 120+ (a UX
  // sweep).
  const tailWidth = Math.max(24, useTerminalSize().columns - 36)
  // The owners are all file-backed — the board re-derives every render; the
  // version counter forces a re-read after a mutation (remove/connect/add).
  const [version, setVersion] = useState(0)
  const [identities, setIdentities] = useState<Identities>({})
  // The armed removal (slot id + the moment ⌫ armed it) — see
  // REMOVAL_CONFIRM_WINDOW_MS.
  const armedRemovalRef = useRef<{ id: string; at: number } | null>(null)

  // The local engine's slot paints DISCOVERY truth: kick ONE bounded
  // loopback probe at mount (localDiscovery's own 900ms caps; single-flight,
  // TTL-honoured) and re-derive when it lands — the row then shows a probe
  // that actually ran instead of the pre-probe pending stamp for the life
  // of the board (the never-stale law, w1-f14-03). Never blocks first paint.
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

  void version // re-derivation trigger — the reads below are file-backed
  const groups = deriveFamilySlotGroups()
  const scopeSlots = groups.flatMap(group => group.slots.filter(slot => slot.scope !== undefined))

  // Live identity verification per scope slot — credential-derived, cached,
  // labeled-unverified offline. Never blocks the board's first paint. Runs
  // again on every mutation (the version): a removal drops the slot's read
  // below and the re-probe answers from the scope's own store (the cache
  // follows the sign-in epoch, so nothing verified outlives its login).
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
    // keyed by the scope dir set + the mutation version — scopeSlots is a
    // fresh array every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeDirsKey, version])

  const acct = getGlobalConfig().oauthAccount
  // The main loop's model: the session override when a mode engaged one,
  // else the configured setting, else the resolved default — the SAME read
  // /config's main-loop pointer row makes.
  const sessionModel = useAppState(state => state.mainLoopModelForSession ?? state.mainLoopModel)
  const mainLoopModel = sessionModel ?? getMainLoopModel()

  // INVENTORY ONLY (operator-ruled; prove-accounts-inventory-only):
  // the board hosts NO sign-in flow — its own paste panel rendered below the
  // fold of a ten-section view, so the opened link was a dead end by
  // construction. A login/re-login choice closes the board and lands on the
  // Logins screen — the one owner of sign-in flows and their code entry —
  // with the row's family pre-focused through the command chain.
  const rerouteToLogins = (family: string, why: string): string => {
    onClose(why, { nextInput: `/logins ${family}`, submitNextInput: true })
    return why
  }

  // The flat row list, in render order: every group's slots (or its absent
  // row) — DERIVED, family by family, so navigation reaches everything.
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
    // The current home's slot reroutes to Logins (sign-in and re-login are
    // the same gesture THERE). Any other scope is the deliberate exception:
    // /logins writes the CURRENT home's store, so a reroute would sign the
    // wrong scope in — the row names the honest road and starts nothing.
    if (s.isCurrent) return rerouteToLogins('anthropic', `opening Logins for the ${s.name} sign-in`)
    return `this login belongs to ${s.name} — run mercury there (MERCURY_CONFIG_DIR=${s.dir}) and /logins; ⌫ here signs it out`
  }

  const activateSlot = (slot: AccountSlot): string => {
    if (slot.scope) return activateScopeSlot(slot)
    if (slot.family === 'openai') {
      // Connect (or reconnect) the ChatGPT subscription at Logins — the
      // api-key slot routes there too (the subscription is the browser leg).
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
          // The operator asked for a fresh verification: forget the resolved
          // identities so the re-probe reaches the endpoint, not the cache.
          forgetScopeIdentity()
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
          // The confirmation: the first ⌫ arms and names what would leave;
          // only a second ⌫ on the same slot inside the window executes.
          // Guidance rows (env pins, excluded scopes, settings-owned keys)
          // mutate nothing, so they answer at once.
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
          // Routed to the owning store; env pins and excluded scopes come
          // back as honest refusals, guidance rows mutate nothing.
          const outcome = executeSlotRemoval(row.slot)
          if (outcome.mutated) {
            // The departed slot's read leaves with it; the re-probe (the
            // version) answers from the store — signed out, at once.
            setIdentities(prev => {
              const next = { ...prev }
              delete next[row.slot.id]
              return next
            })
            setVersion(v => v + 1)
          }
          return outcome.note
        },
      },
    ],
  })

  // The main loop's billing identity for the summary row: the main model's
  // ACTUAL route (the routing law) and that family's credential from the
  // presence enumeration; on the Anthropic subscription, the current
  // scope's LIVE verification — a snapshot only ever appears labelled.
  const billingSlot = scopeSlots.find(slot => slot.scope!.isCurrent)
  const mainLoop = mainLoopIdentity({
    model: mainLoopModel,
    presences: groups.map(group => group.family),
    currentScopeIdentity: billingSlot ? identities[billingSlot.id] : undefined,
    currentScopeClaudeFamily: billingSlot?.scope?.claudeFamily ?? false,
  })
  const mainLoopText = `${mainLoop.family} · ${renderModelName(mainLoopModel)} · ${mainLoop.text}`
  // The organisation fact is the Anthropic snapshot's — shown only when the
  // main loop bills the verified Anthropic login, and labelled as a snapshot.
  const orgText =
    mainLoop.route === 'anthropic' && mainLoop.basis === 'verified-live' && acct?.organizationName
      ? `${acct.organizationName} (snapshot)`
      : undefined

  /** One uniform row: glyph · name · kind · tail — same grammar for every
   *  family (the derivation owns what exists; this owns only the paint). */
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
        tail = [tildify(s.dir, home), s.isCurrent ? 'this session' : '', scopeSlotTail(state, id, slot)]
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

  // Group render offsets into the flat list (absent rows count one).
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
          // Fitted rows: each value truncates in its OWN column (paths keep
          // head+tail via 'middle') — the default paragraph wrap jammed long
          // values under the key column at 80 cols (a UX sweep).
          { k: 'scope', v: tildify(getMercuryHome(), home), tone: IVORY, fit: 'middle' as const },
          { k: 'main loop', v: mainLoopText, tone: IVORY, fit: 'end' as const },
          ...(orgText !== undefined ? [{ k: 'org', v: orgText, tone: SECOND, fit: 'end' as const }] : []),
        ]}
      />

      {groupViews.map(({ group, start }) => {
        // The ONE derivation the rows paint from — the header counts it.
        const signedIn = familySigninSummary(group.slots, identities).signedIn
        const rowsOfGroup: BoardRow[] =
          group.slots.length > 0
            ? group.slots.map((slot): BoardRow => ({ type: 'slot', slot }))
            : [{ type: 'absent', family: group.family }]
        // Window an oversized group around the selection so a long family
        // list stays reachable without flooding the viewport.
        const localSel = Math.min(Math.max(0, sel - start), rowsOfGroup.length - 1)
        const winStart =
          rowsOfGroup.length > MAX_ROWS_SHOWN
            ? Math.max(0, Math.min(localSel - MAX_ROWS_SHOWN + 1, rowsOfGroup.length - MAX_ROWS_SHOWN))
            : 0
        const shown = rowsOfGroup.slice(winStart, winStart + MAX_ROWS_SHOWN)
        const hiddenAbove = winStart
        const hiddenBelow = Math.max(0, rowsOfGroup.length - winStart - shown.length)
        // Ceilinged families (anthropic/openai: 2 concurrent sign-ins, the
        // ruling) show their headroom in the header — INSTEAD of
        // the count chip, which would repeat the same fact (the
        // slot-count-printed-twice class). The words come from the one
        // derivation: a scope the live probe reads expired, unverified or
        // signed out is not counted, and an in-flight probe says so.
        const ceiling = familySigninCeiling(group.family.id)
        const capacity = familySigninHeaderNote(group.family.id, group.slots, identities)
        // The family HEALTH line (spec-05 slot hygiene): the ONE readiness
        // resolver's verdict, rendered only when it carries news — a
        // not-ready family shows its typed blocker verbatim (the custodian's
        // own repair action), a capped window shows the window fact. A
        // healthy family adds no row (block-correctness/warn-rest).
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
              // Indent as layout: a blocker longer than the pane (Moonshot's
              // at 80 cols) wraps with the hang kept, never flush-left.
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
