from __future__ import annotations
import os
from pathlib import Path
import re
import shutil
from .errors import MercuryError


def executable_of(executable: str | list[str] | None, env: dict[str, str] | None = None, cwd: str | None = None) -> list[str]:
    environment = os.environ if env is None else env
    parts = [environment.get('MERCURY_BIN') or 'mercury'] if executable is None else [executable] if isinstance(executable, str) else list(executable)
    if not parts or not parts[0]: raise MercuryError('the mercury executable is empty')
    command, *args = parts
    if command == 'mercury':
        home = Path(environment.get('HOME') or environment.get('USERPROFILE') or Path.home())
        candidates = [home / '.mercury/bin/mercury', home / '.local/bin/mercury']
        command = shutil.which(command, path=environment.get('PATH', '')) or next((str(path) for path in candidates if path.is_file() and os.access(path, os.X_OK)), command)
    elif command.lower().endswith(('.cmd', '.bat')) and '/' not in command and '\\' not in command:
        command = shutil.which(command, path=environment.get('PATH', '')) or command
    if command.lower().endswith(('.cmd', '.bat')):
        path = Path(cwd or '.', command).resolve()
        match = re.search(r'"(?:%dp0%|%~dp0)[\\/]([^"\r\n]+\.(?:mjs|cjs|js))"', path.read_text(encoding='utf-8'), re.IGNORECASE)
        script = path.parent / match[1].replace('\\', '/') if match else None
        if script is None or not script.is_file(): raise MercuryError('the executable is a command shim without a readable Node entry point; pass [node, script]')
        node = path.parent / 'node.exe'
        return [str(node) if node.is_file() else shutil.which('node', path=environment.get('PATH', '')) or 'node', str(script), *args]
    return [command, *args]
