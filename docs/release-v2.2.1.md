# v2.2.1 发布说明

本版修复 v2.2.0 引入的一处兼容性回归：**在不返回强 ETag 的 WebDAV 服务上，同步完全无法使用**。
用户实测环境为坚果云（手机 Gecko 宿主），「合并」直接报
`合并失败: 云端缺少强 ETag，无法安全地合并写入`。四个安装包及隔离 Edge 目录已从稳定的
v2.2.1 源码构建并通过独立核验；真实设备及生产服务的验收限制见下文。

## 根因

v2.2.0 为修复 v2.1.0 审查的 F06（云端并发写入保护）引入了一个**失败关闭**的门槛：
上传、合并、下载三条路径都要求云端文件的 `ETag` 是强 ETag（形如 `"..."`，无 `W/` 前缀），
否则立即抛错。门槛本身合理，但落点过宽：

- **下载路径根本不需要它。** 下载全程不写云端，只做「备份 → 导入本机」，要求版本标识
  没有任何防护意义，只是一次纯只读操作被一并卡死。
- **只有弱 ETag / 只有 `Last-Modified` 的服务器被一刀切拒绝。** 弱 ETag 确实不能用于
  `If-Match`（RFC 7232 要求强比较，硬用只会拿到必然的 412），但同一响应里的
  `Last-Modified` 本来就能支持 `If-Unmodified-Since` —— 保护级别低一档，却是真实存在的
  服务端原子比较。原来的实现把「没有最强保护」等同于「完全不能写」。
- **维护流程反而没有保护。** 「清除同步缓存」的两条写回路径（`clearSyncCache` 的
  scope=current / all）调用 `putFile` 时不带任何写条件，是对全局共享 XBEL 的无条件覆盖：
  别的设备刚同步上去的内容会被整份抹掉。这是同一类缺陷，v2.2.0 漏掉了。

## 本版改动

写入共用文件时按服务器**实际提供的能力**分层选择并发校验，从强到弱：

| 档位 | 服务器能力 | 发出的条件请求头 | 保护强度 |
| --- | --- | --- | --- |
| 1 | 强 ETag 可用 | `If-Match: "<etag>"` | 原子、精确（首选） |
| 2 | 只有弱 ETag，或只有 `Last-Modified` | `If-Unmodified-Since: <HTTP-date>` | 服务端原子比较，秒级粒度 |
| 3 | 两者都没有 | 不带条件 | 无并发保护，**结果里明确说明** |

- 新文件仍用 `If-None-Match: *`，只允许创建，避免覆盖同名既有文件。
- 弱 ETag **不会**被降级引用去凑 `If-Match`：那会得到一个必然的 412，把「保护不足」
  伪装成「一直冲突」。`putFile` 收到调用方显式传入的非强 ETag 仍然直接报错。
- 只有服务器的 `Last-Modified` 会被用作 `If-Unmodified-Since`。响应里的 `Date` 头不参与，
  本地当前时间也不参与 —— 拿「响应时间」当文件修改时间会得到一个永远 412 的条件。
  这条规则同样适用于新暴露的 `serverModified` 字段，它与会回退到 `Date`/本地时间的
  `lastModified` 是两个独立的量。
- 降档时弹窗的同步结果会带上说明（「已改用云端修改时间做并发校验，精度为秒」/
  「本次写入没有并发保护」），不静默降档、不假装安全。
- 下载路径的版本标识要求已移除（它本来就不写云端）。
- 「清除同步缓存」的两条写回路径改为「同一次 GET 取正文+版本 → 条件写入」，
  并把本次写入的保护级别一并回报给界面。

顺带修掉三个同一条链路上、被本次改动放到台面上的问题：

1. **上传冲突检测不再拿 `Date` 当修改时间。** 该检测原本比较
   `remoteVersion.lastModified`，而它在服务器不给 `Last-Modified` 时会回退成响应 `Date`
   （≈当前时间）—— 拿「现在」和上次记录比，结果是在这类服务器上**每次非强制上传都报
   「云端书签已被其他设备修改」**。现在只用服务器真的发来的 `Last-Modified`；
   服务器不提供时该项检测跳过，而不是永远误报。
2. **条件写入在 PUT 阶段被拒时补上 `code`。** popup 靠 `code === 'CLOUD_CONFLICT'` 才给出
   「强制覆盖」这条路；不透传的话，用户只看到「上传失败」，既不知道是并发冲突，
   也没有任何可走的下一步。
