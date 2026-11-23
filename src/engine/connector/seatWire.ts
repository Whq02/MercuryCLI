import type { SessionRewindOutcomeV1 } from '../../daemon/control/protocol.js'
import type { SessionKitV1 } from '../../daemon/session-seat/sessionKit.js'
import type { SaturnFactsRowV1 } from '../../daemon/saturn/saturn.js'
import type { SessionVerbRow } from '../../daemon/runner-wire/sessionVerbs.js'
import type { SessionFactsAnswerV1 } from './seatProjections.js'

type KeyTable = Readonly<Record<string, string>>
type Row = Record<string, unknown>

interface ObjectSpec {
  readonly kind?: 'object'
  readonly keys?: KeyTable
  readonly children?: Readonly<Record<string, WireSpec>>
  readonly alwaysOwn?: readonly string[]
  readonly accept?: (raw: Row) => boolean
}

interface ListSpec {
  readonly kind: 'list'
  readonly item: WireSpec
}

type WireSpec = ObjectSpec | ListSpec

interface CompiledObjectSpec {
  readonly kind: 'object'
  readonly keys: KeyTable | undefined
  readonly children: readonly (readonly [string, CompiledSpec])[]
  readonly alwaysOwn: readonly string[] | undefined
  readonly accept?: (raw: Row) => boolean
}

interface CompiledListSpec {
  readonly kind: 'list'
  readonly item: CompiledSpec
}

type CompiledSpec = CompiledObjectSpec | CompiledListSpec

interface WireCodec<T, W, R> {
  readonly toWire: (value: T) => W
  readonly fromWire: (raw: unknown) => R
}

type SeatCodecName = Exclude<NonNullable<SessionVerbRow['codec']>, 'mcpTools'>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value)
const list = (item: WireSpec): ListSpec => ({ kind: 'list', item })

function flip(table: KeyTable): KeyTable {
  const out: Record<string, string> = {}
  for (const [key, wire] of Object.entries(table)) out[wire] = key
  return out
}

function compile(spec: WireSpec, dir: 'to' | 'from'): CompiledSpec {
  if (spec.kind === 'list') return { kind: 'list', item: compile(spec.item, dir) }
  const keys = spec.keys === undefined ? undefined : dir === 'to' ? spec.keys : flip(spec.keys)
  const children: [string, CompiledSpec][] = []
  if (spec.children !== undefined) {
    for (const [camelKey, child] of Object.entries(spec.children)) {
      const outKey = dir === 'to' && spec.keys !== undefined && Object.hasOwn(spec.keys, camelKey) ? spec.keys[camelKey]! : camelKey
      children.push([outKey, compile(child, dir)])
    }
  }
  return {
    kind: 'object',
    keys,
    children,
    alwaysOwn: spec.alwaysOwn,
    accept: dir === 'from' ? spec.accept : undefined,
  }
}

function applyCompiled(value: unknown, spec: CompiledSpec): unknown {
  if (spec.kind === 'list') {
    return Array.isArray(value) ? value.map(item => applyCompiled(item, spec.item)) : value
  }
  if (!isRow(value)) return value
  const table = spec.keys
  const out: Row = {}
  for (const [key, inner] of Object.entries(value)) {
    out[table !== undefined && Object.hasOwn(table, key) ? table[key]! : key] = inner
  }
  for (const [outKey, child] of spec.children) {
    if (Object.hasOwn(out, outKey)) {
      out[outKey] = applyCompiled(out[outKey], child)
    }
  }
  if (spec.alwaysOwn !== undefined) {
    for (const key of spec.alwaysOwn) {
      if (!Object.hasOwn(out, key)) out[key] = undefined
    }
  }
  return out
}

function wireCodec<T, W, R>(spec: WireSpec): WireCodec<T, W, R> {
  const toSpec = compile(spec, 'to')
  const fromSpec = compile(spec, 'from')
  return {
    toWire: value => applyCompiled(value, toSpec) as W,
    fromWire: raw => {
      if (fromSpec.kind !== 'list' && fromSpec.accept !== undefined && (!isRow(raw) || !fromSpec.accept(raw))) return null as R
      return applyCompiled(raw, fromSpec) as R
    },
  }
}

