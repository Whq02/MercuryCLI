import { settledPython } from '../eval/interpreters.js'
import { ensureCached } from '../eval/runnerCache.js'
import type { ServiceSpec } from './contracts.js'

export const PTY_HOST_COLS = 120
export const PTY_HOST_ROWS = 40

type PtyInputFrame = { t: 'write'; text: string } | { t: 'submit'; text: string } | { t: 'eof' } | { t: 'resize'; cols: number; rows: number }

export function encodePtyFrame(frame: PtyInputFrame): string {
  return `${JSON.stringify(frame)}\n`
}

export const PTY_HOST_SOURCE: string = `# Mercury service pty host (generated; do not edit in place)
import json, os, signal, subprocess, sys, threading, time

ENTER = b"\\r"


def _frames():
    for raw in iter(sys.stdin.buffer.readline, b""):
        try:
            yield json.loads(raw.decode("utf-8"))
        except Exception:
            continue


def _bytes_of(frame, eof):
    t = frame.get("t")
    if t == "write":
        return str(frame.get("text", "")).encode("utf-8")
    if t == "submit":
        return str(frame.get("text", "")).encode("utf-8") + ENTER
    if t == "eof":
        return eof
    return None


def _posix(cols, rows, argv):
    import fcntl, pty, select, struct, termios
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(argv[0], argv)
        except Exception as e:
            sys.stderr.write("cannot start %s: %s\\n" % (argv[0], e))
            sys.stderr.flush()
            os._exit(127)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    out = sys.stdout.buffer
    status = [None]
    lock = threading.Lock()

    def end(signum=None, frame=None):
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                return
            for _ in range(20):
                if status[0] is not None:
                    return
                time.sleep(0.1)

    signal.signal(signal.SIGTERM, end)
    signal.signal(signal.SIGHUP, end)
    signal.signal(signal.SIGINT, signal.SIG_IGN)

    def pump():
        while True:
            try:
                r, _, _ = select.select([fd], [], [], 0.25)
            except (OSError, ValueError):
                break
            if not r:
                if status[0] is not None:
                    break
                continue
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            with lock:
                out.write(data)
                out.flush()

    def reap():
        try:
            _, code = os.waitpid(pid, 0)
        except ChildProcessError:
            code = 0
        status[0] = os.waitstatus_to_exitcode(code) if hasattr(os, "waitstatus_to_exitcode") else (code >> 8)

    eof = termios.tcgetattr(fd)[6][termios.VEOF]

    def feed():
        for frame in _frames():
            if status[0] is not None:
                return
            if frame.get("t") == "resize":
                try:
                    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(frame.get("rows", rows)), int(frame.get("cols", cols)), 0, 0))
                except Exception:
                    pass
                continue
            data = _bytes_of(frame, eof)
            if data is None:
                continue
            try:
                os.write(fd, data)
            except OSError:
                return

    pumper = threading.Thread(target=pump, daemon=True)
    pumper.start()
    reaper = threading.Thread(target=reap, daemon=True)
    reaper.start()
    threading.Thread(target=feed, daemon=True).start()
    reaper.join()
    pumper.join(timeout=1.0)
    with lock:
        out.flush()
    return status[0] if status[0] is not None else 1


def _windows(cols, rows, argv):
    import ctypes
    from ctypes import wintypes
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class COORD(ctypes.Structure):
        _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]

    class STARTUPINFOW(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR), ("lpDesktop", wintypes.LPWSTR), ("lpTitle", wintypes.LPWSTR),
            ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD), ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD),
            ("dwXCountChars", wintypes.DWORD), ("dwYCountChars", wintypes.DWORD), ("dwFillAttribute", wintypes.DWORD),
            ("dwFlags", wintypes.DWORD), ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD),
            ("lpReserved2", ctypes.c_void_p), ("hStdInput", wintypes.HANDLE), ("hStdOutput", wintypes.HANDLE), ("hStdError", wintypes.HANDLE),
        ]

    class STARTUPINFOEXW(ctypes.Structure):
        _fields_ = [("StartupInfo", STARTUPINFOW), ("lpAttributeList", ctypes.c_void_p)]

    class PROCESS_INFORMATION(ctypes.Structure):
        _fields_ = [("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE), ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD)]

    kernel32.CreatePipe.argtypes = [ctypes.POINTER(wintypes.HANDLE), ctypes.POINTER(wintypes.HANDLE), ctypes.c_void_p, wintypes.DWORD]
    kernel32.CreatePseudoConsole.argtypes = [COORD, wintypes.HANDLE, wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
    kernel32.CreatePseudoConsole.restype = ctypes.c_long
    kernel32.ResizePseudoConsole.argtypes = [ctypes.c_void_p, COORD]
    kernel32.ClosePseudoConsole.argtypes = [ctypes.c_void_p]
    kernel32.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.c_size_t)]
    kernel32.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
    kernel32.CreateProcessW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR, ctypes.POINTER(STARTUPINFOEXW), ctypes.POINTER(PROCESS_INFORMATION)]
    kernel32.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    kernel32.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    in_read, in_write = wintypes.HANDLE(), wintypes.HANDLE()
    out_read, out_write = wintypes.HANDLE(), wintypes.HANDLE()
    if not kernel32.CreatePipe(ctypes.byref(in_read), ctypes.byref(in_write), None, 0) or not kernel32.CreatePipe(ctypes.byref(out_read), ctypes.byref(out_write), None, 0):
        raise OSError(ctypes.get_last_error(), "CreatePipe failed")
    console = ctypes.c_void_p()
    result = kernel32.CreatePseudoConsole(COORD(cols, rows), in_read, out_write, 0, ctypes.byref(console))
    if result != 0:
        raise OSError(result, "CreatePseudoConsole failed")
    kernel32.CloseHandle(in_read)
    kernel32.CloseHandle(out_write)

    size = ctypes.c_size_t(0)
    kernel32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
    attributes = ctypes.create_string_buffer(size.value)
    if not kernel32.InitializeProcThreadAttributeList(attributes, 1, 0, ctypes.byref(size)):
        raise OSError(ctypes.get_last_error(), "InitializeProcThreadAttributeList failed")
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016
    if not kernel32.UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, console, ctypes.sizeof(ctypes.c_void_p), None, None):
        raise OSError(ctypes.get_last_error(), "UpdateProcThreadAttribute failed")
    info = STARTUPINFOEXW()
    info.StartupInfo.cb = ctypes.sizeof(STARTUPINFOEXW)
    info.lpAttributeList = ctypes.cast(attributes, ctypes.c_void_p)
    process = PROCESS_INFORMATION()
    EXTENDED_STARTUPINFO_PRESENT = 0x00080000
    command_line = ctypes.create_unicode_buffer(subprocess.list2cmdline(argv))
    if not kernel32.CreateProcessW(None, command_line, None, None, False, EXTENDED_STARTUPINFO_PRESENT, None, None, ctypes.byref(info), ctypes.byref(process)):
        code = ctypes.get_last_error()
        sys.stderr.write("cannot start %s: Windows error %d\\n" % (argv[0], code))
        sys.stderr.flush()
        return 127

    out = sys.stdout.buffer
    status = [None]

    def pump():
        buffer = ctypes.create_string_buffer(65536)
        read = wintypes.DWORD(0)
        while kernel32.ReadFile(out_read, buffer, 65536, ctypes.byref(read), None) and read.value > 0:
            out.write(buffer.raw[: read.value])
            out.flush()

    def reap():
        INFINITE = 0xFFFFFFFF
        kernel32.WaitForSingleObject(process.hProcess, INFINITE)
        code = wintypes.DWORD(0)
        kernel32.GetExitCodeProcess(process.hProcess, ctypes.byref(code))
        status[0] = int(code.value)
        kernel32.ClosePseudoConsole(console)

    def end(signum=None, frame=None):
        if status[0] is None:
            kernel32.TerminateProcess(process.hProcess, 1)

    def feed():
        written = wintypes.DWORD(0)
        for frame in _frames():
            if status[0] is not None:
                return
            if frame.get("t") == "resize":
                kernel32.ResizePseudoConsole(console, COORD(int(frame.get("cols", cols)), int(frame.get("rows", rows))))
                continue
            data = _bytes_of(frame, b"\\x1a\\r")
            if data is None:
                continue
            if not kernel32.WriteFile(in_write, data, len(data), ctypes.byref(written), None):
                return

    signal.signal(signal.SIGTERM, end)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    pumper = threading.Thread(target=pump, daemon=True)
    pumper.start()
    reaper = threading.Thread(target=reap, daemon=True)
    reaper.start()
    threading.Thread(target=feed, daemon=True).start()
    reaper.join()
    pumper.join(timeout=1.0)
    out.flush()
    return status[0] if status[0] is not None else 1


def main():
    args = sys.argv[1:]
    cols, rows = ${PTY_HOST_COLS}, ${PTY_HOST_ROWS}
    while args and args[0] != "--":
        if args[0] == "--cols":
            cols = int(args[1])
        elif args[0] == "--rows":
            rows = int(args[1])
        args = args[2:]
    argv = args[1:] if args and args[0] == "--" else args
    if not argv:
        sys.stderr.write("pty host: no command\\n")
        return 2
    return _windows(cols, rows, argv) if os.name == "nt" else _posix(cols, rows, argv)


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    os._exit(int(code) if isinstance(code, int) else 1)
`

export function ensurePtyHost(): string {
  return ensureCached('ptyhost', '.py', PTY_HOST_SOURCE)
}

export function ptyHostUnavailable(name: string, whyNot: string): string {
  return `service '${name}' asks for a pseudo-terminal, which Mercury hosts through Python 3 — none was found (${whyNot}); install Python 3 or point MERCURY_EVAL_PYTHON at one, or start the service without pty`
}

export async function ptyHostLaunch(spec: ServiceSpec): Promise<{ command: string; args: string[] } | { error: string }> {
  const python = await settledPython(spec.cwd)
  if (!python.available || python.interpreterPath === undefined) return { error: ptyHostUnavailable(spec.name, python.whyNot ?? 'no Python 3 on this machine') }
  return { command: python.interpreterPath, args: [ensurePtyHost(), '--cols', String(PTY_HOST_COLS), '--rows', String(PTY_HOST_ROWS), '--', spec.command, ...spec.args] }
}
