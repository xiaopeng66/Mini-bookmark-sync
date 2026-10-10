"""Independently verify v2.2.2 release artifacts without building or reading signing keys.

Run from anywhere: python tools/verify_release.py
To inspect older artifacts: python tools/verify_release.py --artifact chromium-zip=dist/old.zip
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
EXPECTED_VERSION = '2.2.2'
PERSISTENT_VERSION = '2.2.2.1'
DIRECTORIES = ('adapters', 'core', 'lib', 'model', 'icons')
FILES = ('background.js', 'options.html', 'options.js', 'popup.html', 'popup.js',
         'images/nb.svg', 'images/nb-filled.svg')
TEXT_SUFFIXES = {'.js', '.html', '.svg', '.css', '.json', '.txt'}
ARTIFACTS = {
    'chromium-crx': f'minibookmark-sync-{EXPECTED_VERSION}-chromium-sideload.crx',
    'chromium-zip': f'minibookmark-sync-{EXPECTED_VERSION}-chromium-sideload.zip',
    'gecko-mv2': f'minibookmark-sync-{EXPECTED_VERSION}-gecko-mv2.xpi',
    'gecko-persistent': f'minibookmark-sync-{PERSISTENT_VERSION}-gecko-mv2-persistent.xpi',
    'edge-unpacked': 'edge-unpacked',
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def normalized(name, data):
    return data.replace(b'\r\n', b'\n') if Path(name).suffix.lower() in TEXT_SUFFIXES else data


def forbidden(name):
    parts = name.replace('\\', '/').split('/')
    lower = [part.lower() for part in parts]
    return (not name or name.startswith(('/', '\\')) or re.match(r'^[A-Za-z]:', name)
            or any(part in ('', '.', '..') for part in parts)
            or any(part in ('.git', 'node_modules', 'test', 'tests', 'private', '__pycache__') for part in lower)
            or any(part.startswith(('.env', 'private', 'test_')) or part.endswith(('.pem', '.key', '.p12', '.pfx', '.test.js', '.spec.js'))
                   for part in lower))


def source_files():
    files = {name: (ROOT / name).read_bytes() for name in FILES}
    for directory in DIRECTORIES:
        for path in (ROOT / directory).rglob('*'):
            if path.is_symlink():
                raise ValueError(f'source symlink: {path}')
            if path.is_file():
                name = path.relative_to(ROOT).as_posix()
                if forbidden(name):
                    raise ValueError(f'forbidden source entry: {name}')
                files[name] = path.read_bytes()
    return files


def background_scripts():
    body = (ROOT / 'background.js').read_text(encoding='utf-8')
    match = re.search(r'importScripts\(([\s\S]*?)\);', body)
    if not match:
        raise ValueError('background.js importScripts list missing')
    scripts = re.findall(r"'([^']+)'", match.group(1))
    if not scripts or len(scripts) != len(set(scripts)):
        raise ValueError('background.js importScripts list invalid')
    return scripts + ['background.js']


def manifests(source, scripts):
    if (source.get('manifest_version') != 3
            or source.get('permissions') != ['bookmarks', 'storage', 'alarms']
            or source.get('optional_host_permissions') != ['*://*/*']
            or 'host_permissions' in source
            or source.get('background') != {'service_worker': 'background.js'}):
        raise ValueError('source manifest permissions/background differ from release contract')
    chromium = dict(source)
    for name in ('key', 'update_url', 'optional_host_permissions'):
        chromium.pop(name, None)
    chromium['host_permissions'] = ['*://*/*']
    mv2 = {
        'manifest_version': 2, 'name': source['name'], 'description': source['description'],
        'version': EXPECTED_VERSION, 'icons': source['icons'],
        'permissions': ['bookmarks', 'storage', 'alarms', '*://*/*'],
        'background': {'scripts': scripts, 'persistent': False},
        'browser_action': source['action'], 'options_page': 'options.html',
        'content_security_policy': "script-src 'self'; object-src 'none';",
        'web_accessible_resources': ['images/nb.svg', 'icons/icon.png'],
        'browser_specific_settings': {'gecko': {'id': 'minibookmark-sync@local', 'strict_min_version': '57.0'}},
    }
    persistent = dict(mv2)
    persistent['version'] = PERSISTENT_VERSION
    persistent['background'] = {'scripts': scripts, 'persistent': True}
    edge = dict(source)
    edge.pop('update_url', None)
    return {'chromium-crx': chromium, 'chromium-zip': chromium,
            'gecko-mv2': mv2, 'gecko-persistent': persistent, 'edge-unpacked': edge}


def archive_files(path, label):
    raw = path.read_bytes()
    if label == 'chromium-crx':
        if len(raw) < 12 or raw[:4] != b'Cr24' or int.from_bytes(raw[4:8], 'little') != 3:
            raise ValueError('invalid CRX3 header')
        start = 12 + int.from_bytes(raw[8:12], 'little')
        if raw[start:start + 4] != b'PK\x03\x04':
            raise ValueError('invalid CRX3 ZIP payload')
    elif raw[:4] != b'PK\x03\x04':
        raise ValueError('invalid ZIP/XPI header')
    with zipfile.ZipFile(path) as archive:
        bad = archive.testzip()
        if bad:
            raise ValueError(f'archive CRC failure: {bad}')
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(names) != len(set(names)):
            raise ValueError('duplicate archive entries')
        for entry in entries:
            if forbidden(entry.filename.rstrip('/') if entry.is_dir() else entry.filename):
                raise ValueError(f'forbidden archive entry: {entry.filename}')
            if entry.is_dir() and not entry.filename.endswith('/'):
                raise ValueError(f'invalid archive directory: {entry.filename}')
            if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError(f'archive symlink: {entry.filename}')
        return {entry.filename: archive.read(entry) for entry in entries if not entry.is_dir()}, [
            entry.filename for entry in entries if entry.is_dir()]


def directory_files(path):
    result = {}
    for entry in path.rglob('*'):
        name = entry.relative_to(path).as_posix()
        if entry.is_symlink() or forbidden(name):
            raise ValueError(f'forbidden unpacked entry: {name}')
        if entry.is_file():
            result[name] = entry.read_bytes()
    return result


def tree_digest(files):
    digest = hashlib.sha256()
    for name, body in sorted(files.items()):
        name_bytes = name.encode('utf-8')
        digest.update(len(name_bytes).to_bytes(8, 'big'))
        digest.update(name_bytes)
        digest.update(len(body).to_bytes(8, 'big'))
        digest.update(body)
    return digest.hexdigest()


def verify(label, path, runtime, expected_manifest):
    issues = []
    if not path.exists():
        return [f'missing artifact: {path}'], None
    try:
        if label == 'edge-unpacked':
            files, directories = directory_files(path), []
        else:
            files, directories = archive_files(path, label)
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        return [str(error)], None
    expected_names = set(runtime) | {'manifest.json'}
    expected_directories = {part + '/' for name in expected_names for part in (
        '/'.join(name.split('/')[:index]) for index in range(1, len(name.split('/'))))}
    unexpected_directories = set(directories) - expected_directories
    if unexpected_directories:
        issues.append('unexpected directories: ' + ', '.join(sorted(unexpected_directories)))
    if label == 'edge-unpacked':
        expected_names |= {'VERSION.txt', 'README-安装说明.txt'}
    missing, extra = expected_names - files.keys(), files.keys() - expected_names
    if missing:
        issues.append('missing entries: ' + ', '.join(sorted(missing)))
    if extra:
        issues.append('unexpected entries: ' + ', '.join(sorted(extra)))
    for name in sorted(files.keys() & runtime.keys()):
        if normalized(name, files[name]) != normalized(name, runtime[name]):
            issues.append(f'source content mismatch: {name}')
    try:
        actual_manifest = json.loads(files['manifest.json'].decode('utf-8'))
        if actual_manifest.get('version') != expected_manifest['version']:
            issues.append(f"stale version: {actual_manifest.get('version')!r}, expected {expected_manifest['version']!r}")
        if actual_manifest != expected_manifest:
            issues.append('manifest variant/permissions/background mismatch')
    except (KeyError, ValueError, UnicodeError) as error:
        issues.append(f'invalid manifest: {error}')
    if label == 'edge-unpacked':
        if files.get('VERSION.txt', b'').replace(b'\r\n', b'\n') != (EXPECTED_VERSION + '\n').encode():
            issues.append('VERSION.txt mismatch')
        if f'v{EXPECTED_VERSION}'.encode() not in files.get('README-安装说明.txt', b''):
            issues.append('unpacked install instructions version mismatch')
        digest = tree_digest(files)
    else:
        digest = sha256(path.read_bytes())
    return issues, digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dist', type=Path, default=ROOT / 'dist', help='artifact directory')
    parser.add_argument('--artifact', action='append', default=[], metavar='LABEL=PATH',
                        help='override a single artifact path (use to inspect old packages)')
    args = parser.parse_args()
    paths = {label: args.dist / name for label, name in ARTIFACTS.items()}
    for override in args.artifact:
        label, separator, path = override.partition('=')
        if not separator or label not in ARTIFACTS:
            parser.error('expected LABEL=PATH, LABEL in: ' + ', '.join(ARTIFACTS))
        paths[label] = Path(path)
    source = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    lock = json.loads((ROOT / 'package-lock.json').read_text(encoding='utf-8'))
    versions = (source.get('version'), package.get('version'), lock.get('version'),
                lock.get('packages', {}).get('', {}).get('version'))
    if versions != (EXPECTED_VERSION,) * 4:
        print(f'FAIL: source/package/lock root versions: {versions}; expected {EXPECTED_VERSION}')
        return 2
    runtime = source_files()
    scripts = background_scripts()
    for name in scripts:
        if name not in runtime:
            print(f'FAIL: background script not shipped: {name}')
            return 2
    expected = manifests(source, scripts)
    failed = False
    for label, path in paths.items():
        problems, digest = verify(label, path, runtime, expected[label])
        if digest:
            kind = 'tree-sha256' if label == 'edge-unpacked' else 'sha256'
            print(f'{label}: {kind}={digest} ({path})')
        for problem in problems:
            print(f'FAIL {label}: {problem}')
        failed |= bool(problems)
        if not problems:
            print(f'PASS {label}: source contents and manifest match {EXPECTED_VERSION}')
    return 2 if failed else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError) as error:
        print(f'FAIL: {error}', file=sys.stderr)
        sys.exit(2)
