import { cpSync, existsSync, renameSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isKitSkillName } from '../../daemon/session-seat/sessionKit.js'
import { saveConfigWithLock } from '../../platform/config/globalConfig.js'
import { createDefaultGlobalConfig } from '../../platform/config/schema.js'
import { globalConfigFileIn } from '../../platform/environment/env.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { findSkillDirs, getSkillsPath } from './loadSkillsDir.js'

const SKILLS = 'skills'

export async function inheritSkills(home: string): Promise<{ ok: true; skills: string[] } | { ok: false; reason: string }> {
  const from = getSkillsPath('userSettings', SKILLS)
  const to = join(home, SKILLS)
  const config = globalConfigFileIn(home)
  if (!existsSync(from) || existsSync(to) || existsSync(config)) return { ok: true, skills: [] }
  const incoming = `${to}.incoming-${process.pid}`
  try {
    cpSync(from, incoming, { recursive: true })
    const found = (await findSkillDirs(incoming)) ?? []
    const skills = [...new Set(found.map(dir => basename(dir)).filter(isKitSkillName))].sort()
    if (skills.length > 0 && !saveConfigWithLock(config, createDefaultGlobalConfig, current => ({ ...current, inheritedSkillsOff: skills }))) {
      throw new Error(`${config} was not written`)
    }
    renameSync(incoming, to)
    return { ok: true, skills }
  } catch (error) {
    rmSync(incoming, { recursive: true, force: true })
    return { ok: false, reason: `The skills were not copied (${errorMessage(error)}): the new profile starts without them.` }
  }
}
