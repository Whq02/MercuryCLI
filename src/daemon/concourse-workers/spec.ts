import { logForDebugging } from '../../platform/logs/debugLog.js'
import { flagSpellings, flagPair, flagEnv } from '../../platform/substrate/flagRegistry.js'
import { foldLegacyWorkerModelKey } from '../../screen/concourse-model/workerModels.js'
import { HEADLESS_PERMISSION_MODES, type SeatPermissionMode, type HeadlessPermissionMode, type RunnerChildSpec, getHeadlessPermissionMode, headlessPermissionModeTyped } from '../runner-link/headlessRun.js'
import type { PermissionMode } from '../../permissions/rules/permissions.js'
import { resolveSavedPermissionMode } from '../../permissions/rules/permissionSetup.js'
import { getProjectDir } from '../../sessions/transcripts/paths.js'
import { backgroundWorkerDelegationSentence } from '../switchboard/backgroundLaunch.js'
import type { SessionKitV1 } from '../session-seat/sessionKit.js'
import { SESSION_KIND_ENV, type SessionKind, parseSessionKind } from './sessionKind.js'
import { effectiveSeatCeiling } from './admission.js'
import type { ConcourseWorkerRecordV1 } from './record.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { isOneOf } from '../../platform/primitives/isOneOf.js'

export function concourseWorkerStripEnv(): string[] {
  return [
    'MERCURY_SPLASH_HANDOFF',
    'MERCURY_ALT_HELD',
    'MERCURY_LAUNCH_ID',
    'MERCURY_SESSION_KIT',
    SESSION_KIND_ENV,
  ].flatMap(flagSpellings)
}

export function seatInitialPermissionMode(override?: PermissionMode): SeatPermissionMode {
  const asHeadless = (mode: string | undefined): HeadlessPermissionMode | undefined => {
    if (mode === undefined || mode.length === 0) return undefined
    return isOneOf(HEADLESS_PERMISSION_MODES, mode) ? mode : undefined
  }
  if (override === 'apollo') return 'apollo'
  const carried = asHeadless(override)
  if (carried !== undefined) return carried
  try {
    const saved = resolveSavedPermissionMode()
    if (saved !== undefined) {
      if (saved.notification !== undefined) logForDebugging(`[daemon] ${saved.notification}`)
      return saved.mode === 'apollo' ? 'apollo' : (asHeadless(saved.mode) ?? 'default')
    }
  } catch (error) {
    passedOver(error)
  }
  return 'default'
}

export function buildConcourseWorkerSpec(args: {
  runnerId: string
  sessionId?: string
  workspaceId: string
  modelKey: string
  keyless?: true
  effort?: string
  title?: string
  resume?: boolean
  cwd?: string
  permissionMode?: PermissionMode
  permissionModeTyped?: true
  bypassConsent?: true
  runnerArgv?: readonly string[]
  warm?: boolean
  kit?: SessionKitV1
  restartReason?: string
  kind?: SessionKind
}): RunnerChildSpec {
  const runnerArgv = args.runnerArgv ?? []
  const permissionMode = seatInitialPermissionMode(args.permissionMode)
  return {
    model: foldLegacyWorkerModelKey(args.modelKey),
    ...(args.keyless ? { keyless: true } : {}),
    effort: args.effort ?? 'high',
    appendSystemPrompt: [
      "This session lives on the operator's switchboard: the operator opens it to work in it and leaves it running otherwise, and either way their messages reach you through the harness.",
      backgroundWorkerDelegationSentence(),
      "'Idle', 'wait', or 'stand by' means end your turn — the harness wakes you on the next delivery. Never hold a turn open with sleeps or timers to stay available.",
    ].join('\n'),
    role: 'MERCURY_CONCOURSE_WORKER',
    agentName: args.runnerId,
    agentId: `${args.runnerId}@concourse`,
    cwd: args.cwd ?? args.workspaceId,
    extraEnv: {
      ...flagPair('MERCURY_SESSION_HOME', getProjectDir(args.workspaceId)),
      ...flagPair('MERCURY_SEATS', String(effectiveSeatCeiling())),
      ...(args.kit !== undefined ? { ...flagPair('MERCURY_SESSION_KIT', JSON.stringify(args.kit)) } : {}),
      ...(args.restartReason !== undefined ? { ...flagPair('MERCURY_RUNNER_RESTART_REASON', args.restartReason) } : {}),
      ...(args.kind !== undefined ? { ...flagPair(SESSION_KIND_ENV, args.kind) } : {}),
    },
    permissionMode,
    ...(args.permissionModeTyped === true && permissionMode === args.permissionMode ? { permissionModeTyped: true as const } : {}),
    ...(args.bypassConsent === true ? { allowBypass: true as const } : {}),
    stripEnv: concourseWorkerStripEnv(),
    partialRows: true,
    extraArgv: args.warm
      ? []
      : args.resume
        ? ['--resume', args.sessionId!, ...runnerArgv]
        : [
            '--session-id',
            args.sessionId!,
            ...(args.title !== undefined ? ['--title', args.title] : []),
            ...runnerArgv,
          ],
    respawnExtraArgv: args.warm ? [] : ['--resume', args.sessionId!, ...runnerArgv],
  }
}

export function spawnPostureOf(spec: Pick<RunnerChildSpec, 'permissionMode' | 'permissionModeTyped' | 'allowBypass' | 'extraEnv'>): { permissionMode: SeatPermissionMode; permissionModeTyped?: true; bypassConsent?: true; kind?: SessionKind } {
  const kind = sessionKindOfSpec(spec)
  return {
    permissionMode: getHeadlessPermissionMode(spec.permissionMode),
    ...(headlessPermissionModeTyped(spec) ? { permissionModeTyped: true as const } : {}),
    ...(spec.allowBypass === true ? { bypassConsent: true as const } : {}),
    ...(kind !== undefined ? { kind } : {}),
  }
}

export function stampSpawnPosture(rec: ConcourseWorkerRecordV1, posture: { permissionMode: SeatPermissionMode; permissionModeTyped?: true; bypassConsent?: true; kind?: SessionKind }): void {
  rec.permissionMode = posture.permissionMode
  if (posture.permissionModeTyped === true) rec.permissionModeTyped = true
  else delete rec.permissionModeTyped
  if (posture.bypassConsent === true) rec.bypassConsent = true
  else delete rec.bypassConsent
  if (posture.kind !== undefined) rec.kind = posture.kind
  else delete rec.kind
}

export function sessionKindOfSpec(spec: Pick<RunnerChildSpec, 'extraEnv'>): SessionKind | undefined {
  return parseSessionKind(flagEnv(SESSION_KIND_ENV, spec.extraEnv ?? {}))
}
