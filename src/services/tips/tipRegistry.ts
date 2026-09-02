/**
 * The spinner-tip catalogue plus relevance filtering and selection.
 *
 * The catalogue is TWO lists concatenated in order — the general list then an
 * internal-only list that is EMPTY in this build — and the concatenation
 * order is observable through selection ties, so it is kept.
 *
 * Relevance predicates are evaluated as ONE all-or-nothing concurrent join:
 * a single rejection rejects the whole registry read (there is no
 * per-predicate rescue at this level), so a predicate that reaches a throwing
 * source must guard itself. The scheduler's caller must tolerate a rejection.
 *
 * Every tip names a real, currently-available surface, teaches one move, and
 * fits the spinner tail on one line at 100 columns (scripts/ui/
 * prove-spinner-tips.ts pins the width, the ids, and that every advertised
 * slash command exists). Tip copy is authored here; only ONE source line may
 * mention a home directory (the skills-location tip), per the home-literal
 * prose census.
 */
import { getGlobalConfig } from '../../utils/config.js'
import { chatOnlyBoot } from '../../context/surfaceRoute.js'
import { getInitialSettings, getSettingsForSource } from '../../utils/settings/settings.js'
import { actionAffordance } from '../../keybindings/atlas.js'
import { loadKeybindingsSync } from '../../keybindings/loadUserBindings.js'
import { getPlatform } from '../../utils/platform.js'
import type { Tip, TipContext } from './types.js'
import { getSessionsSinceLastShown } from './tipHistory.js'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Chord for a Chat action, from the keybinding formatter, with a literal
 *  fallback — never a hardcoded chord. Self-guarding (a throwing load yields
 *  the fallback). */
function chordForChatAction(action: string, fallback: string): string {
  try {
    const affordance = actionAffordance(action, 'Chat', loadKeybindingsSync())
    return affordance.kind === 'unbound' ? fallback : affordance.chord
  } catch {
    return fallback
  }
}

/** True when the terminal is the macOS system terminal (needs the option
 *  binding); everything else uses shift+enter. Contract data identity value. */
function isAppleTerminal(): boolean {
  return process.env.TERM_PROGRAM === 'Apple_Terminal'
}

/** Days since a timestamp; an absent timestamp reads as infinitely long ago. */
function daysSince(timestamp: number | undefined): number {
  if (timestamp === undefined) return Number.POSITIVE_INFINITY
  return (Date.now() - timestamp) / (24 * 60 * 60 * 1000)
}

// ---------------------------------------------------------------------------
// The general catalogue. Weighted toward
// the moves a working operator reaches for: the multi-provider catalogue and
// switching, the session boards, memory, the mode carousel, THEMIS, caching,
// resume/rewind, and the review surfaces. One move per tip; the copy states
// what IS (truths, not promises).
// ---------------------------------------------------------------------------

