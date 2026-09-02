// ============================================================================
//  src/bootstrap/runtime/model-config.ts — the model-config family owner
//
//
//  Scope: SESSION — set at boot / by the operator's model switch; survives
//  /clear and /compact; resetStateForTests rebuilds the instance.
//
//  BOOTSTRAP-ISOLATION LEAF (the same custom-rules/bootstrap-isolation
//  convention state.ts carries): this module imports ONLY types. No
//  src/utils value imports. src/bootstrap/state.ts is the ONLY sanctioned
//  importer; every consumer goes through the frozen facade.
// ============================================================================
import type { ModelSetting } from 'src/utils/model/model.js'
import type { ModelStrings } from 'src/utils/model/modelStrings.js'

export class ModelConfigOwner {
  mainLoopModelOverride: ModelSetting | undefined = undefined
  initialMainLoopModel: ModelSetting = null
  modelStrings: ModelStrings | null = null
  // SDK-provided betas (e.g., context-1m-2025-08-07)
  sdkBetas: string[] | undefined = undefined
}
