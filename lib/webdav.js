// webdav.js — WebDAV 操作层
// 封装所有 WebDAV HTTP 操作，提供统一的文件读写接口

MiniSync.webdav = (function() {

// ========== 内部工具：统一复用 utils 模块，避免重复实现 ==========
// 注意：getAuthHeader / joinWebDAVUrl / normalizeBookmarkPath / getWebDAVConfig
// 均在 lib/utils.js 中定义并挂载到 MiniSync.utils，本文件不再重复实现。

const { getAuthHeader, joinWebDAVUrl, normalizeBookmarkPath } = MiniSync.utils;

function isStrongETag(etag) {
  return typeof etag === 'string' && /^"[^"\r\n]*"$/.test(etag);
}

/**
 * 把「同一次 GET 拿到的版本」翻译成写条件。返回对象直接喂给 putFile：
 *   { etag }        —— 强 ETag，If-Match，原子且精确（首选）
 *   { since }       —— 只有 Last-Modified，If-Unmodified-Since，仍是服务端原子比较，秒级粒度
 *   { missing: true } —— 云端还没有这个文件，If-None-Match: *，只允许创建
 *   {}              —— 服务器什么都没给，本次写入没有并发保护（如实上报，不静默假装安全）
 *
 * 为什么要有 since 这一层：v2.2.0 原本要求必须有强 ETag，否则一律拒绝写入。
 * 坚果云等真实服务（以及部分移动端宿主）拿不到强 ETag 时，这条规则让同步彻底不可用。
 * 弱 ETag 不能拿来做 If-Match（RFC 7232 要求强比较，硬用必然 412），
 * 所以这里不降级引用它，而是改用同一响应里的 Last-Modified —— 保护级别低一档，但真实存在。
 */
function versionWriteCondition(version) {
  if (!version || !version.exists) return { missing: true };
  if (isStrongETag(version.etag)) return { etag: version.etag };
  if (version.serverModified > 0) return { since: version.serverModified };
  return {};
}

/** 本次写入实际拿到的保护级别，用于如实回报给用户与日志。 */
function describeWriteProtection(writeCondition) {
  if (!writeCondition) return 'none';
  if (writeCondition.missing) return 'create-only';
  if (isStrongETag(writeCondition.etag)) return 'etag';
  if (writeCondition.since > 0) return 'last-modified';
  return 'none';
}

/**
 * 保护级别降档时给用户看的一句话；满档（etag / create-only）返回空串。
 * 静默降档等于骗人：用户以为写入有并发保护，实际没有。
 */
function writeProtectionNote(protection) {
  if (protection === 'last-modified') return '（本服务未提供强 ETag，本次写入改用云端修改时间做并发校验，精度为秒）';
  if (protection === 'none') return '（注意：本服务未提供可用的并发校验，本次写入没有并发保护）';
  return '';
}


// ========== 核心 API：putFile / getFile（orchestrator 调用）==========

/** 上传文件到 WebDAV（用于 XBEL 上传；Aira 等 JSON 内容请传 contentType） */
async function putFile(baseUrl, username, password, filename, content, contentType, writeCondition) {
  const precondition = preconditionHeaders(writeCondition);
  const url = joinWebDAVUrl(baseUrl, filename);
  const ct = contentType || 'application/xml; charset=utf-8';

  // ★ PUT 前确保父目录存在：坚果云等 WebDAV 服务对「目录不存在」的 PUT 直接返回 404
  //   ObjectNotFound（合并失败: 上传失败 (404)）。目录可能藏在两处：
  //   ① filename 带子路径（/dir/file.xbel）；② baseUrl 本身带子目录
  //   （https://dav.jianguoyun.com/dav/dir）。这里解析完整 PUT URL 相对 baseUrl
  //   的路径段，除最后一段（文件名）外全部逐级 MKCOL；目录已存在时 MKCOL 返回
  //   405 被忽略，仅多几次轻量请求。Berry/Via/Aira 写回各自的 ensure 与此并存无害。
  try {
    const base = new URL(baseUrl);
    const full = new URL(url);
    const baseSegs = base.pathname.split('/').filter(Boolean);
    const fullSegs = full.pathname.split('/').filter(Boolean);
    const dirSegs = (full.origin === base.origin && fullSegs.length > baseSegs.length)
      ? fullSegs.slice(baseSegs.length, -1)   // 去掉 base 前缀与最后一段文件名
      : [];
    if (dirSegs.length) {
      try { await ensureWebDAVDir(baseUrl, dirSegs.join('/'), username, password); } catch (_) { /* 由 PUT 暴露真实错误 */ }
    }
  } catch (_) { /* URL 解析失败则跳过 ensure，由 PUT 暴露真实错误 */ }

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': getAuthHeader(username, password),
      'Content-Type': ct,
      'Cache-Control': 'no-cache',
      ...precondition
    },
    body: content
  });

  if (!response.ok && response.status !== 201 && response.status !== 204) {
    if (response.status === 412 || response.status === 409) {
      const error = new Error('云端文件已更改，请重新下载并合并后重试');
      error.code = 'CLOUD_CONFLICT';
      throw error;
    }
    const text = await response.text().catch(() => '');
    // ★ 诊断：打印完整请求 URL（含隐藏的空格/编码杂质）——404 ObjectNotFound 时
    //   一眼看出实际 PUT 的路径是否和预期一致（地址尾部空格/全角字符等杂质会改写路径）。
    //   脱敏：配置里若把凭据写进地址（https://user:pass@host/...），原样打印会把密码
    //   留在控制台里，而这段日志恰恰是被设计成「让用户复制出来看」的。
    console.error(`[webdav] PUT ${filename} 失败: ${response.status} 完整URL=<${MiniSync.utils.redactUrlForLog(url)}>`, text.slice(0, 200));
    throw new Error(`上传失败 (${response.status}): ${text.slice(0, 100)}`);
  }

  // 解析云端 lastModified：优先 Last-Modified 头，回退 Date 头，再回退当前时间
  const lmRaw = response.headers.get('Last-Modified') || response.headers.get('Date');
  let lastModified = Date.now();
  if (lmRaw) {
    const parsed = Date.parse(lmRaw);
    if (!isNaN(parsed)) lastModified = parsed;
  }
  // serverModified 只认服务器真的发来的 Last-Modified（0 = 没给）。
  // ★ 调用方做「云端是否被别人改过」的比对时必须用它，不能用 lastModified：
  //   后者在没有 Last-Modified 时会退化成响应里的 Date（≈当前时间），
  //   拿「现在」去和历史记录比，结果是每次同步都报「云端已被其他设备修改」。
  const lmOnly = response.headers.get('Last-Modified');
  const serverModified = lmOnly ? (Date.parse(lmOnly) || 0) : 0;

  return { lastModified, serverModified, protection: describeWriteProtection(writeCondition) };
}

