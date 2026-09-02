// ============================================================================
//  commands/enablement — THE ONE ENABLEMENT READ, world included.
//
//  A command's own `isEnabled` predicate answers for the build and the
//  session; THE PLAIN WORLD (the chat-mode law: `mercury --chat` for this
//  boot, or the concourse switched off for every boot) answers for the
//  concourse-only commands — those that declare `needsConcourse`; a RETIRED
//  door (`retired`) is never enabled in any world. One predicate here; the
//  registry (getCommands), the slash dispatcher's typed-unavailable line and
//  the effective catalogue all read it, so a concourse-only or retired
//  command leaves the table AND answers honestly when typed. The world fact
//  is the router's (surfaceRoute.chatOnlyBoot) — never a second flag.
//
//  Its own module (not commands.ts) because the effective catalogue sits in
//  the registry root's static graph and may not import it back.
// ============================================================================
import type { Command } from '../types/command.js'
import { isCommandEnabled as commandEnablement } from '../types/command.js'
import { chatOnlyBoot } from '../context/surfaceRoute.js'

/** The plain-world gate: a concourse-only command in a plain boot. Read
 *  live — the switch can flip through /config mid-session. */
export function commandOffInPlainWorld(command: Command): boolean {
  return command.needsConcourse === true && chatOnlyBoot()
}

/** The retired gate: the door's own reason, or undefined for a live one. */
export function commandRetired(command: Command): string | undefined {
  return command.retired
}

/** Enablement: the command's own predicate AND the plain-world gate AND
 *  not retired. */
export function isCommandEnabled(command: Command): boolean {
  return commandEnablement(command) && !commandOffInPlainWorld(command) && commandRetired(command) === undefined
}