3. **维护流程的失败原因分类。** 云端文件刚被别的设备写过 → 条件写入被拒，这是安全拒绝，
   不是网络故障。此前一律显示「请检查网络后重试」，把用户指向错误的方向；
   现在分别显示「云端文件刚被其他设备修改，已拒绝覆盖；请先同步一次再重试」。

## 构建核验与分发

源码清单、npm 包及 lockfile 根版本统一为 `2.2.1`，依赖树与 v2.1.0 基线逐项一致
（125 个依赖项无变化），未升级 `vitest`。Chromium 旁加载包为 `2.2.1`，Gecko MV2 事件页为
`2.2.1`，Gecko MV2 常驻后台变体为 `2.2.1.1`；常驻后台变体的额外版本段用于区分宿主形态。

Chromium 旁加载包的扩展 ID 仍为 `obcnfpnjniaonkhdadhokbhmhfhcbjif`，签名公钥 SPKI
SHA-256 仍为 `e12d5fd9d80eda73037ea17c7572198536b280c7a631123d990e5e58e18fffeb`，
与 v2.1.0 / v2.2.0 完全相同 —— 也就是说这是一次**升级**，不是新扩展，WebDAV 配置与书签
数据不会因为换包而丢失。签名已用包内公开头部材料验签，未读取或输出私钥。

在仓库根目录使用（`--output` 只接受工作区内尚不存在的新目录，不要运行暂存脚本的无参默认模式）：

```text
python tools/build_packages.py
python tools/stage_edge_unpacked.py --output dist/edge-unpacked-2.2.1
python tools/verify_release.py --artifact edge-unpacked=dist/edge-unpacked-2.2.1
```

此次四个安装包及隔离 Edge 目录均已通过内容、版本、权限、目录白名单和源码稳定性检查；
四个变体的 40 个条目集合一致，其中全部 39 个运行时文件在四个变体之间**逐字节相同**，
且与构建源码一致（仅 CRLF/LF 归一化）；无符号链接、无隐藏/私密条目。Edge 隔离目录 42 个文件。
这不等于浏览器安装信任验证，两个 Gecko XPI 未经 Mozilla 签名。校验和随 `SHA256SUMS.txt` 提供。

## 自动化验证与验收限制

本轮完整自动化结果为 **525/525 用例通过，失败及 pending 均为 0**，共 114 个 suite 分组
（不是 114 个测试文件，测试文件为 31 个）。静态检查 **9/9** 通过，覆盖 22 个 JavaScript 文件、
6 个 Python 文件及 125 个未变更的依赖项；Python 标记工具回归 **5/5** 通过。
这些数字仅记录对应检查结果，不构成真实设备或生产服务兼容性证明。

本版新增 16 个回归用例，其中 **15 个先在 v2.2.0 的源码上运行并确认失败**（缺强 ETag 时
上传/合并/下载报错、弱 ETag 未回退、维护流程无条件覆盖共享 XBEL、`Date` 被当成修改时间），
再在修复后通过。剩下 1 个（`a strong-ETag server still uses If-Match and never degrades`）
是**非回归护栏**：它在 v2.2.0 上本来就通过，作用是保证本次修改没有把首选档位改坏，
因此不属于「修复前失败」的用例。

除回归用例外，还做了 **7 项变异检查（7/7 全部被抓出）**：把实现分别改成
「用 `Date` 当修改时间」「已存在的文件不带任何条件就写」「冲突检测改用 `Date` 派生时间」
「降档不上报」「把弱 ETag 去掉 `W/` 当强 ETag 用」「下载重新要求强 ETag」
「维护流程退回无条件覆盖」，每一种都被上述用例判失败。这用来证明这些用例真的在守东西，
而不是「无论实现对错都通过」。

测试装置（`test/helpers/audit-harness.cjs`）本次也做了两处加固，否则上面若干条根本无法被检验：

- 合成服务器**默认按 RFC 7232 检查 PUT 预条件**。此前它无条件接受任何 PUT，测试只能断言
  客户端「发了什么头」，发一个永远匹配不上的条件也照样全绿。
- 响应 `Date` 改为独立的服务器时钟（每次请求前进），与文件 `mtime` 不再混同 ——
  两者混同时「拿 `Date` 当修改时间比对」这个错误在测试里永远撞不出来。
  合成服务器现在还支持分别关闭 `Last-Modified` 与 `Date`，以造出「只给 Date」的服务器。

