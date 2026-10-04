"""把「桌面 Edge / Chrome 加载解压缩的扩展」用的目录造好。

目录固定为 dist/edge-unpacked（不带版本号）—— 这是「更新不用重填配置」的关键：
Edge 记的是加载时选的那个路径，路径不变 ⇒ 更新只要把文件写进同一目录，再到
edge://extensions 点一下该扩展的「重新加载」，WebDAV 配置原地保留。

保留 manifest 的 key（扩展 ID 与商店版相同 ⇒ chrome.storage 里的配置继续可用），
去掉 update_url（避免浏览器去商店把布局回滚成旧版）。

用法：python tools/stage_edge_unpacked.py
"""
import io
import json
import os
import shutil

import packaging as P

README_NAME = 'README-安装说明.txt'

README_LINES = [
    '极简书签同步 —— 桌面 Edge / Chrome「加载解压缩的扩展」说明（当前版本 v%s）',
    '',
    '一、第一次装（只做一次）',
    '  1. 打开 edge://extensions（Chrome 是 chrome://extensions）',
    '  2. 打开「开发人员模式」',
    '  3. 点「加载解压缩的扩展」，选中【本目录】—— 选目录本身，不是里面的某个文件',
    '  4. 若提示「已存在相同 ID 的扩展」：先把扩展列表里指向旧目录的那条「移除」，再加载本目录。',
    '     这一步只需做一次；移除会清掉该扩展此前的设置，所以这次可能要重填一遍 WebDAV 配置。',
    '     设置页有「导出配置 / 导入配置」，导出成一个文件，在别的浏览器导入即可，不必逐项手填。',
    '',
    '二、以后更新（关键：不要再换目录）',
    '  1. 新版本的文件会被直接写进【本目录】，路径不会变',
    '  2. 在 edge://extensions 里点本扩展的「重新加载」按钮（⟳）',
    '  3. 配置原地保留 —— 加载路径没变，扩展 ID 也没变',
    '',
    '三、为什么不给 .crx',
    '  Edge / Chrome 拒收「非商店来源」的 .crx。本地开发版一律用「解压缩目录」。',
    '',
    '本目录对应的扩展版本见 VERSION.txt。',
]


def clean_dir(path):
    """只清内容、不换目录本身：目录 inode 不变，Edge 的文件监视器不会盯着一个被替换掉的目录"""
    if not os.path.isdir(path):
        os.makedirs(path)
        return
    for name in os.listdir(path):
        p = os.path.join(path, name)
        if os.path.isdir(p):
            shutil.rmtree(p)
        else:
            os.remove(p)


def main():
    ver = P.source_version()
    out = os.path.join(P.DIST, 'edge-unpacked')
    clean_dir(out)
    P.stage_sources(out, refresh=False)
    with io.open(os.path.join(out, 'VERSION.txt'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(ver + '\n')
    text = '\n'.join([(ln % ver) if '%s' in ln else ln for ln in README_LINES]) + '\n'
    with io.open(os.path.join(out, README_NAME), 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)

    m = P.src_manifest()
    m.pop('update_url', None)
    P.write_manifest(out, m)

    print('输出目录 :', out)
    print('版本     :', m.get('version'), '| manifest_version', m.get('manifest_version'))
    print('update_url:', m.get('update_url', '(已去掉)'))
    print('key 保留 :', 'key' in m)
    if 'key' in m:
        print('推导扩展 ID:', P.extension_id_from_key(m['key']))
    print('background:', m.get('background'))

    n = 0
    for root, dirs, files in os.walk(out):
        dirs[:] = sorted(d for d in dirs if d not in ('node_modules', '.git'))
        n += len(files)
    print('文件数   :', n)

    def read_text(rel):
        return io.open(os.path.join(out, rel.replace('/', os.sep)), encoding='utf-8').read()

    bad = P.check_markers(read_text)
    print('回读结论 :', '全部命中' if not bad else ('缺 ' + str(bad)))


if __name__ == '__main__':
    main()