const WINDOW_SPEC: ObjectSpec = {
  keys: {
    observedAtMs: 'observed_at_ms',
    resetsAtMs: 'resets_at_ms',
  },
}

const BAND_SPEC: ObjectSpec = {
  keys: {
    usedPct: 'used_pct',
    windowMinutes: 'window_minutes',
    resetsAtMs: 'resets_at_ms',
    observedAtMs: 'observed_at_ms',
  },
}

const SCHEDULE_EDIT_SPEC: ObjectSpec = {
  keys: {
    scheduleId: 'schedule_id',
  },
  children: {
    schedule: {
      keys: {
        modelKey: 'model_key',
      },
      children: {
        when: {
          keys: {
            atMs: 'at_ms',
          },
        },
        action: {
          keys: {
            onParked: 'on_parked',
          },
          children: {
            birth: {
              keys: {
                workspaceDir: 'workspace_dir',
                modelKey: 'model_key',
                kitPreset: 'kit_preset',
              },
            },
          },
        },
      },
    },
  },
}

const KIT_SPEC: ObjectSpec = {
  keys: {
    mcpKnown: 'mcp_known',
    skillsOff: 'skills_off',
  },
  children: {
    deltas: {
      keys: {
        mcpOff: 'mcp_off',
        skillStates: 'skill_states',
        extensionsOff: 'extensions_off',
      },
    },
  },
}

const CATALOGUE_SPEC: ObjectSpec = {
  keys: {
    sourceKind: 'source_kind',
    fetchedAtMs: 'fetched_at_ms',
  },
}

const SCHEDULE_ROW_SPEC: ObjectSpec = {
  keys: {
    nextFireMs: 'next_fire_ms',
  },
}

const REWIND_SPEC: ObjectSpec = {
  keys: {
    dryRun: 'dry_run',
  },
  children: {
    code: {
      keys: {
        filesChanged: 'files_changed',
      },
    },
    conversation: {
      keys: {
        turnUuid: 'turn_uuid',
      },
    },
  },
  accept: raw =>
    (raw.outcome === 'applied' || raw.outcome === 'refused' || raw.outcome === 'noop') &&
    (raw.mode === 'code' || raw.mode === 'conversation' || raw.mode === 'both'),
}

