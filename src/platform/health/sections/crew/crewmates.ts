import { errorMessage, getErrnoCode, isENOENT } from '../../../errors/errors.js'
import type { CheckSpec } from '../../healthReport.js'
import { passedOver } from '../../../errors/passedOver.js'

export function permissionPostureCheck(): CheckSpec {
  return {
    id: 'permission-posture',
    label: 'Sovereign mode',
    run: async () => {
      const { getCurrentProjectConfig, getProjectPathForConfig } = await import('../../../config/projectConfig.js')
      const { flagEnv } = await import('../../../substrate/flagRegistry.js')
      const { isEnvTruthy } = await import('../../../environment/envUtils.js')
      const posture = getCurrentProjectConfig().permissionPosture
      const envArmedNow = isEnvTruthy(flagEnv('MERCURY_SKIP_PERMISSIONS'))
      const OFF = 'sovereign mode off — every permission question is asked (files, commands, the first act of the session for computer use)'
      if (!posture) {
        if (envArmedNow) {
          return {
            status: 'warn',
            evidence:
              "sovereign mode is armed by the Boot Menu's Sovereign mode row (standing consent) but NO posture record exists yet for this project — the record is written by an interactive boot in the project's own folder",
            fix: `Open Mercury interactively once in this project (${getProjectPathForConfig()}) — its boot records the permission composition; an interactive Mercury open in another folder records that folder's.`,
          }
        }
        return { status: 'ok', evidence: `${OFF} · no posture recorded yet for this project` }
      }
      const trust = posture.trustDialogAccepted ? 'trust dialog accepted' : 'trust dialog NOT accepted'
      if (posture.mode === 'bypass') {
        const armed =
          posture.armedBy === 'env-standing-consent'
            ? "saved in the Boot Menu's Sovereign mode row (standing consent)"
            : posture.armedBy === 'cli-flag'
              ? 'armed by the launch flag'
              : "armed by the session's own choice"
        const dialog =
          posture.consentDialog === 'suppressed-by-standing-consent'
            ? 'consent dialog suppressed by settings'
            : 'consent dialog shown and accepted'
        return { status: 'ok', evidence: `sovereign mode on — no permission question is asked, computer use included · ${armed} · ${dialog} · ${trust}` }
      }
      return { status: 'ok', evidence: `${OFF} · ${trust}` }
    },
  }
}

export function imageDecodeCheck(): CheckSpec {
  return {
    id: 'image-decode',
    label: 'Inline image decode',
    run: async () => {
      const { detectImageProtocol } = await import(
        '../../../../screen/image-display/imageDisplay.js'
      )
      const tier = detectImageProtocol()
      try {
        await import('sharp')
        return {
          status: 'ok',
          evidence: `native decode available · detected tier: ${tier}`,
        }
      } catch (e) {
        return {
          status: 'warn',
          evidence: `images render as file links on this install — native decode unavailable (${(e as Error)?.message?.slice(0, 120) ?? 'import failed'}); detected tier: ${tier}`,
          fix: 'Reinstall via `mercury update` to restore the bundled image binding; iTerm2, WezTerm and kitty render PNGs natively regardless.',
        }
      }
    },
  }
}

export function agentDefinitionsCheck(): CheckSpec {
  return {
    id: 'agent-definitions',
    label: 'Agent definitions',
    run: async () => {
      const { readdirSync } = await import('node:fs')
      const { join } = await import('node:path')
      const { getMercuryHome } = await import('../../../environment/envUtils.js')
      const { projectLocalPath } = await import('../../../project-local/paths.js')
      const { getOriginalCwd } = await import('../../../../boot/process-state/processState.js')
      const userDir = join(getMercuryHome(), 'agents')
      let projectDir = ''
      try {
        projectDir = projectLocalPath(getOriginalCwd(), 'agents')
      } catch (error) {
        passedOver(error)
      }
      const describeDir = (label: string, dir: string): string => {
        if (!dir) return `${label} dir absent`
        try {
          const count = readdirSync(dir).filter(f => f.endsWith('.md')).length
          return `${label} ${count} .md file(s)`
        } catch (error) {
          if (isENOENT(error) || getErrnoCode(error) === 'ENOTDIR') return `${label} dir absent`
          return `${label} dir unreadable (${errorMessage(error)})`
        }
      }
      const parts = [describeDir('user', userDir), describeDir('project', projectDir)]
      return { status: 'info', evidence: `${parts.join(' · ')} — files on disk; a nameless .md is a reference document, so the loaded roster (mercury roster) can be smaller` }
    },
  }
}

