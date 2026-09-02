import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { CommandCenter } from '../../components/mercury-ui/components.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import {
  COMMAND_SETTINGS_ROWS,
  bootEnvAppliedKeys,
  menuRowChoices,
  readBootDefaultsProfile,
  readBootEnvChoices,
  writeBootEnvChoice,
  type MenuChoice,
} from '../../substrate/startupMenu.js'
import { flagSpellings } from '../../substrate/flagRegistry.js'
import { CACHE_COST } from '../../utils/cache/cacheClockCore.js'
import { providerDisplayName, type CallModelRoute } from '../../services/providers/routeLaw.js'
import { DEEPSEEK_DISPLAY_PINS } from '../../services/providers/deepseek/deepseekPins.js'
import { KIMI_DISPLAY_PINS } from '../../services/providers/moonshot/kimiPins.js'
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js'

// ============================================================================
//  /caching — every provider family's prompt-caching truth, side by side
//  (operator-ruled design): ONE neutral surface, per-family
//  truths from the vendors' real designs, a dial ONLY where the vendor
//  offers one. The Anthropic row carries the real dial (adaptive/5m/1h),
//  writing the MERCURY_CACHE_TTL command-owned setting row (startupMenu's
//  COMMAND_SETTINGS_ROWS; the boot-env applier applies it at boot).
//  Families whose truth owners record no caching mechanism get honest
//  absence, never an invented dial. Copy laws: each vendor is named only
//  inside its own row (the frame stays Mercury's); the Anthropic wording is
//  CP-A's per-family rewording carried verbatim where it fits; the OpenAI
//  and Gemini lines are dated observations from the official docs
//  (dated in the copy); the DeepSeek/Moonshot cache-hit prices DERIVE from the
//  lanes' own pin tables (dated there), never re-typed here.
// ============================================================================

const TTL_ROW = COMMAND_SETTINGS_ROWS.find(r => r.env === 'MERCURY_CACHE_TTL')!

/** The dial's persisted state, provenance-aware (the explicit-env-wins law). */
function readDialState(): {
  /** The saved future-defaults choice (null = adaptive/default). */
  saved: string | null
  /** A REAL operator env pin (set in the environment and NOT stamped there
   *  by the boot-env applier) — outranks every saved default. */
  envPin: { spelling: string; value: string } | null
} {
  const saved = readBootEnvChoices() ?? {}
  const savedSpelling = flagSpellings(TTL_ROW.env).find(sp => saved[sp] !== undefined)
  const applied = bootEnvAppliedKeys()
  let envPin: { spelling: string; value: string } | null = null
  for (const sp of flagSpellings(TTL_ROW.env)) {
    const v = process.env[sp]
    if (v !== undefined && !applied.has(TTL_ROW.env)) {
      envPin = { spelling: sp, value: v }
      break
    }
  }
  return { saved: savedSpelling !== undefined ? (saved[savedSpelling] ?? null) : null, envPin }
}

/** One family's row: the display name + its caching truth lines. */
interface FamilyCachingRow {
  route: CallModelRoute
  /** The one-line truth (line 2+ where the mechanism earns detail). */
  lines: string[]
  dial?: boolean
}

/** The cache-hit price lines a key lane's own pin table records, or null —
 *  a dated header + one line per recorded model (each fits the 100-col
 *  frame's content budget; the numbers derive from the pins, never re-typed). */
function pinnedCacheHitLines(
  pins: ReadonlyArray<{ displayName: string; observedAt: string; costInPerMtok?: number; cachedInPerMtok?: number }>,
): string[] | null {
  const withCache = pins.filter(p => p.cachedInPerMtok !== undefined)
  if (withCache.length === 0) return null
  const observed = withCache[0]!.observedAt
  return [
    `automatic on the provider side — recorded cache-hit input pricing (observed ${observed}):`,
    ...withCache.map(p =>
      p.costInPerMtok !== undefined
        ? `${p.displayName}: $${p.cachedInPerMtok}/M cache-hit vs $${p.costInPerMtok}/M miss`
        : `${p.displayName}: $${p.cachedInPerMtok}/M cache-hit`,
    ),
  ]
}

/** The ten families' truths, routing-law order. Data, not arms. */
function familyRows(): FamilyCachingRow[] {
  return [
    {
      route: 'anthropic',
      dial: true,
      lines: [
        // CP-A's row wording, carried: the knob's meaning + the costs, with
        // the cache-hit economy stated from the ONE cost table.
        'how long Anthropic keeps your conversation cached between prompts — Claude-family calls only',
        `adaptive picks per session from how you actually work · a 1h pin is explicit billing consent`,
        `cache economy: reads ${CACHE_COST.read}× input price · 5m writes ${CACHE_COST.write5m}× · 1h writes ${CACHE_COST.write1h}×`,
      ],
    },
    {
      route: 'openai',
      lines: [
        'automatic for prompts ≥1,024 tokens — no code changes, nothing to adjust',
        "GPT-5.6+: fixed 30m TTL — prompt_cache_options.ttl offers '30m' as its one supported value",
        'cached input 0.1× the uncached rate · GPT-5.6+ cache writes 1.25× (observed 2026-08-24)',
      ],
    },
    {
      route: 'gemini',
      lines: [
        "context caching, Google's own mechanism (observed 2026-08-24):",
        'implicit caching automatic on Gemini 2.5+ · minimum 2,048–4,096 tokens by model',
        'explicit cache objects exist for manual reuse · savings pass on automatically',
      ],
    },
    {
      route: 'deepseek',
      lines: pinnedCacheHitLines(DEEPSEEK_DISPLAY_PINS) ?? ['no caching mechanism recorded — nothing to adjust'],
    },
    {
      route: 'moonshot',
      lines: pinnedCacheHitLines(KIMI_DISPLAY_PINS) ?? ['no caching mechanism recorded — nothing to adjust'],
    },
    { route: 'zai', lines: ['no caching mechanism recorded for the GLM lane — nothing to adjust'] },
    {
      route: 'openrouter',
      lines: ['none of its own recorded — each routed vendor applies its own; nothing to adjust here'],
    },
    {
      route: 'openai-compat',
      lines: ['the operator-named endpoint decides — nothing recorded, nothing to adjust here'],
    },
    { route: 'huggingface', lines: ['no caching mechanism recorded — nothing to adjust'] },
    { route: 'local', lines: ['your own server — no API-side prompt caching to tune'] },
  ]
}

