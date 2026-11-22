import * as React from 'react'
import { Box, Text, useInput, type DOMElement } from '../../ink.js'
import { popupPageRows, usePopupListNavigation } from '../../components/CustomSelect/popup-list.js'
import { CursorRow } from '../../components/mercury-ui/CursorRow.js'
import { CommandCenter } from '../../components/mercury-ui/components.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import {
  COMMAND_SETTINGS_ROWS,
  menuRowChoices,
  readBootDefaultsProfileStrict,
  readBootEnvChoicesStrict,
  realEnvPin,
  writeBootEnvChoice,
  type MenuChoice,
} from '../../substrate/startupMenu.js'
import { flagSpellings } from '../../substrate/flagRegistry.js'
import { CACHE_COST } from '../../utils/cache/cacheClockCore.js'
import { providerDisplayName, type CallModelRoute } from '../../services/providers/routeLaw.js'
import { DEEPSEEK_DISPLAY_PINS } from '../../utils/model/pins/deepseekPins.js'
import { KIMI_DISPLAY_PINS } from '../../utils/model/pins/kimiPins.js'
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js'
import { notBuilt } from '../../pi/holes.js'


const TTL_ROW = COMMAND_SETTINGS_ROWS.find(r => r.env === 'MERCURY_CACHE_TTL')!

function readDialState(): {
  saved: string | null
  envPin: { spelling: string; value: string } | null
  readError: string | null
} {
  const res = readBootEnvChoicesStrict()
  if (!res.ok) {
    return {
      saved: null,
      envPin: realEnvPin(TTL_ROW.env),
      readError: `could not be read (${res.reason})`,
    }
  }
  const saved = res.env
  const savedSpelling = flagSpellings(TTL_ROW.env).find(sp => saved[sp] !== undefined)
  return {
    saved: savedSpelling !== undefined ? (saved[savedSpelling] ?? null) : null,
    envPin: realEnvPin(TTL_ROW.env),
    readError: null,
  }
}

interface FamilyCachingRow {
  route: CallModelRoute
  lines: string[]
  dial?: boolean
}

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

function familyRows(): FamilyCachingRow[] {
  return [
    {
      route: 'anthropic',
      dial: true,
      lines: [
        'how long Anthropic keeps your conversation cached between prompts — Anthropic calls only',
        `adaptive picks per session from how you actually work · 1h is explicit billing consent`,
        `cache economy: reads ${CACHE_COST.read}× input price · 5m writes ${CACHE_COST.write5m}× · 1h writes ${CACHE_COST.write1h}×`,
      ],
    },
    {
      route: 'openai',
      lines: [
        'automatic for prompts ≥1,024 tokens — no code changes, nothing to adjust',
        "GPT-5.6+: 30m TTL by default — prompt_cache_options.ttl also offers '12h', not asked for",
        'cached input 0.1× (GPT-6.1/6.2: 0.05×) · GPT-5.6+ cache writes 1.25× (observed 2026-11-17)',
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
    { route: 'zai', lines: ['no caching mechanism recorded for GLM — nothing to adjust'] },
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

function CachingSurface(arg0: { onDone: LocalJSXCommandOnDone }): React.ReactNode {
  return notBuilt('src/commands/caching/caching.tsx:119')
}

export const call: LocalJSXCommandCall = async (onDone, _context) => {
  return <CachingSurface onDone={onDone} />
}
