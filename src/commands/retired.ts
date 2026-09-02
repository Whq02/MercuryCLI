import type { Command, LocalCommandCall } from '../types/command.js'

export const RETIRED_MULTIPLAYER_REASON =
  'a new multiplayer is being built on the channel; nothing to run here'

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
  { name: 'say', was: 'operator chatter over the local channel room' },
]

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
