// ============================================================================
//  commands/retired — the retired doors of the old multiplayer.
//
//  The two multiplayer modes (the session-room fabric with its two-user
//  commands, and the router party with its seat board) left the product
//  whole; a new multiplayer is being designed from zero on the daemon-
//  session model and the extracted channel primitive. Until it lands, the
//  names these doors owned stay REGISTERED so a typed /name answers the
//  honest sentence below — the plain-world honesty grammar, never "Unknown
//  skill" — while none of them is enabled or listed anywhere (the one
//  enablement read folds `retired` in; the palette, /help and the typeahead
//  filter hidden commands).
// ============================================================================
import type { Command, LocalCommandCall } from '../types/command.js'

/** Completes "The /name command is retired — …". One sentence, one owner. */
export const RETIRED_MULTIPLAYER_REASON =
  'a new multiplayer is being built on the channel; nothing to run here'

/** The retired command names — the spellings the old estate registered. */
export const RETIRED_MULTIPLAYER_COMMANDS: ReadonlyArray<{
  name: string
  aliases?: string[]
  was: string
}> = [
  { name: 'party', was: 'the router party seat board' },
  { name: 'multiplayer', aliases: ['rooms'], was: 'the live room board' },
  { name: 'share', was: 'mirroring an excerpt onto the party channel' },
  { name: 'invite', was: 'minting a join token for a second person' },
  { name: 'handoff', was: 'handing the steering helm to a guest' },
  { name: 'delegate', was: "setting a peer's trust role or budget" },
  { name: 'prompt', was: "proposing a prompt for the owner's session" },
  { name: 'request', was: 'filing a delegated-work ticket' },
  { name: 'tickets', was: 'the delegated-work queue board' },
  // Operator ruling: "Retire /say but keep the wire so that it
  // stays for the agents" — the door retires; the local channel bus and its
  // programmatic send API stay untouched.
  { name: 'say', was: 'operator chatter over the local channel room' },
]

/** The typed answer, should a caller ever reach the body: the same sentence
 *  the dispatcher paints before any body runs. */
const call: LocalCommandCall = async () => ({
  type: 'text',
  value: `This command is retired — ${RETIRED_MULTIPLAYER_REASON}.`,
})

export const retiredMultiplayerCommands: readonly Command[] = RETIRED_MULTIPLAYER_COMMANDS.map(
  ({ name, aliases, was }) =>
    ({
      type: 'local',
      name,
      ...(aliases ? { aliases } : {}),
      description: `Retired — was ${was}`,
      retired: RETIRED_MULTIPLAYER_REASON,
      isHidden: true,
      supportsNonInteractive: true,
      load: () => Promise.resolve({ call }),
    }) satisfies Command,
)