const GENERAL_TIPS: Tip[] = [
  // ── the mode carousel ────────────────────────────────────────────────────
  {
    id: 'cycle-mode',
    cooldownSessions: 5,
    async content() {
      const chord = chordForChatAction('chat:cycleMode', 'shift+tab')
      return `Press ${chord} to cycle the permission mode — how much Mercury may do without asking.`
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'apollo-interview',
    cooldownSessions: 10,
    async content() {
      return 'Apollo mode interviews you before the build — the closing review asks your go.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'strategy-first',
    cooldownSessions: 20,
    async content() {
      return 'Ask for the plan first — strategy mode drafts it and acts only on your yes.'
    },
    async isRelevant() {
      // Nudge only if strategy mode has not been used recently.
      return daysSince(getGlobalConfig().lastPlanModeUse) > 7
    },
  },

  // ── the provider catalogue ───────────────────────────────────────────────
  {
    id: 'multi-family',
    cooldownSessions: 8,
    async content() {
      return 'Sign into more providers with /logins — /model then switches the family mid-session.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'accounts-board',
    cooldownSessions: 20,
    async content() {
      return '/accounts shows every provider slot with its live-verified identity — tokens never shown.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'usage-meters',
    cooldownSessions: 20,
    async content() {
      return '/usage meters every signed-in account; where a lane reports nothing, it says so.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'caching-truth',
    cooldownSessions: 20,
    async content() {
      return "/caching shows every provider family's cache truth — and the TTL dial where one exists."
    },
    async isRelevant() {
      return true
    },
  },

  // ── the session boards ───────────────────────────────────────────────────
  // THE PLAIN WORLD (a `--chat` boot, the concourse switched off) has no
  // board: the board tips stay silent there (the concourse's own tip too —
  // /concourse opens the plain live view, not a board), never a pointer to
  // a screen or a command this boot does not have. chatOnlyBoot guards its
  // own config read.
  {
    id: 'concourse-board',
    cooldownSessions: 8,
    async content() {
      return "/concourse boards this project's sessions — live status, step into the one that needs you."
    },
    async isRelevant() {
      return !chatOnlyBoot()
    },
  },
  {
    id: 'sessions-switch',
    cooldownSessions: 12,
    async content() {
      return '/sessions swaps sessions in place — the current pauses, state kept; switch back anytime.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'workflows-board',
    cooldownSessions: 20,
    async content() {
      return 'Workflows are scripted multi-step agent runs — /workflows boards the active and the past.'
    },
    async isRelevant() {
      return !chatOnlyBoot()
    },
  },

  // ── memory ───────────────────────────────────────────────────────────────
  {
    id: 'memory-note',
    cooldownSessions: 12,
    async content() {
      return 'Start a message with # to bank a durable note — later sessions load it on their own.'
    },
    async isRelevant() {
      return (getGlobalConfig().memoryUsageCount ?? 0) === 0
    },
  },
  {
    id: 'remember-card',
    cooldownSessions: 15,
    async content() {
      return '/remember banks a lesson as a card; /remember project: <rule> records a house convention.'
    },
    async isRelevant() {
      return true
    },
  },

  // ── run discipline ───────────────────────────────────────────────────────
  {
    id: 'themis-mission',
    cooldownSessions: 15,
    async content() {
      return '/themis start opens a bounded mission — named criteria, drift warnings, done only on evidence.'
    },
    async isRelevant() {
      return true
    },
  },

  // ── continuity ───────────────────────────────────────────────────────────
  {
    id: 'resume-session',
    cooldownSessions: 10,
    async content() {
      return 'mercury --continue reopens the last session; /resume lists them all to pick up any.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'rewind-checkpoint',
    cooldownSessions: 10,
    async content() {
      return '/rewind winds back code, conversation, or both — pick the saved point to return to.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'compact-fold',
    cooldownSessions: 15,
    async content() {
      return '/compact folds the conversation into a summary and keeps going — steer it with instructions.'
    },
    async isRelevant() {
      return true
    },
  },

  // ── the review surfaces ──────────────────────────────────────────────────
  {
    id: 'review-surfaces',
    cooldownSessions: 15,
    async content() {
      return "/review reads a pull request; /diff reviews the workspace's uncommitted changes."
    },
    async isRelevant() {
      return true
    },
  },

  // ── composer moves ───────────────────────────────────────────────────────
  {
    id: 'prompt-queue',
    cooldownSessions: 12,
    async content() {
      return 'Keep typing while Mercury works — the queued message runs next, in order.'
    },
    async isRelevant() {
      return (getGlobalConfig().promptQueueUseCount ?? 0) === 0
    },
  },
  {
    id: 'newline-terminal',
    cooldownSessions: 25,
    async content() {
      // Apple Terminal needs the option binding; elsewhere shift+enter.
      return isAppleTerminal()
        ? 'Add a newline with option+enter.'
        : 'Add a newline with shift+enter.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'image-paste',
    cooldownSessions: 25,
    async content() {
      const chord = chordForChatAction('chat:imagePaste', 'ctrl+v')
      return `Paste a screenshot straight from the clipboard with ${chord}.`
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'bang-shell',
    cooldownSessions: 20,
    async content() {
      return 'Start with ! to run a shell command yourself; the output joins the conversation.'
    },
    async isRelevant() {
      return true
    },
  },

  // ── the cockpit's dials ──────────────────────────────────────────────────
  {
    id: 'mouse-toggle',
    cooldownSessions: 30,
    async content() {
      return "/mouse toggles mouse capture — off keeps the terminal's native select and copy."
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'submodels-seats',
    cooldownSessions: 25,
    async content() {
      return '/submodels seats the side models — Console for side questions, Minerva for the notepad.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'appearance-command',
    cooldownSessions: 25,
    async content() {
      return '/appearance holds the look — theme, accent, and motion in one center.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'effort',
    cooldownSessions: 20,
    async content() {
      return '/effort dials how hard the model thinks — spend it on the gnarly work.'
    },
    async isRelevant() {
      // The effort tip reads the policy layer as a single source (unguarded
      // per the catalogue's shape) — the setting merely gates the surface.
      return getSettingsForSource('policySettings')?.effortLevel === undefined
    },
  },
  {
    id: 'skills-location',
    cooldownSessions: 30,
    async content() {
      return 'Skills load on their own from .mercury/skills/ or ~/.mercury/skills/ — drop one in.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'powershell-tool',
    cooldownSessions: 20,
    async content() {
      // Advertise the product-native spelling only.
      return 'Set MERCURY_USE_POWERSHELL_TOOL=1 to run Windows commands through PowerShell.'
    },
    async isRelevant() {
      if (getPlatform() !== 'windows') return false
      // Quiet when the gate is already set.
      return process.env.MERCURY_USE_POWERSHELL_TOOL === undefined
    },
  },
]

// The internal-only list — EMPTY in this build. The concatenation order is
// observable through selection ties, so it is kept.
const INTERNAL_TIPS: Tip[] = []

const CATALOGUE: Tip[] = [...GENERAL_TIPS, ...INTERNAL_TIPS]

// ---------------------------------------------------------------------------
// Custom operator override
// ---------------------------------------------------------------------------

/** Custom tips: generated ids, zero cooldown, always relevant. Read from the
 *  INITIAL-settings snapshot. */
function getCustomTips(): { tips: Tip[]; excludeDefault: boolean } {
  const override = getInitialSettings().spinnerTipsOverride as
    | { tips?: unknown; excludeDefault?: unknown }
    | undefined
  const rawTips = Array.isArray(override?.tips) ? (override?.tips as unknown[]) : []
  const strings = rawTips.filter((entry): entry is string => typeof entry === 'string')
  const tips: Tip[] = strings.map((text, index) => ({
    id: `custom-${index}`,
    cooldownSessions: 0,
    content: async () => text,
    isRelevant: async () => true,
  }))
  return { tips, excludeDefault: override?.excludeDefault === true }
}

// ---------------------------------------------------------------------------
// Relevance filtering
// ---------------------------------------------------------------------------

/**
 * The relevant tips for this context. Built-in predicates run as ONE
 * all-or-nothing concurrent join (a rejection propagates), then filtered by
 * predicate result and by cooldown (eligible again AT the cooldown, not
 * after). Custom tips are appended after and bypass BOTH filters.
 *
 * When the exclude flag is set AND at least one custom tip exists, built-ins
 * are skipped entirely and the custom list is returned as-is.
 */
export async function getRelevantTips(context?: TipContext): Promise<Tip[]> {
  const { tips: customTips, excludeDefault } = getCustomTips()
  if (excludeDefault && customTips.length > 0) {
    return customTips
  }

  // All-or-nothing: every predicate is started; one rejection rejects the read.
  const verdicts = await Promise.all(CATALOGUE.map(tip => tip.isRelevant(context)))
  const relevant = CATALOGUE.filter((tip, index) => verdicts[index])
  const afterCooldown = relevant.filter(
    tip => getSessionsSinceLastShown(tip.id) >= tip.cooldownSessions,
  )
  return [...afterCooldown, ...customTips]
}
