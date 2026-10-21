from __future__ import annotations
import os
from pathlib import Path
import re
import sys
from .errors import MercuryError

MANAGED_SHIM_FAMILY = 'mercury-managed-shim'
HOMEBREW_COMMANDS = ('/opt/homebrew/bin/mercury', '/usr/local/bin/mercury', '/home/linuxbrew/.linuxbrew/bin/mercury')


def executable_of(executable: str | list[str] | None, env: dict[str, str] | None = None, cwd: str | None = None, platform: str | None = None) -> list[str]:
    environment: dict[str, str] = dict(os.environ) if env is None else env
    win = (sys.platform if platform is None else platform) == 'win32'
    def variable(name: str) -> str | None:
        if name in environment or not win: return environment.get(name)
        return next((value for key, value in environment.items() if key.upper() == name), None)
    parts = [variable('MERCURY_BIN') or 'mercury'] if executable is None else [executable] if isinstance(executable, str) else list(executable)
    if not parts or not parts[0]: raise MercuryError('the mercury executable is empty')
    command, *args = parts
    base = Path(cwd or '.')
    def absolute(path: Path) -> Path: return Path(os.path.abspath(path))
    def runnable(path: Path) -> bool: return path.is_file() and (win or os.access(path, os.X_OK))
    pathext = variable('PATHEXT')
    extensions = [ext for ext in ('.COM;.EXE;.BAT;.CMD' if pathext is None else pathext).split(';') if ext] if win else ['']
    def spellings(name: str) -> list[str]: return ([name] if re.search(r'\.[^\\/.]+$', name) else []) + [name + ext.lower() for ext in extensions] if win else [name]
    def on_path(name: str) -> Path | None:
        return next((candidate for entry in (variable('PATH') or '').split(';' if win else ':') if entry for candidate in (absolute(base / entry / spelling) for spelling in spellings(name)) if runnable(candidate)), None)
    def is_shim(path: str) -> bool: return path.lower().endswith(('.cmd', '.bat', '.ps1'))
    def is_script(path: str) -> bool: return path.lower().endswith(('.mjs', '.cjs', '.js'))
    def head(path: Path) -> str:
        try:
            with open(path, 'rb') as handle: return handle.read(8192).decode('utf-8', errors='replace')
        except OSError: return ''
    def vendored_runtime(directory: Path) -> Path: return directory / 'vendor' / 'node' / ('node.exe' if win else 'bin/node')
    def runtime_for(script: Path) -> str:
        pinned = variable('MERCURY_NODE')
        if pinned:
            if runnable(Path(pinned)): return pinned
            raise MercuryError(f'MERCURY_NODE names no executable file: {pinned}; point it at a Node binary, or unset it so {script} runs on the runtime vendored beside it or node from PATH')
        vendored = vendored_runtime(script.parent)
        if runnable(vendored): return str(vendored)
        found = on_path('node')
        return str(found) if found else 'node'
    home = Path((variable('USERPROFILE') or variable('HOME') if win else variable('HOME')) or Path.home())
    versions_dir = Path(variable('MERCURY_VERSIONS_DIR') or Path(variable('MERCURY_CONFIG_DIR') or variable('MERCURY_HOME') or home / '.mercury') / 'versions')
    def managed() -> list[str] | None:
        try: pointer = (versions_dir / 'current.txt').read_text(encoding='utf-8')
        except OSError: return None
        version = next((line.replace('"', '').rstrip() for line in pointer.splitlines() if line.strip()), None)
        if not version or re.search(r'[\\/]|\.\.', version): return None
        bundle = versions_dir / version / 'mercury.mjs'
        return [runtime_for(bundle), str(bundle)] if bundle.is_file() else None
    layout = f'{versions_dir / "current.txt"} must name a version directory under {versions_dir} that holds mercury.mjs'
    def shim(path: Path) -> list[str]:
        source = head(path)
        if MANAGED_SHIM_FAMILY in source:
            bundle = managed()
            if bundle: return bundle
            raise MercuryError(f"{path} is Mercury's managed command, but the install it points at was not found: {layout}; run `mercury install` from an extracted release, or pass [node, script]")
        match = re.search(r'"(?:%dp0%|%~dp0)[\\/]([^"\r\n]+\.(?:mjs|cjs|js))"', source, re.IGNORECASE)
        script = path.parent / match[1].replace('\\', '/') if match else path.parent / 'mercury.mjs'
        if not script.is_file(): raise MercuryError(f"the executable is a command shim without a readable Node entry point: {path} is neither Mercury's managed command ({layout}) nor an npm shim, and no mercury.mjs sits beside it; pass [node, script]")
        local_node = path.parent / 'node.exe'
        if match: return [str(local_node) if local_node.is_file() else str(on_path('node') or 'node'), str(script)]
        return [runtime_for(script), str(script)]
    def wrapped(source: str) -> list[str] | None:
        match = re.search(r'^exec "([^"\r\n]+)" "\$@"\s*$', source, re.MULTILINE)
        if not match or not os.path.isabs(match[1]): return None
        bundle = Path(match[1]).parent / 'mercury.mjs'
        return [runtime_for(bundle), str(bundle)] if bundle.is_file() and runnable(vendored_runtime(bundle.parent)) else None
    def file(path: str) -> list[str]:
        placed = absolute(base / path)
        if is_shim(path): return shim(placed)
        if is_script(path):
            if not placed.is_file(): raise MercuryError(f'the executable is a JavaScript entry point that does not exist: {placed}')
            return [runtime_for(placed), str(placed)]
        source = head(placed)
        if MANAGED_SHIM_FAMILY in source: return shim(placed)
        return wrapped(source) or [str(placed) if '/' in path or '\\' in path else path]
    if command == 'mercury':
        bundle = managed()
        if bundle: return [*bundle, *args]
        stable = Path(variable('LOCALAPPDATA') or home / 'AppData' / 'Local') / 'Mercury' / 'bin' / 'mercury.cmd' if win else home / '.local' / 'bin' / 'mercury'
        prefix = variable('HOMEBREW_PREFIX')
        brew = [] if win or not variable('PATH') else [*([Path(prefix, 'bin', 'mercury')] if prefix else []), *(Path(path) for path in HOMEBREW_COMMANDS)]
        found = on_path(command) or next((candidate for candidate in (stable, home / '.mercury' / 'bin' / 'mercury', *brew) if runnable(candidate)), None)
        return [*file(str(found)), *args] if found else [command, *args]
    named = str(on_path(command) or command) if is_shim(command) and '/' not in command and '\\' not in command else command
    return [*file(named), *args]