const FACTS_SPEC: ObjectSpec = {
  keys: {
    recoveredCommandIds: 'recovered_command_ids',
    missionCard: 'mission_card',
    permissionMode: 'permission_mode',
    effortSent: 'effort_sent',
    pendingScheduleEdits: 'pending_schedule_edits',
    fileCheckpoints: 'file_checkpoints',
    streamIdleTimeoutMs: 'stream_idle_timeout_ms',
    spawnSwitches: 'spawn_switches',
    openaiCatalogue: 'openai_catalogue',
    pauseGate: 'pause_gate',
    editOutcomes: 'edit_outcomes',
    buildTree: 'build_tree',
    transcriptStoreFailing: 'transcript_store_failing',
  },
  alwaysOwn: ['usage', 'identity', 'workspace'],
  children: {
    usage: {
      keys: {
        totalCostUSD: 'total_cost_usd',
        totalAPIDurationMs: 'total_api_duration_ms',
        totalDurationMs: 'total_duration_ms',
        totalLinesAdded: 'total_lines_added',
        totalLinesRemoved: 'total_lines_removed',
        totalInputTokens: 'total_input_tokens',
        totalOutputTokens: 'total_output_tokens',
        totalCacheReadInputTokens: 'total_cache_read_input_tokens',
        totalCacheCreationInputTokens: 'total_cache_creation_input_tokens',
        hasUnknownModelCost: 'has_unknown_model_cost',
        unpricedTurns: 'unpriced_turns',
        modelSpend: 'model_spend',
        limitWarning: 'limit_warning',
        openaiObserved: 'openai_observed',
        anthropicWindow: 'anthropic_window',
        openaiWindow: 'openai_window',
        geminiWindow: 'gemini_window',
        openrouterWindow: 'openrouter_window',
        huggingfaceWindow: 'huggingface_window',
      },
      children: {
        context: {
          keys: {
            usedTokens: 'used_tokens',
            usedPct: 'used_pct',
            fillSource: 'fill_source',
            windowSource: 'window_source',
            windowPinned: 'window_pinned',
            windowReason: 'window_reason',
            compactAtPct: 'compact_at_pct',
            leftUntilCompactPct: 'left_until_compact_pct',
          },
        },
        modelSpend: list({
          keys: {
            inputTokens: 'input_tokens',
            outputTokens: 'output_tokens',
            cacheReadInputTokens: 'cache_read_input_tokens',
            cacheCreationInputTokens: 'cache_creation_input_tokens',
            costUSD: 'cost_usd',
            unpricedTurns: 'unpriced_turns',
            lastUsedAtMs: 'last_used_at_ms',
          },
        }),
        openaiObserved: {
          children: {
            primary: BAND_SPEC,
            secondary: BAND_SPEC,
          },
        },
        anthropicWindow: WINDOW_SPEC,
        openaiWindow: WINDOW_SPEC,
        geminiWindow: WINDOW_SPEC,
        openrouterWindow: WINDOW_SPEC,
        huggingfaceWindow: WINDOW_SPEC,
        jev: {
          keys: {
            lastCostUsd: 'last_cost_usd',
            lastRequestId: 'last_request_id',
            lastFailure: 'last_failure',
            spendUsd: 'spend_usd',
            inputTokens: 'input_tokens',
            unconfirmedCharges: 'unconfirmed_charges',
            holdUntilMs: 'hold_until_ms',
            lastAnsweredAtMs: 'last_answered_at_ms',
            lastModel: 'last_model',
          },
          children: {
            lastFailure: {
              keys: {
                requestId: 'request_id',
              },
            },
          },
        },
      },
    },
    identity: {
      keys: {
        firstPartyApi: 'first_party_api',
        consoleBilling: 'console_billing',
        claudeAiBilling: 'claude_ai_billing',
        accountEmail: 'account_email',
      },
    },
    workspace: {
      keys: {
        originalCwd: 'original_cwd',
        projectRoot: 'project_root',
      },
    },
    work: list({
      keys: {
        startTime: 'start_time',
        endTime: 'end_time',
        totalTokens: 'total_tokens',
        inputTokens: 'input_tokens',
        outputTokens: 'output_tokens',
        contextTokens: 'context_tokens',
        cacheReadTokens: 'cache_read_tokens',
        costUSD: 'cost_usd',
        unpricedTurns: 'unpriced_turns',
        toolUses: 'tool_uses',
        toolUseId: 'tool_use_id',
        workflowRunId: 'workflow_run_id',
        agentCount: 'agent_count',
        pendingAsks: 'pending_asks',
        pausedBy: 'paused_by',
        agentType: 'agent_type',
        stopReason: 'stop_reason',
        unreadNotices: 'unread_notices',
        outputFile: 'output_file',
        exitCode: 'exit_code',
      },
      children: {
        pulse: {
          keys: {
            phaseTitle: 'phase_title',
            maxAttempt: 'max_attempt',
            lastEventAt: 'last_event_at',
          },
        },
        phase: {
          keys: {
            sinceMs: 'since_ms',
            budgetMs: 'budget_ms',
            streamedChars: 'streamed_chars',
          },
        },
        paused: {
          keys: {
            resumesAtMs: 'resumes_at_ms',
          },
        },
      },
    }),
    mission: list({
      keys: {
        blockedBy: 'blocked_by',
        activeForm: 'active_form',
      },
    }),
    missionCard: {
      keys: {
        nextStep: 'next_step',
        setAt: 'set_at',
        updatedAt: 'updated_at',
      },
      children: {
        outcome: {
          keys: {
            metAt: 'met_at',
          },
        },
      },
    },
    samples: list({
      keys: {
        updatedAt: 'updated_at',
      },
    }),
    notices: list({
      keys: {
        agentId: 'agent_id',
        deliveredAtMs: 'delivered_at_ms',
        consumedAtMs: 'consumed_at_ms',
        nudgedAtMs: 'nudged_at_ms',
        retiredAtMs: 'retired_at_ms',
        retiredWhy: 'retired_why',
      },
    }),
    kit: KIT_SPEC,
    box: {
      keys: {
        atMs: 'at_ms',
        loadPerCore: 'load_per_core',
        lockNote: 'lock_note',
      },
      children: {
        memory: {
          keys: {
            availableMb: 'available_mb',
            totalMb: 'total_mb',
            sampledAtMs: 'sampled_at_ms',
          },
        },
        lock: {
          children: {
            waiters: list({
              keys: {
                waitedS: 'waited_s',
              },
            }),
          },
        },
      },
    },
    pendingScheduleEdits: list(SCHEDULE_EDIT_SPEC),
    openaiCatalogue: CATALOGUE_SPEC,
  },
  accept: raw =>
    isRow(raw.model) &&
    typeof raw.model.effective === 'string' &&
    isRow(raw.usage) &&
    typeof raw.usage.total_cost_usd === 'number' &&
    Array.isArray(raw.skills) &&
    Array.isArray(raw.mcp) &&
    typeof raw.permission_mode === 'string' &&
    isRow(raw.workspace) &&
    Array.isArray(raw.queue) &&
    (raw.recovered_command_ids === undefined ||
      (Array.isArray(raw.recovered_command_ids) && raw.recovered_command_ids.every(id => typeof id === 'string'))),
}