/**
 * 写条件 → HTTP 预条件头。
 * 注意 `{ etag }` 里的 ETag 仍然必须是强 ETag：调用方明确指名用 ETag 做条件时，
 * 拿弱 ETag 来凑会得到一个必然 412 的请求，所以这里直接报错而不是悄悄降级。
 * 需要「弱 ETag 也能写」的调用方应改用 versionWriteCondition() 取得合适的条件。
 */
function preconditionHeaders(writeCondition) {
  if (!writeCondition) return {};
  if (writeCondition.missing) return { 'If-None-Match': '*' };
  if (writeCondition.etag) {
    if (!isStrongETag(writeCondition.etag)) throw new Error('云端缺少强 ETag，无法安全地条件写入');
    return { 'If-Match': writeCondition.etag };
  }
  if (writeCondition.since > 0) return { 'If-Unmodified-Since': new Date(writeCondition.since).toUTCString() };
  return {};
}

/** 读取远程文件信息（HEAD 优先，回退 GET） */
async function getFileInfo(baseUrl, username, password, filename) {
  const url = joinWebDAVUrl(baseUrl, filename);

  // 优先 HEAD
  try {
    const headRes = await fetch(url, {
      method: 'HEAD',
      cache: 'no-store',
      headers: {
        'Authorization': getAuthHeader(username, password),
        'Cache-Control': 'no-cache'
      }
    });
    if (headRes.status === 404) return { exists: false, lastModified: 0 };
    if (headRes.ok) {
      return { exists: true, lastModified: parseLastModified(headRes) };
    }
    // HEAD 被拒绝（如 405），继续回退 GET
  } catch (_) { /* 网络错误，继续回退 GET */ }

  // 回退 GET（只取响应头，不读 body 内容）
  const getRes = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    headers: {
      'Authorization': getAuthHeader(username, password),
      'Cache-Control': 'no-cache'
    }
  });
  if (getRes.status === 404) return { exists: false, lastModified: 0 };
  if (!getRes.ok) {
    throw new Error('读取文件信息失败 (' + getRes.status + ')');
  }
  return { exists: true, lastModified: parseLastModified(getRes) };
}

