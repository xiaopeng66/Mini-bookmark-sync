"""出包 / 暂存共用件：路径、清单、打包、标记核验。

两个入口脚本（`build_packages.py`、`stage_edge_unpacked.py`）都从这里取共同逻辑，
避免同一份清单和标记表在几处各写一遍（历史上就漂移过）。
"""
import hashlib
import io
import json
import os
import re
import shutil
import zipfile

from markers import MARKERS

# 仓库根 = 本文件所在目录的上一级
SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(SRC, 'dist')
BUILD = os.path.join(SRC, 'build')          # 暂存目录（不入库）

# 打进扩展包的内容（manifest.json 由脚本各自写入）。
# 只列扩展运行时真正需要的文件 —— README 用的截图放在 docs/、商店推广图之类一律不进包。
SHIP_DIRS = ['adapters', 'core', 'lib', 'model', 'icons']
SHIP_FILES = ['background.js', 'options.html', 'options.js', 'popup.html', 'popup.js',
              'images/nb.svg', 'images/nb-filled.svg']

# 固定条目时间戳：否则同一份源码两次打包 sha256 不同（zip 头带 mtime），
# 「产物 sha256 可核对」这条就废了。
FIXED_TIME = (2026, 1, 1, 0, 0, 0)


def src_manifest():
    return json.load(io.open(os.path.join(SRC, 'manifest.json'), encoding='utf-8'))


def source_version():
    return src_manifest()['version']


def modules_from_background():
    """从 background.js 的 importScripts 清单取模块顺序（与生产同源，避免清单漂移）"""
    src = io.open(os.path.join(SRC, 'background.js'), encoding='utf-8').read()
    m = re.search(r'importScripts\(([\s\S]*?)\);', src)
    if not m:
        raise SystemExit('background.js 中找不到 importScripts 清单')
    return re.findall(r"'([^']+)'", m.group(1))


def stage_sources(stage, refresh=True):
    """把要发布的源码复制到暂存目录；refresh=True 时先清空（保证不留上一版残留）"""
    if refresh and os.path.isdir(stage):
        shutil.rmtree(stage)
    if not os.path.isdir(stage):
        os.makedirs(stage)
    for d in SHIP_DIRS:
        dst = os.path.join(stage, d)
        if os.path.isdir(dst):
            shutil.rmtree(dst)
        shutil.copytree(os.path.join(SRC, d), dst)
    for f in SHIP_FILES:
        dst = os.path.join(stage, f)
        d = os.path.dirname(dst)
        if not os.path.isdir(d):
            os.makedirs(d)
        shutil.copyfile(os.path.join(SRC, f), dst)


def write_manifest(stage, manifest):
    with io.open(os.path.join(stage, 'manifest.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=3, sort_keys=True)
        f.write('\n')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def zip_dir(stage, out_path, level=9):
    n = 0
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=level) as z:
        for root, dirs, files in os.walk(stage):
            dirs[:] = sorted(d for d in dirs if d not in ('node_modules', '.git'))
            for f in sorted(files):
                full = os.path.join(root, f)
                rel = os.path.relpath(full, stage).replace(os.sep, '/')
                zi = zipfile.ZipInfo(rel, date_time=FIXED_TIME)
                zi.compress_type = zipfile.ZIP_DEFLATED
                zi.external_attr = 0o644 << 16
                with open(full, 'rb') as fh:
                    z.writestr(zi, fh.read())
                n += 1
    return n


def read_zip_from(path):
    """crx / xpi / zip 都能读：crx 前面有 Cr24 头，找到 PK 头再当 zip 读"""
    raw = open(path, 'rb').read()
    i = raw.find(b'PK\x03\x04')
    return zipfile.ZipFile(io.BytesIO(raw[i:])), len(raw)


def extension_id_from_key(key_b64):
    """Chrome 扩展 ID = sha256(DER 公钥) 前 16 字节，每个 nibble 映射到 a-p"""
    import base64
    der = base64.b64decode(key_b64)
    h = hashlib.sha256(der).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(c, 16)) for c in h)


def extension_id_from_pem(pem_path):
    """从签名私钥推出旁加载扩展 ID（没有 openssl 时返回 None，不阻断出包）"""
    import subprocess
    try:
        der = subprocess.run(['openssl', 'rsa', '-in', pem_path, '-pubout', '-outform', 'DER'],
                             capture_output=True).stdout
    except Exception:
        return None
    if not der:
        return None
    import base64
    h = hashlib.sha256(der).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(c, 16)) for c in h)


def check_markers(read_text):
    """按 MARKERS 逐条核对；read_text(rel) 返回该文件的文本，读不到就记「缺文件」。

    返回问题清单（空 = 全部命中）。前缀 '!' 的标记必须【不在】文件里。
    """
    problems = []
    for rel, marks in MARKERS.items():
        try:
            body = read_text(rel)
        except Exception:
            problems.append('缺文件 %s' % rel)
            continue
        for mk in marks:
            if mk.startswith('!'):
                if mk[1:] in body:
                    problems.append('%s 里不该再出现 %r' % (rel, mk[1:]))
            elif mk not in body:
                problems.append('%s 里找不到修复标记 %r' % (rel, mk))
    return problems
