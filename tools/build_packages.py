"""一次产出三种宿主形态的安装包，并回读产物核验。

  · Chromium 旁加载版（Chrome / Edge）：host_permissions 写在清单里 ⇒ 安装时即授予，
    不再依赖运行时权限弹窗。出 .crx（用 pem 签名，ID 稳定）+ .zip（「加载已解压的扩展程序」用）。
  · Gecko MV2 事件页版（Firefox / 可拓 / 雨见等）：background.scripts + 安装时 host 权限。
    Gecko 校验清单时会直接拒绝 MV3 的 background.service_worker，那种宿主上 MV3 包的后台从不运行。
  · Gecko MV2 常驻后台页变体：同上但 background.persistent = true，宿主不唤醒事件页时用，
    版本号取 <源码版本>.1，便于在诊断报告里区分两个变体。

用法：
    python tools/build_packages.py
    python tools/build_packages.py --key <签名私钥.pem> --chrome <chrome.exe>

签名私钥不入库（默认取环境变量 MINIBM_PEM，其次 build/minibm-signing.pem）。
产物写在 dist/，暂存在 build/。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

import packaging as P

DEFAULT_CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'


def parse_args():
    ap = argparse.ArgumentParser(description='构建三种宿主形态的安装包')
    ap.add_argument('--key', default=os.environ.get('MINIBM_PEM') or os.path.join(P.BUILD, 'minibm-signing.pem'),
                    help='crx 签名私钥（pem）。不入库；不存在则跳过 crx、只出 zip 与 xpi')
    ap.add_argument('--chrome', default=os.environ.get('CHROME') or DEFAULT_CHROME,
                    help='用于 --pack-extension 的 chrome/edge 可执行文件')
    return ap.parse_args()


def main():
    args = parse_args()
    ver = P.source_version()
    persistent_ver = ver + '.1'
    mods = P.modules_from_background()
    src = P.src_manifest()
    os.makedirs(P.DIST, exist_ok=True)

    print('源码版本 = %s ；常驻页变体版本 = %s ；模块数 = %d' % (ver, persistent_ver, len(mods)))

    stage_mv3 = os.path.join(P.BUILD, 'stage-mv3')
    stage_mv2 = os.path.join(P.BUILD, 'stage-mv2')
    stage_mv2p = os.path.join(P.BUILD, 'stage-mv2p')

    # ---------- MV3：Chromium 旁加载（安装时授予 host 权限；去掉商店 key 与 update_url）----------
    mv3 = dict(src)
    mv3.pop('key', None)
    mv3.pop('update_url', None)
    mv3.pop('optional_host_permissions', None)
    mv3['host_permissions'] = ['*://*/*']
    P.stage_sources(stage_mv3)
    P.write_manifest(stage_mv3, mv3)

    # ---------- MV2：Gecko 事件页 ----------
    mv2 = {
        'manifest_version': 2,
        'name': src['name'],
        'description': src['description'],
        'version': ver,
        'icons': src['icons'],
        'permissions': ['bookmarks', 'storage', 'alarms', '*://*/*'],
        'background': {'scripts': mods + ['background.js'], 'persistent': False},
        'browser_action': src['action'],
        'options_page': 'options.html',
        'content_security_policy': "script-src 'self'; object-src 'none';",
        'web_accessible_resources': ['images/nb.svg', 'icons/icon.png'],
        'browser_specific_settings': {
            'gecko': {'id': 'minibookmark-sync@local', 'strict_min_version': '57.0'},
        },
    }
    P.stage_sources(stage_mv2)
    P.write_manifest(stage_mv2, mv2)

    # ---------- MV2 变体：常驻后台页 ----------
    mv2p = dict(mv2)
    mv2p['version'] = persistent_ver
    mv2p['background'] = {'scripts': mods + ['background.js'], 'persistent': True}
    P.stage_sources(stage_mv2p)
    P.write_manifest(stage_mv2p, mv2p)

    # ---------- 打包 ----------
    crx_path = os.path.join(P.DIST, 'minibookmark-sync-%s-chromium-sideload.crx' % ver)
    zip_path = os.path.join(P.DIST, 'minibookmark-sync-%s-chromium-sideload.zip' % ver)
    xpi_path = os.path.join(P.DIST, 'minibookmark-sync-%s-gecko-mv2.xpi' % ver)
    xpip_path = os.path.join(P.DIST, 'minibookmark-sync-%s-gecko-mv2-persistent.xpi' % persistent_ver)

    targets = [('mv3-zip', zip_path), ('mv2-xpi', xpi_path), ('mv2p-xpi', xpip_path)]

    if os.path.isfile(args.key) and os.path.isfile(args.chrome):
        packed = os.path.join(P.BUILD, 'stage-mv3.crx')
        if os.path.exists(packed):
            os.remove(packed)
        cp = subprocess.run([args.chrome, '--pack-extension=' + stage_mv3, '--pack-extension-key=' + args.key,
                             '--no-message-box', '--user-data-dir=' + os.path.join(P.BUILD, 'chrome-pack-profile')],
                            capture_output=True, text=True)
        if os.path.exists(packed):
            shutil.copyfile(packed, crx_path)
            targets.insert(0, ('crx', crx_path))
        else:
            print('打包 crx 失败（跳过）：rc=%s\n%s\n%s' % (cp.returncode, cp.stdout, cp.stderr))
    else:
        print('未找到签名私钥或 chrome，跳过 crx（zip 与 xpi 照常产出）')

    counts = {}
    counts['mv3-zip'] = P.zip_dir(stage_mv3, zip_path)
    counts['mv2-xpi'] = P.zip_dir(stage_mv2, xpi_path)
    counts['mv2p-xpi'] = P.zip_dir(stage_mv2p, xpip_path)

    # ---------- 回读核验 ----------
    problems = []
    report = []
    for label, path in targets:
        z, size = P.read_zip_from(path)
        names = set(z.namelist())
        m = json.loads(z.read('manifest.json').decode('utf-8'))
        report.append('--- %s (%s, %d bytes, %d 项) ---' % (label, os.path.basename(path), size, len(names)))
        report.append('  manifest_version=%s version=%s background=%s' % (
            m['manifest_version'], m['version'],
            json.dumps(m['background'], ensure_ascii=False)))
        report.append('  permissions=%s host_permissions=%s' % (m.get('permissions'), m.get('host_permissions')))

        # ① 清单形态
        if label.startswith('mv2'):
            if m['manifest_version'] != 2:
                problems.append('%s: manifest_version 应为 2' % label)
            if 'service_worker' in m.get('background', {}):
                problems.append('%s: 仍带 background.service_worker（Gecko 会拒绝整包）' % label)
            if '*://*/*' not in m.get('permissions', []):
                problems.append('%s: host 权限不在 permissions（MV2 里 optional 不顶用）' % label)
            missing = [f for f in m['background']['scripts'] if f not in names]
            if missing:
                problems.append('%s: background.scripts 缺文件 %s' % (label, missing))
            if m['background']['scripts'][-1] != 'background.js':
                problems.append('%s: background.scripts 末位不是 background.js' % label)
            want_persistent = (label == 'mv2p-xpi')
            if bool(m['background'].get('persistent')) != want_persistent:
                problems.append('%s: background.persistent 应为 %s' % (label, want_persistent))
            if label == 'mv2p-xpi' and m['version'] != persistent_ver:
                problems.append('mv2p-xpi: 版本号应为 %s' % persistent_ver)
        else:
            if m['manifest_version'] != 3:
                problems.append('%s: manifest_version 应为 3' % label)
            if '*://*/*' not in m.get('host_permissions', []):
                problems.append('%s: host_permissions 缺失（旁加载必须安装时授予）' % label)
            if m.get('key') or m.get('update_url'):
                problems.append('%s: 不该带 key/update_url（旁加载版）' % label)

        # ② 修复标记（清单在 tools/markers.py，出包与暂存共用同一份）
        for p in P.check_markers(lambda rel: z.read(rel).decode('utf-8', 'ignore')):
            problems.append('%s: %s' % (label, p))

    print('\n'.join(report))
    print('\n校验：%s' % ('全部通过' if not problems else '发现 %d 个问题' % len(problems)))
    for p in problems:
        print('  ✗ ' + p)
    print('\n产物（dist/）：')
    for label, path in targets:
        print('  %-8s %s  %d bytes  sha256=%s' % (
            label, os.path.basename(path), os.path.getsize(path), P.sha256(path)[:16]))
    if os.path.isfile(args.key) and os.path.isfile(args.chrome):
        print('  旁加载 crx 的扩展 ID = %s' % (P.extension_id_from_pem(args.key) or '（无法推导）'))
    if problems:
        sys.exit(2)


if __name__ == '__main__':
    main()
