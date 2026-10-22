import type { HostRecipe } from './recipes.js'
import { gigabytes } from './volumes.js'

export interface DownloadWatchOptions { deadlineSeconds?: number; stallSeconds?: number; stallBytes?: number; stallPollSeconds?: number; netDevPath?: string }
const keptStall = { seconds: 600, bytes: 1e9, pollSeconds: 30 }
export const keptStallWords = 'under ' + keptStall.bytes / 1e9 + ' GB in ' + keptStall.seconds / 60 + ' min'
export const keptDownloadMinutes = (recipe: HostRecipe): number => 30 + Math.ceil(recipe.weightsGb / 6)
export const keptRunMs = (recipe: HostRecipe): number => (90 + Math.ceil(recipe.weightsGb / 4)) * 60_000

export function downloadWatchScript(expectedBytes: number, options: DownloadWatchOptions = {}): string {
  return `stall_seconds = ${options.stallSeconds ?? keptStall.seconds}
stall_bytes = ${options.stallBytes ?? keptStall.bytes}
stall_poll = ${options.stallPollSeconds ?? keptStall.pollSeconds}
deadline_seconds = ${options.deadlineSeconds ?? 0}
net_dev = ${JSON.stringify(options.netDevPath ?? '/proc/net/dev')}
def disk_bytes():
    apparent = allocated = 0
    for base, _, names in os.walk(root):
        for name in names:
            try:
                st = os.lstat(os.path.join(base, name))
            except OSError:
                continue
            apparent += st.st_size
            allocated += getattr(st, 'st_blocks', 0) * 512
    return apparent, allocated
def received():
    try:
        with open(net_dev) as dev:
            rows = [line.split(':', 1) for line in dev.read().splitlines() if ':' in line]
        return sum(int(counts.split()[0]) for name, counts in rows if name.strip() != 'lo')
    except (OSError, ValueError, IndexError):
        return None
def partial():
    apparent, allocated = disk_bytes()
    print('MERCURY_PARTIAL ' + json.dumps({'bytes': allocated or apparent}), flush=True)
done = threading.Event()
gate = threading.Lock()
started = time.monotonic()
download_process = None
def stopped(reason, seconds):
    with gate:
        if done.is_set():
            return
        try:
            apparent, allocated = disk_bytes()
            progress('download stopped · ' + reason)
            print('MERCURY_STALL ' + json.dumps({'reason': reason, 'bytes': allocated or apparent, 'seconds': int(seconds)}), flush=True)
            if download_process is not None:
                download_process.terminate()
        finally:
            os._exit(75)
def watch_download():
    window = [(time.monotonic(),) + disk_bytes() + (received(),)]
    advanced = window[0][0]
    while not done.wait(stall_poll):
        now = time.monotonic()
        if deadline_seconds and now - started >= deadline_seconds:
            stopped('deadline', now - started)
        apparent, allocated = disk_bytes()
        rx = received()
        previous = window[-1]
        if apparent > previous[1] or allocated > previous[2] or rx is not None and previous[3] is not None and rx > previous[3]:
            advanced = now
        window.append((now, apparent, allocated, rx))
        while len(window) > 1 and now - window[1][0] >= stall_seconds:
            window.pop(0)
        first = window[0]
        idle = int(now - advanced)
        stalled = ' · stalled ' + (str(idle // 60) + ' min' if idle >= 60 else str(idle) + ' s') if now > advanced else ''
        progress('downloading weights · ' + format((allocated or apparent) / 1e9, '.2f') + ' GB of ' + format(${expectedBytes} / 1e9, '.2f') + ' GB' + stalled)
        if now - first[0] >= stall_seconds and apparent - first[1] < stall_bytes and allocated - first[2] < stall_bytes and (rx is None or first[3] is None or rx - first[3] < stall_bytes):
            stopped('stall', now - first[0])
`
}

export function hostDownloadScript(command: string, directory: string, recipe: HostRecipe): string {
  return `import json, os, pathlib, shlex, subprocess, sys, threading, time
root = pathlib.Path(${JSON.stringify(directory)})
root.mkdir(parents=True, exist_ok=True)
download_command = ${JSON.stringify(command)}
def progress(text):
    print('MERCURY_STEP ' + text, flush=True)
${downloadWatchScript(recipe.weightsGb * 1e9, { deadlineSeconds: keptDownloadMinutes(recipe) * 60 })}
download_process = subprocess.Popen(shlex.split(download_command))
threading.Thread(target=watch_download, daemon=True).start()
code = download_process.wait()
with gate:
    done.set()
if code:
    partial()
sys.exit(code)
`
}

function stopReport(text: string, marker: string): { reason?: string; bytes?: number; seconds?: number } | undefined {
  const line = text.split('\n').findLast(row => row.includes(marker))
  if (!line) return
  try { return JSON.parse(line.slice(line.indexOf(marker) + marker.length)) as { reason?: string; bytes?: number; seconds?: number } } catch { return }
}
export function downloadFailure(error: unknown, recipe: HostRecipe): { words: string; bytes?: number } {
  const text = String(error)
  const stall = stopReport(text, 'MERCURY_STALL ')
  const report = stall ?? stopReport(text, 'MERCURY_PARTIAL ')
  const bytes = typeof report?.bytes === 'number' && report.bytes >= 0 ? report.bytes : undefined
  const at = bytes === undefined ? '' : ' at ' + gigabytes(bytes) + ' of ' + gigabytes(recipe.weightsGb * 1e9)
  if (stall?.reason === 'deadline') return { words: 'Download did not finish in ' + keptDownloadMinutes(recipe) + ' min' + at, bytes }
  if (stall) return { words: 'Download stalled' + at + ' (' + keptStallWords + ')', bytes }
  if (text.includes('ssh timed out')) return { words: 'Download did not finish in ' + keptRunMs(recipe) / 60_000 + ' min', bytes }
  const last = text.split('\n').map(row => row.trim()).filter(row => row && !row.includes('MERCURY_')).at(-1) ?? text
  return { words: (text.includes('Kept weights failed pinned SHA256/sizes verification') ? 'Downloaded weights failed verification' : 'Download failed') + at + ': ' + last.slice(0, 240), bytes }
}
