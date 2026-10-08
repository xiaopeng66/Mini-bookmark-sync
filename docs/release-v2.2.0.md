# v2.2.0 发布说明

本版修复 v2.1.0 审查所列 F01–F20，重点处理同步失败造成的云端/本地数据损失、跨目标状态污染、手机桥接删除与失败反馈。四个安装包及隔离 Edge 目录已从稳定的 v2.2.0 源码构建并通过独立核验；真实设备及生产服务的验收限制见下文。

## 数据安全与兼容性

- 合并中的本地必要写入失败不再把不完整的本地树写回云端。下载重建必须先成功保存并校验备份；同步失败的替换式恢复仅修改所选同步文件夹，以及本次操作实际修改的 Berry 主页（若有），范围外书签不得被清空或搬进同步范围。仍建议升级前独立导出书签，并保留 WebDAV 历史版本。
- 主 XBEL 文件从同一次 GET 读取正文和 ETag，写入使用条件请求。现有文件的安全覆盖需要服务器返回可用于条件写入的**强 ETag**，并正确执行 `If-Match`；新文件使用 `If-None-Match: *`。客户端现已通过强 ETag 校验对没有 ETag 或仅有弱 ETag（`W/`）的现有文件**失败关闭**，不能依赖 GET 后再 HEAD 的时间戳绕过并发检查。目标 WebDAV 的真实条件写入和并发语义仍未验证，应作为本版验收限制，不能把本地模拟测试当作服务端证明。收到远端版本冲突时应重新下载、合并或明确提示重试。不支持这些条件请求的服务可能不能完成写入，这是防止静默覆盖的兼容性取舍。手机桥接各自的文件不应误认为受主 XBEL 条件写入保护。
- 非法/非 XBEL 的云端正文不再当作空文件覆盖；合法的零书签及删除记录文档仍可同步。WebDAV 目标、账户、云端文件及本地同步文件夹构成同步关系；切换目标不再继承旧关系的删除记录与快照，导入部分配置时更换服务器不能沿用原凭据。目标切换前应核对新旧目录和账号。
- 删除记录不会仅因三天 TTL 且当前本机/云端均不存在节点就回收，避免久未上线的设备复活旧书签。当前没有全设备确认水位，未重新添加的有效删除记录可能长期留在同步文件中；不要把本机与云端两份视图理解为“所有设备已确认”。

## 跨端与结果反馈

- 修复标准书签移动事件、手机桥接的删除传播、Aira 主页删除和异常父链处理，保留不同文件夹中相同 URL 的合法副本，独立新建的目录不再凭名称差异猜测为改名。
- 诊断输出对敏感地址和范围外书签数据脱敏；清同步缓存不应复制书签；设置页的云端路径应与实际访问路径一致；短暂离线探测不应永久关闭 Aira 开关。
- 主文件成功但 Berry/Via/Aira 的写回失败属于**部分完成**，不应显示为全成功；留意各桥接的失败或待重试状态，再检查各设备同步结果。书签写入冲突也不可被成功状态掩盖。

## 构建核验与分发

源码清单、npm 包及 lockfile 根版本统一为 `2.2.0`，不升级 `vitest` 或依赖树。Chromium 旁加载包为 `2.2.0`，Gecko MV2 事件页为 `2.2.0`，Gecko MV2 常驻后台变体为 `2.2.0.1`；常驻后台变体的额外版本段用于区分宿主形态。

构建四个安装包是独立步骤；Edge 发布候选目录务必显式另选新路径，不能运行暂存脚本的无参数默认模式（默认模式会清理并重写 `dist/edge-unpacked`，该目录可能正被 Edge 加载）。在仓库根目录使用：

```text
python tools/stage_edge_unpacked.py --output dist/edge-unpacked-2.2.0
python tools/verify_release.py --artifact edge-unpacked=dist/edge-unpacked-2.2.0
```

`--output` 仅接受工作区内尚不存在、且路径不含符号链接或 `..` 的新目录；重试前不要盲目删除已有目录，先检查其用途。核验脚本独立对照源码检查四个安装包与所指定的 Edge 解压目录的内容、清单与权限，拒绝多余/私密条目，并输出每个产物的完整 SHA-256（解压目录为确定性的内容树 SHA-256）。安装包内 Chromium/Gecko 旁加载权限为所有 HTTP(S) 主机，与源码的可选主机权限不同；只从可信渠道安装，核对安装时权限。核验不代替浏览器加载、签名信任、真实 WebDAV 并发及移动端实机测试。上述命令用于后续核验，不要对已存在的候选目录重新执行暂存。此次四个安装包及隔离 Edge 目录均已通过内容、版本、权限、目录白名单和源码稳定性检查；全部 39 个运行时文件与构建源码逐字节一致。CRX 的 RSA/SHA-256 签名已用公开头部材料验证，签名公钥及旁加载 ID 与 v2.1.0 一致。这不等于浏览器安装信任验证，两个 Gecko XPI 未经 Mozilla 签名。校验和随 `SHA256SUMS.txt` 提供。