function CachingSurface({ onDone }: { onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const t = useMercuryTokens()
  const rows = React.useMemo(familyRows, [])
  const choices: MenuChoice[] = React.useMemo(() => menuRowChoices(TTL_ROW), [])
  const [cursor, setCursor] = React.useState(0) // routing-law order; the dialed row is first
  const [dial, setDial] = React.useState(readDialState)
  const [receipt, setReceipt] = React.useState<string | null>(null)
  const [note, setNote] = React.useState<string | null>(null)

  const close = (): void => onDone(undefined, { display: 'skip' })

  const cycle = (direction: 1 | -1): void => {
    if (!rows[cursor]?.dial) return
    if (dial.envPin !== null) {
      // The explicit-env-always-wins law, spoken where the turn was asked.
      setNote(
        `pinned by the environment (${dial.envPin.spelling}=${dial.envPin.value}) — explicit env always wins; unset it to dial from here`,
      )
      return
    }
    const currentIndex = choices.findIndex(c => c.value === dial.saved)
    const nextIndex =
      (Math.max(0, currentIndex) + direction + choices.length) % choices.length
    const next = choices[nextIndex]!
    const written = writeBootEnvChoice(TTL_ROW.env, next.value)
    if (!written.ok) {
      setNote(written.reason)
      return
    }
    setNote(null)
    setDial(readDialState())
    // The profile's own stored receipt is the honest apply surface —
    // painted verbatim (new-session application; this session's cache
    // clock keeps its decided TTL).
    setReceipt(readBootDefaultsProfile()?.receipt ?? null)
  }

  useInput((input, key) => {
    if (key.escape) return close()
    if (key.upArrow) return setCursor(c => (c - 1 + rows.length) % rows.length)
    if (key.downArrow) return setCursor(c => (c + 1) % rows.length)
    if (key.return || input === ' ' || key.rightArrow) return cycle(1)
    if (key.leftArrow) return cycle(-1)
  })

  const dialLabel = (c: MenuChoice): string => c.label
  const currentValue = dial.envPin !== null ? dial.envPin.value : dial.saved

  return (
    <CommandCenter
      view="caching"
      subtitle="every family's prompt-caching truth"
      footer="↑↓ family · ↵/space/←→ turn the dial where a row has one · esc close"
      onClose={close}
      captureInput={false}
      closeKeys="esc"
    >
      <Box flexDirection="column" gap={0}>
        {rows.map((row, i) => {
          const focused = i === cursor
          const marker = focused ? '▸' : ' '
          return (
            <Box key={row.route} flexDirection="column">
              <Box>
                <Text color={focused ? t.accent : t.textPrimary} bold={focused}>
                  {marker} {providerDisplayName(row.route)}
                </Text>
                {row.dial ? (
                  <Text color={t.textInstruction}>
                    {'  '}
                    {choices.map((c, ci) => {
                      const active =
                        dial.envPin === null
                          ? c.value === dial.saved
                          : c.value === dial.envPin.value
                      return (
                        <Text
                          key={ci}
                          color={active ? t.accent : t.textInstruction}
                          bold={active}
                        >
                          {ci > 0 ? ' · ' : ''}
                          {dialLabel(c)}
                        </Text>
                      )
                    })}
                    {dial.envPin !== null ? (
                      <Text color={t.warning}> (env-pinned)</Text>
                    ) : null}
                  </Text>
                ) : null}
              </Box>
              {/* Indent as layout, not content: a truth line longer than the
                  pane wraps with the hang kept — a flush-left continuation
                  reads as a broken frame (the 100-col dial receipt). */}
              {row.lines.map((line, li) => (
                <Box key={li} paddingLeft={3}>
                  <Text color={t.textInstruction}>{line}</Text>
                </Box>
              ))}
              {row.dial && receipt !== null ? (
                <Box paddingLeft={3}>
                  <Text color={t.success}>{receipt}</Text>
                </Box>
              ) : null}
              {row.dial && note !== null ? (
                <Box paddingLeft={3}>
                  <Text color={t.warning}>{note}</Text>
                </Box>
              ) : null}
            </Box>
          )
        })}
        {currentValue === '1h' ? (
          <Text color={t.textInstruction}>
            the 1h pin doubles every cache write — the saved choice is the consent
          </Text>
        ) : null}
      </Box>
    </CommandCenter>
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context) => {
  return <CachingSurface onDone={onDone} />
}
