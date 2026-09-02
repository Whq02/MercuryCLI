// the response-immediacy + honest work-visibility layer.
//
// One turn identity (the generation) keys BOTH surfaces:
//   turnTrace.ts  — the monotonic per-turn trace + bounded summary ring
//                   (timing source of truth: pulseNow / performance.now)
//   turnPhase.ts  — the authoritative turn-phase state machine
//                   (phase source of truth; SpinnerMode is a projection)

export {
  beginPhaseGeneration,
  computeDisplayPhase,
  finishPhaseGeneration,
  getPulseActivity,
  getPulsePhase,
  notePulseStreamActivity,
  projectSpinnerMode,
  pulseNow,
  resetPhaseForTests,
  setPulseClockForTests,
  setPulsePhase,
  subscribePulsePhase,
  usePulsePhase,
  type PhaseDetail,
  type PreparingReason,
  type PulseStreamActivity,
  type StreamKind,
  type TurnPhaseName,
  type TurnPhaseSnapshot,
} from './turnPhase.js'

export {
  armPulseTerminalWriteMark,
  beginPulseTurn,
  completePulseTurn,
  getActivePulseTrace,
  getLatestPulseTrace,
  getPulseRing,
  isPulseMainSource,
  notePulseFrameWritten,
  notePulseModel,
  pulseMark,
  pulsePercentile,
  pulseStageEnd,
  pulseStageStart,
  recordPulseProducer,
  resetPulseForTests,
  type PulseEvent,
  type PulseEventData,
  type PulsePointName,
  type PulseProducerOutcome,
  type PulseProducerRecord,
  type PulseStageName,
  type PulseTurnStatus,
  type PulseTurnSummary,
  type TurnTrace,
} from './turnTrace.js'