/**
 * 从响应头解析 lastModified 时间戳
 */
function parseLastModified(response) {
  const lmRaw = response.headers.get('Last-Modified') || response.headers.get('Date');
  if (!lmRaw) return Date.now();
  const parsed = Date.parse(lmRaw);
  return isNaN(parsed) ? Date.now() : parsed;
}

/** Read the body and its version from one GET response. */
async function getFileVersion(baseUrl, username, password, filename) {
  const url = joinWebDAVUrl(baseUrl, filename);
  const response = await fetch(url, {
    method: 'GET', cache: 'no-store',
    headers: { 'Authorization': getAuthHeader(username, password), 'Cache-Control': 'no-cache' }
  });
  if (response.status === 404) return { exists: false, content: null, etag: null, lastModified: 0, serverModified: 0 };
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('认证失败 (401/403)');
    throw new Error('下载失败 (' + response.status + ')');
  }
  // ★ 版本标识必须在读 body 之前一次性取齐：正文与版本必须来自同一次 GET，
  //   这是并发写入保护成立的前提（另发一个 HEAD/PROPFIND 取版本不是原子保证）。
  //   serverModified 只认服务器真的发来的 Last-Modified，绝不用 Date 头或本地时间兜底 ——
  //   拿「响应时间」当 If-Unmodified-Since 会得到一个永远 412 的条件。
  const etag = response.headers.get('ETag') || null;
  const lastModifiedHeader = response.headers.get('Last-Modified');
  const serverModified = lastModifiedHeader ? (Date.parse(lastModifiedHeader) || 0) : 0;
  return {
    exists: true,
    content: await response.text(),
    etag,
    lastModified: parseLastModified(response),
    serverModified
  };
}

/** 从 WebDAV 下载文件（404 返回 null） */
async function getFile(baseUrl, username, password, filename) {
  const url = joinWebDAVUrl(baseUrl, filename);

  const response = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    headers: {
      'Authorization': getAuthHeader(username, password),
      'Cache-Control': 'no-cache'
    }
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error(`[webdav] GET ${filename} 失败: ${response.status}`, text.slice(0, 200));
    if (response.status === 401 || response.status === 403) {
      throw new Error('认证失败 (401/403)：请检查 WebDAV 用户名/密码是否正确，或密码是否含特殊字符');
    }
    throw new Error('下载失败 (' + response.status + '): ' + text.slice(0, 100));
  }

  const text = await response.text();
  return text;
}


// ========== 连接测试 ==========

/** 测试 WebDAV 连接是否可用（PROPFIND → HEAD → GET 三级回退） */
async function testConnection(config) {
  // 15 秒超时保护
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const baseUrl = (config.url || '').replace(/\/+$/, '');
    const propfindUrl = baseUrl + '/';

    // 方法1: PROPFIND 根目录
    const response = await fetch(propfindUrl, {
      method: 'PROPFIND',
      signal: controller.signal,
      headers: {
        'Authorization': getAuthHeader(config.username, config.password),
        'Depth': '0',
        'Content-Type': 'application/xml; charset=utf-8'
      }
    });

    if (response.ok) {
      return { success: true, message: '连接成功' };
    }

    // 方法2: HEAD 备用测试
    // ★ 404 不放行：HEAD 404 = 地址指向的路径不存在（同步 PUT 也会 404），
    //   旧逻辑放行 404 导致「测试连接成功但同步失败」的假阳性误导。
    const headResponse = await fetch(propfindUrl, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'Authorization': getAuthHeader(config.username, config.password),
        'Cache-Control': 'no-cache'
      }
    });

    if (headResponse.ok || headResponse.status === 405) {
      clearTimeout(timeoutId);
      return { success: true, message: '连接成功' };
    }

    // 方法3: GET 尝试
    const getResponse = await fetch(propfindUrl, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'Authorization': getAuthHeader(config.username, config.password),
        'Cache-Control': 'no-cache'
      }
    });

    if (getResponse.ok || getResponse.status === 301 || getResponse.status === 302) {
      clearTimeout(timeoutId);
      return { success: true, message: '连接成功' };
    }

    const errText = await getResponse.text().catch(() => '');
    clearTimeout(timeoutId);
    if (getResponse.status === 404) {
      // ★ 与 PUT 同口径：地址指向的路径在服务器上不存在
      return { success: false, message: 'WebDAV 地址指向的路径不存在 (404)，请检查地址（目录会在同步时自动创建）' };
    }
    return { success: false, message: `认证失败 (${getResponse.status}): ${errText.slice(0, 100)}` };

  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.warn('[webdav] testConnection 超时 (15s)');
      return { success: false, message: '连接超时（15秒无响应），请检查地址是否正确' };
    }
    console.error('[webdav] testConnection 异常:', error.message);
    return { success: false, message: error.message };
  }
}