const SESSION_WIRE_CODECS = {
  scheduleEdit: wireCodec<unknown, unknown, unknown>(SCHEDULE_EDIT_SPEC),
  sessionFacts: wireCodec<SessionFactsAnswerV1, Record<string, unknown>, SessionFactsAnswerV1 | null>(FACTS_SPEC),
  rewindOutcome: wireCodec<SessionRewindOutcomeV1, Record<string, unknown>, SessionRewindOutcomeV1 | null>(REWIND_SPEC),
  sessionKit: wireCodec<SessionKitV1, Record<string, unknown>, unknown>(KIT_SPEC),
  scheduleRoster: wireCodec<readonly SaturnFactsRowV1[], Record<string, unknown>[], unknown>(list(SCHEDULE_ROW_SPEC)),
  openaiCatalogue: wireCodec<{ sourceKind: string; models: unknown[]; fetchedAtMs: number }, Record<string, unknown>, unknown>(CATALOGUE_SPEC),
} satisfies Record<SeatCodecName, WireCodec<never, unknown, unknown>>

export const scheduleEditToWire = SESSION_WIRE_CODECS.scheduleEdit.toWire
export const scheduleEditFromWire = SESSION_WIRE_CODECS.scheduleEdit.fromWire
export const sessionFactsToWire = SESSION_WIRE_CODECS.sessionFacts.toWire
export const sessionFactsFromWire = SESSION_WIRE_CODECS.sessionFacts.fromWire
export const rewindOutcomeToWire = SESSION_WIRE_CODECS.rewindOutcome.toWire
export const rewindOutcomeFromWire = SESSION_WIRE_CODECS.rewindOutcome.fromWire
export const sessionKitToWire = SESSION_WIRE_CODECS.sessionKit.toWire
export const sessionKitFromWire = SESSION_WIRE_CODECS.sessionKit.fromWire
export const scheduleRosterToWire = SESSION_WIRE_CODECS.scheduleRoster.toWire
export const scheduleRosterFromWire = SESSION_WIRE_CODECS.scheduleRoster.fromWire
export const openaiCatalogueToWire = SESSION_WIRE_CODECS.openaiCatalogue.toWire
export const openaiCatalogueFromWire = SESSION_WIRE_CODECS.openaiCatalogue.fromWire
