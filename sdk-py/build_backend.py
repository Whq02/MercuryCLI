from __future__ import annotations
import base64
import csv
import hashlib
import io
from pathlib import Path
import sys
import tarfile
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parent
PROJECT = tomllib.loads((ROOT / 'pyproject.toml').read_text())['project']
STEM = PROJECT['name'].replace('-', '_') + '-' + PROJECT['version']
INFO = STEM + '.dist-info'


def metadata() -> bytes:
    fields = [('Metadata-Version', '2.4'), ('Name', PROJECT['name']), ('Version', PROJECT['version']), ('Summary', PROJECT['description']), ('Requires-Python', PROJECT['requires-python']), ('License-Expression', PROJECT['license']), ('License-File', 'LICENSE'), ('Keywords', ','.join(PROJECT['keywords'])), ('Description-Content-Type', 'text/markdown')]
    fields.extend(('Classifier', c) for c in PROJECT['classifiers'])
    fields.extend(('Project-URL', f'{k}, {v}') for k, v in PROJECT['urls'].items())
    return ('\n'.join(f'{k}: {v}' for k, v in fields) + '\n\n' + (ROOT / 'README.md').read_text()).encode()


def get_requires_for_build_wheel(config_settings=None): return []
def get_requires_for_build_sdist(config_settings=None): return []


def prepare_metadata_for_build_wheel(metadata_directory, config_settings=None):
    target = Path(metadata_directory) / INFO
    target.mkdir(parents=True, exist_ok=True)
    (target / 'METADATA').write_bytes(metadata())
    return INFO


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    dest = Path(wheel_directory)
    dest.mkdir(parents=True, exist_ok=True)
    filename = STEM + '-py3-none-any.whl'
    files = {str(p.relative_to(ROOT / 'src')): p.read_bytes() for p in sorted((ROOT / 'src').rglob('*')) if p.is_file() and (p.suffix == '.py' or p.name == 'py.typed')}
    files[INFO + '/METADATA'] = metadata()
    files[INFO + '/WHEEL'] = b'Wheel-Version: 1.0\nGenerator: mercury-cli-sdk\nRoot-Is-Purelib: true\nTag: py3-none-any\n'
    files[INFO + '/licenses/LICENSE'] = (ROOT / 'LICENSE').read_bytes()
    record = io.StringIO(newline='')
    writer = csv.writer(record)
    for name, data in files.items():
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('=')
        writer.writerow([name, 'sha256=' + digest, len(data)])
    writer.writerow([INFO + '/RECORD', '', ''])
    files[INFO + '/RECORD'] = record.getvalue().encode()
    with zipfile.ZipFile(dest / filename, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items(): archive.writestr(zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0)), data)
    return filename


def build_sdist(sdist_directory, config_settings=None):
    dest = Path(sdist_directory)
    dest.mkdir(parents=True, exist_ok=True)
    filename = STEM + '.tar.gz'
    files = [ROOT / n for n in ('pyproject.toml', 'build_backend.py', 'README.md', 'LICENSE')]
    files += [p for p in sorted((ROOT / 'src').rglob('*')) if p.is_file() and (p.suffix == '.py' or p.name == 'py.typed')]
    with tarfile.open(dest / filename, 'w:gz') as archive:
        for p in files:
            data = p.read_bytes()
            info = tarfile.TarInfo(STEM + '/' + str(p.relative_to(ROOT)))
            info.size = len(data)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))
        data = metadata()
        info = tarfile.TarInfo(STEM + '/PKG-INFO')
        info.size = len(data)
        archive.addfile(info, io.BytesIO(data))
    return filename


if __name__ == '__main__':
    dest = sys.argv[1] if len(sys.argv) > 1 else str(ROOT / 'dist')
    print(build_wheel(dest))
    print(build_sdist(dest))