// ========== 目录操作 ==========

/** 确保远程目录存在（递归 MKCOL，逐层创建，支持 aira/g3/bookmarks 这类多级路径） */
async function ensureWebDAVDir(baseUrl, dirPath, username, password) {
  const segments = (dirPath || '').split('/').filter(Boolean);
  let acc = '';
  for (const seg of segments) {
    acc = acc ? acc + '/' + seg : seg;
    const fullUrl = joinWebDAVUrl(baseUrl, acc);
    try {
      const response = await fetch(fullUrl, {
        method: 'MKCOL',
        headers: { 'Authorization': getAuthHeader(username, password) }
      });
      // 201 新建成功；405 目录已存在；其余忽略（如 409 父目录问题会由后续层级暴露）
      if (response.status !== 201 && response.status !== 405) {
        console.warn(`[webdav] MKCOL ${acc}: ${response.status}`);
      }
    } catch (e) {
      console.warn(`[webdav] MKCOL 失败 (${acc}):`, e.message);
    }
  }
}

/** 列出远程目录内容 */
async function listWebDAVDir(baseUrl, dirPath, username, password) {
  const fullUrl = joinWebDAVUrl(baseUrl, dirPath || '');
  const response = await fetch(fullUrl, {
    method: 'PROPFIND',
    headers: {
      'Authorization': getAuthHeader(username, password),
      'Depth': '1',
      'Content-Type': 'application/xml; charset=utf-8'
    }
  });

  if (!response.ok) {
    throw new Error(`列出目录失败 (${response.status})`);
  }

  const text = await response.text();
  const items = [];
  // 不假定命名空间前缀：兼容 <d:href> / <D:href> / <href> / <ns0:href> 等写法
  const hrefRegex = /<(?:[\w-]+:)?href>([^<]+)<\/(?:[\w-]+:)?href>/gi;
  // 注意：不带 /g 标志。带 /g 的正则每次 test() 会推进 lastIndex，导致目录判定交替出错
  const collectionRegex = /<(?:[\w-]+:)?collection\b[^>]*\/?>(?:<\/(?:[\w-]+:)?collection>)?/i;
  let match;
  let idx = 0;

  while ((match = hrefRegex.exec(text)) !== null) {
    const href = decodeURIComponent(match[1]);
    const name = href.split('/').filter(Boolean).pop() || '';
    if (name && idx++ > 0) { // 跳过自身
      const startIdx = match.index;
      // 片段截到当前 <response> 块结束：向前固定截 500 字符会把下一条目的
      // <collection> 也包进来，导致文件被误判为目录
      const rest = text.slice(startIdx);
      const endMatch = rest.match(/<\/(?:[\w-]+:)?response>/i);
      const snippet = endMatch ? rest.slice(0, endMatch.index) : rest.slice(0, 500);
      items.push({
        name: name,
        isDirectory: collectionRegex.test(snippet)
      });
    }
  }

  return items;
}


// ========== 配置读取（兼容新旧格式）==========

// 直接复用 utils 模块中的实现（避免重复逻辑，新旧格式兼容逻辑集中在 utils）
async function getWebDAVConfig() {
  return MiniSync.utils.getWebDAVConfig();
}


// ========== 文件存在性检查 ==========

/** 检查远程文件是否存在 */
async function checkFileExists(filePath) {
  const config = await getWebDAVConfig();
  if (!config.url) return false;
  const url = joinWebDAVUrl(config.url, filePath);
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      headers: {
        'Authorization': getAuthHeader(config.username, config.password),
        'Cache-Control': 'no-cache'
      }
    });
    return response.ok;
  } catch (_) {
    return false;
  }
}


// ========== 导出公共 API ======
return {
  // ★ 核心：orchestrator 调用的接口
  putFile,
  isStrongETag,
  versionWriteCondition,
  describeWriteProtection,
  writeProtectionNote,
  getFile,
  getFileVersion,
  getFileInfo,
  // 连接测试
  testConnection,
  // 目录操作
  ensureWebDAVDir,
  listWebDAVDir,
  // 配置
  getWebDAVConfig,
  normalizeBookmarkPath,
  joinWebDAVUrl,
  getAuthHeader,
  checkFileExists
};

})();