同步行为自动化测试使用合成数据及模拟浏览器/WebDAV 环境，模拟服务器覆盖了强 ETag、
弱 ETag、无 ETag、只给 `Date`、连 `Date` 都不给这几种能力档位。
以下项目仍是本版未经实机或生产服务验证的验收限制：

- **坚果云实际返回哪些响应头、是否真正执行 `If-Unmodified-Since`，未在本机验证。**
  本机没有可用的真实云端凭据，这一条只能由你在真实环境确认。若弹窗的同步结果里出现
  「已改用云端修改时间做并发校验，精度为秒」，说明走的是第 2 档。
- **客户端无法区分「服务器执行了 `If-Unmodified-Since`」与「服务器忽略了它」。** 忽略时不会
  返回错误，写入照常成功，保护静默消失。第 2 档的保护强度取决于服务端实现。
- **第 2 档有 1 秒的盲窗口。** HTTP 日期只有秒精度：两台设备在同一秒内读取并写入时，
  后写的一方仍会覆盖先写的一方且不报冲突。第 1 档（强 ETag）没有这个问题。
- 若服务器把文件修改时间存得比秒更细，理论上可能对我们回显的整秒值判 412（误报冲突）。
  这是「宁可信其有」的方向，不会静默覆盖，但会需要重试。
- 另一台设备在「本机读取之后、写回之前」**删除**了云端文件时，第 2 档会把它重新创建出来
  （RFC 7232 规定资源不存在时忽略 `If-Unmodified-Since`）。第 1 档会正确报冲突。
- 真实桌面浏览器中的扩展安装、加载、权限授予及升级后的配置保留。
- Berry/Via/Aira 等移动端实机的跨设备同步、删除传播和失败重试。
- Firefox/Gecko 宿主中两种 MV2 变体的安装与后台行为，以及 Firefox 签名和安装信任要求。
- 手机桥接（Berry/Via/Aira）各自的 JSON 文件仍是无条件写入，不受主 XBEL 的条件写入保护。
  这些文件路径按设备区分，冲突概率远低于共享的主 XBEL，但确实没有并发保护。

## 开发依赖安全说明

`Vitest 1.6.1` 仅用于开发与测试，存在已知安全公告；本版未升级或声称修复该开发依赖问题。
扩展安装包不包含 npm 运行时依赖，Vitest 及其依赖树不随扩展分发。当前镜像来源的传递依赖
安全公告覆盖不完整，不能将已有检查解释为完整依赖树无漏洞。

## 审查发现与回归用例

下表列出本版直接对应的仓库内回归用例，已纳入上述完整测试。自动化通过不能代替真实浏览器、
WebDAV 及移动端检查。除标注者外均在 `test/audit-transaction.test.js`。

| 问题 | 对应用例 |
| --- | --- |
| 弱 ETag 被当成强条件用 | `versionWriteCondition never hands a weak ETag to If-Match`；`conditional PUT rejects weak ETag without network writes` |
| 无强 ETag 的服务器上上传/合并报错 | `upload/merge writes when the server exposes no strong ETag` |
| 弱 ETag 时应改用 `If-Unmodified-Since` | `upload/merge falls back to If-Unmodified-Since on a weak ETag` |
| 降档后删除传播必须照旧生效 | `upload/merge propagates a cloud tombstone at the fallback tier` |
| 完全没有版本头时不许假装安全 | `upload/merge still writes but reports when the server has no version header` |
| `Date` 不许冒充文件修改时间 | `a server that exposes only Date never gets If-Unmodified-Since` |
| 没有 `Last-Modified` 时不许误报云端冲突 | `a server without Last-Modified does not fake a cloud conflict` |
| 下载被无关的版本要求卡死 | `download needs no version identifier because it never writes to the cloud` |
| 降档后仍必须挡住并发覆盖 | `fallback condition still stops a concurrent overwrite` |
| 共享 XBEL 被无条件覆盖（维护流程） | `clearing cloud tombstones writes the shared XBEL conditionally` |
| 维护流程把安全拒绝报成网络故障 | `a rejected maintenance write is reported as a conflict, not a network fault` |
| 强 ETag 服务器不得退化 | `a strong-ETag server still uses If-Match and never degrades` |
| 正文与版本必须来自同一次 GET | `versioned GET binds body and ETag to the same response` |
