import type { Command } from '../../commands.js'

// ============================================================================
// commands/ledger/index.ts — `/ledger`: the evolution-ledger operator reader.
//
// Closes the reader-less half of the evolution-ledger substrate:
// rows were WRITTEN from three seams (the `ledger` workflow
// global, /party dispatch outcomes, memdir card decisions) but only
// /party→History could read them, scoped to one program. /ledger binds the
// pure rollups (frontier · outcome mix · subject drift) across ALL programs
// in both homes (repo .mercury/evolution + memdir).
//
// Deliberately
// NOT gated on MERCURY_EVOLUTION_LEDGER — reading is gate-independent
// (readEvolutionRows doctrine: past ledgers stay inspectable after opt-out);
// the view's header says when the writer is off.
// ============================================================================

const command = {
  type: 'local-jsx',
  name: 'ledger',
  description: 'Evolution ledger — improvement programs, frontier + drift, across repo + memdir',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./ledger.js'),
} satisfies Command

export default command
