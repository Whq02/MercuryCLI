import type { LlmHostRoad } from '../llmHost/index.js'
import { boxHardwareWords, discoverBox, listBoxes, readBox, type HostBox } from './boxes.js'
import { hostRunner, localKeyPath, type HostRunner } from './ssh.js'

export function createBoxRoad(runner: HostRunner = hostRunner): LlmHostRoad {
  return async (ask, emit, signal) => {
    const stopped = { ok: false, words: 'No computer changed.' }
    const question: Parameters<LlmHostRoad>[0] = plan => signal.aborted ? Promise.resolve(null) : ask(plan)
    try {
      const selected = await question({ step: 'boxes', title: 'One of my computers', found: 'Saved computers share their model with every Mercury session.', willRun: 'Read hardware, installed engines and model bank folders. No service starts yet.', rows: [{ value: 'this-computer', label: 'This computer' }, ...listBoxes().filter(box => box.name !== 'this-computer').map(box => ({ value: box.name, label: box.name + ' · ' + boxHardwareWords(box) })), { value: '__add__', label: 'Add a box over SSH' }] })
      if (!selected) return stopped
      let box: HostBox
      if (selected === '__add__') {
        const name = await question({ step: 'box-name', title: 'Name this computer', found: '1–28 lowercase letters, digits or hyphens', willRun: 'Save as a reusable computer.' }); if (!name) return stopped
        const host = await question({ step: 'ssh-host', title: 'SSH host or config alias', found: 'Use a host or an existing SSH config alias.', willRun: '' }); if (!host) return stopped
        const user = await question({ step: 'ssh-user', title: 'SSH user (blank uses SSH config)', found: host, willRun: '' }); if (user === null) return stopped
        const port = await question({ step: 'ssh-port', title: 'SSH port (blank uses SSH config)', found: host, willRun: '' }); if (port === null) return stopped
        const key = await question({ step: 'ssh-key', title: 'Private key path (blank uses SSH config or agent)', found: 'The private key stays here.', willRun: '' }); if (key === null) return stopped
        const os = await question({ step: 'box-os', title: 'Operating system on this computer', found: host, willRun: 'Windows uses PowerShell over SSH.', rows: [{ value: 'darwin', label: 'macOS' }, { value: 'linux', label: 'Linux' }, { value: 'windows', label: 'Windows' }] }); if (!os) return stopped
        if (!['darwin', 'linux', 'windows'].includes(os)) throw new Error('Choose a listed operating system.')
        box = await discoverBox({ name: name.trim(), kind: 'ssh', os: os as HostBox['os'], target: { host: host.trim(), ...(user.trim() ? { user: user.trim() } : {}), ...(port.trim() ? { port: Number(port) } : {}), key: localKeyPath(key.trim()) } }, runner, signal)
      } else {
        const saved = readBox(selected)
        if (!saved && selected !== 'this-computer') throw new Error('That computer is no longer saved.')
        box = await discoverBox(saved ?? { name: 'this-computer', kind: 'this-computer' }, runner, signal)
      }
      emit({ title: box.name, words: boxHardwareWords(box) })
      return { ok: true, words: box.name + ' · ' + boxHardwareWords(box) }
    } catch (error) { return { ok: false, words: signal.aborted ? 'Stopped reading this computer.' : String(error) } }
  }
}