export function seatsCheck(): CheckSpec {
  return {
    id: 'seats',
    label: 'Seats',
    run: async () => {
      const { seatCeilingFacts, seatCeilingValueWords, seatCostWarning } = await import('../../../../daemon/switchboard-capacity/capacityCheck.js')
      const { liveCeilingFacts, composeGovernorCeilings, composeProvenance } = await import('../../../../crew/capacity/composeCeilings.js')
      const { seatNarrowingWords } = await import('../../../../crew/capacity/seatWords.js')
      const facts = seatCeilingFacts()
      const live = liveCeilingFacts(null)
      const composed = composeGovernorCeilings(live)
      const provenance = composeProvenance(live, composed)
      const narrowed = seatNarrowingWords(provenance.narrowing)
      const warning = seatCostWarning(facts)
      const lanes = `${composed.delegationLanes} delegated lane${composed.delegationLanes === 1 ? '' : 's'} for the crew`
      return {
        status: narrowed !== null || warning !== null ? 'info' : 'ok',
        evidence: `${seatCeilingValueWords(facts)} · ${facts.readingSentence} · ${lanes}${narrowed !== null ? ` — ${narrowed}` : ' (the seats)'}`,
        detail: `Sessions and crewmates all run under this one number; a seat is held only while a model call is in flight, and a call past the ceiling waits with its row saying so.${warning !== null ? ` ${warning}.` : ''} Setting: ${facts.lever}.`,
      }
    },
  }
}

export function swarmCheck(): CheckSpec {
  return {
    id: 'swarm',
    label: 'Swarm',
    run: async () => {
      const { swarmMasterEnabled, swarmSessionEnabled } = await import('../../../../crew/board/seam.js')
      const master = swarmMasterEnabled()
      return {
        status: master ? 'ok' : 'off',
        evidence: master ? `Swarm ${swarmSessionEnabled() ? 'on' : 'off'} for new crewmates` : 'Swarm off',
        detail: 'swarm.enabled in user settings.json is the master switch; /swarm on enables this session for subsequently launched crewmates.',
        link: '/config',
      }
    },
  }
}

export function spawnSwitchesCheck(): CheckSpec {
  return {
    id: 'spawn-switches',
    label: 'Crewmates',
    run: async () => {
      const { spawnSwitchFacts, spawnSwitchLine } = await import('../../../../daemon/switchboard/spawnSwitches.js')
      const { BACKGROUND_LAUNCH_LABEL, backgroundSessionsLaunchCrewmates } = await import('../../../../daemon/switchboard/backgroundLaunch.js')
      const { getFocusedSessionConnector, hasFocusedSession } = await import('../../../../engine/connector/focusedConnector.js')
      const focused = hasFocusedSession()
      const facts = focused ? getFocusedSessionConnector().spawnSwitches() : spawnSwitchFacts()
      const scope = focused ? 'the focused session' : 'this process — the next session is born with it'
      const anyOff = !facts.subagents.on
      const backgrounded = backgroundSessionsLaunchCrewmates() ? ` · backgrounded sessions launch too (${BACKGROUND_LAUNCH_LABEL} on)` : ''
      return {
        status: anyOff ? 'info' : 'ok',
        evidence: `${spawnSwitchLine('subagents', facts.subagents)} — ${scope}${backgrounded}`,
        detail: 'Flip a running session with /crewmates on|off (at its next turn boundary); the boot menu\'s Agents section sets the next session\'s default. Off: the Crewmate tool is absent from the roster and every spawn road answers one receipt.',
        link: '/bootmenu',
      }
    },
  }
}