## 自动化验证与验收限制

集成负责人确认的本轮完整自动化结果为 **512/512 用例通过，失败及 pending 均为 0**，共 114 个 suite 分组（不是 114 个测试文件）。静态检查 **9/9** 通过，覆盖 22 个 JavaScript 文件、6 个 Python 文件及 125 个未变更的依赖项；Python 标记工具回归 **5/5** 通过。离线 GitHub 发布辅助工具测试 **18/18**、额外独立检查 **6/6** 通过。这些数字仅记录对应检查结果，不构成真实设备或生产服务兼容性证明。

同步行为自动化测试使用合成数据及模拟浏览器/WebDAV 环境；静态检查和源码/产物对照只能验证各自检查的内容，不能证明真实宿主或生产服务兼容。以下项目仍是本版未经实机或生产服务验证的验收限制：

- 真实桌面浏览器中的扩展安装、加载、权限授予及升级后的配置保留。
- Berry/Via/Aira 等移动端实机的跨设备同步、删除传播和失败重试。
- Firefox/Gecko 宿主中两种 MV2 变体的安装与后台行为，以及 Firefox 签名和安装信任要求。
- 生产 WebDAV 服务的强 ETag、条件写入、并发冲突及新文件防覆盖行为。

以上真实环境目前均未验证，应作为兼容性与验收限制保留，不得将合成测试、静态检查或本说明作为实机/生产服务验证通过的证据。发布决定应明确接受或另行验证这些限制。

## 开发依赖安全说明

`Vitest 1.6.1` 仅用于开发与测试，存在已知安全公告；本版未升级或声称修复该开发依赖问题。扩展安装包不包含 npm 运行时依赖，Vitest 及其依赖树不随扩展分发。当前镜像来源的传递依赖安全公告覆盖不完整，不能将已有检查解释为完整依赖树无漏洞；后续仍需用完整公告来源复核并单独处理开发工具升级。

## 审查发现与回归用例

下表列出直接对应的仓库内回归用例，已纳入上述完整测试。自动化通过不能代替真实浏览器、WebDAV 及移动端检查。

| 发现 | 对应用例（`test/` 下） |
| --- | --- |
| F01 不完整本地写入覆盖云端 | `audit-transaction.test.js`: partial merge import / upload deletion failure / merge rename failure |
| F02 回滚越过同步范围 | `audit-transaction.test.js`: replacement restore preserves outside nodes; failed clear-first download restores Berry home |
| F03 备份失败仍清空 | `audit-transaction.test.js`: backup callback failure blocks destructive download |
| F04 切服复用凭据 | `audit-settings.test.js`: partial import to different origin; changing account without password |
| F05 跨目标删除基线污染 | `audit-transaction.test.js`: relationship change isolates tombstones and old baselines |
| F06 云端版本竞争 | `audit-transaction.test.js`: versioned GET; conditional PUT conflict; upload PUT conflict |
| F07 非法文档覆盖 | `audit-model.test.js`: rejects non-XBEL, truncated XML and malformed content |
| F08 手机桥接删除断链 | `audit-transaction.test.js`: bridge deletion recorded before PUT; `audit-bridge-repairs.test.js`: Aira home tombstone / Berry ordering |
| F09 移动事件误读 | `audit-background.test.js`: standard moveInfo and host without onRemoved |
| F10 离线设备删除记录失效 | `audit-model.test.js`: TTL and two online copies do not prove acknowledgment |
| F11 启动恢复错键及结果 | `audit-background.test.js`: startup restores saved backup; restoration conflicts reported as failure |
| F12 合法零书签加墓碑 | `audit-model.test.js`: empty tombstone-only XBEL; `audit-transaction.test.js`: empty cloud tombstone download |
| F13 诊断泄漏敏感信息 | `audit-settings.test.js`: sanitizer and report cases; `audit-background.test.js`: message-boundary sanitization |
| F14 清缓存重复复制 | `audit-model.test.js`: each source root serialized once; virtual HOME/MOBILE roots |
| F15 Aira 环形父链 | `audit-bridge-repairs.test.js`: cyclic parent input fails promptly |
| F16 同 URL 多位置副本 | `audit-model-import.test.js`: same URL under different parents; `audit-model.test.js`: duplicate URLs in distinct paths |
| F17 独立文件夹误改名 | `audit-model.test.js`: independently created folders remain separate without history |
| F18 设置路径与实际不同 | `audit-settings.test.js`: custom basename probe and resolved nested folder overview |
| F19 离线探测关闭 Aira | `audit-settings.test.js`: Aira offline probe preserves enabled preference |
| F20 桥接失败显示全成功 | `audit-transaction.test.js`: bridge write failure persists partial; `audit-background.test.js`: popup partial warning |
