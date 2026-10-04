// via-html-interop.test.js — bookmarks.html（Netscape 格式）跨写端互操作回归
//
// 背景：Via 桥的本质是「文件夹 + 文件名 + 格式」的约定式桥接 —— 桌面端不和手机通信，
// 只是把同一个文件写对格式。所以解析器必须吃得下**别的写端**写出的同格式文件，
// 而不只是自己写出的那一份。
//
// 实测对象：floccus 的 HTML 序列化器（src/lib/serializers/Html.ts，逐字节复刻成下方 fixture）。
// 之所以是它：可拓浏览器没有原生 WebDAV 书签同步，官方推荐的 WebDAV 方案就是 floccus，
// 所以「可拓 → WebDAV 文件 → 桌面端」这条链的对端就是 floccus 的格式。
// 它的三个特点与我们的旧解析器不兼容：
//   1. 文件以 <DL><p> 起头（无 <!DOCTYPE>/<H1>/<TITLE>）；
//   2. 实体一律写成数字形式（& → &#38;，< → &#60;），从不写命名实体；
//   3. <A> 上带 TAGS/ID 属性，<DT>/<DL> 之间只有一个换行。
//
// 本文件锁住的三个真实缺陷：
//   A. &#38; 中的 '#' 被 new URL() 当成 fragment 起点 → URL 查询串被整段丢弃
//      （实测 https://x/?q=a&b=c 被解析成 https://x/?q=a&）—— 书签地址被篡改；
//   B. 数字实体不解码 → 标题里的 &#60; 原样残留，去重/匹配全部失效；
//   C. 我们自己写出去时转义标题、读回来却不反转义 → 标题含 & / < 的节点每次往返都变形，
//      合并时同名文件夹匹配不上，被判成新增 → 重复创建文件夹。

const { loadSource } = require('./load-source');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

loadSource();
for (const f of ['via-adapter.js']) {
  vm.runInThisContext(
    fs.readFileSync(path.resolve(__dirname, '..', 'adapters', f), 'utf8'),
    { filename: 'adapters/' + f }
  );
}

const M = global.MiniSync;
const ROOT_ID = global.ROOT_ID;
const HOME_FOLDER_ID = global.HOME_FOLDER_ID;

// floccus HtmlSerializer.serialize() 的真实输出（含结尾换行；<A> 带 TAGS/ID，实体为数字形式）
const FLOCCUS_FILE = `<DL><p>
<DT><A HREF="https://www.zhihu.com/search?q=a&#38;b=c" TAGS="" ID="101">知乎 &#38; 首页</A>
<DT><A HREF="https://example.com/x?a=1&#38;b=2" TAGS="" ID="102">A&#60;B&#62;C&#34; 测试</A>
<DT><H3 ID="103">技术</H3>
<DL><p>
  <DT><A HREF="https://developer.mozilla.org/zh-CN/" TAGS="" ID="104">MDN</A>
</DL><p>
</DL><p>
`;

describe('bookmarks.html — floccus 写出的文件（可拓方向）', () => {
  const list = parseHtmlToBookmarks(FLOCCUS_FILE);

  test('文件以裸 <DL><p> 起头也能解析出全部条目', () => {
    expect(list.length).toBe(4); // 2 顶层书签 + 1 文件夹 + 1 子书签
  });

  test('URL 里的数字实体 & 被解码，查询串完整（缺陷 A）', () => {
    // 按 URL 前缀定位（不依赖标题），这样「标题没解码」不会掩盖「URL 被截断」这条断言
    const zhihu = list.find(n => !n.isFolder && /zhihu\.com/.test(n.url || ''));
    expect(zhihu).toBeTruthy();
    expect(zhihu.url).toBe('https://www.zhihu.com/search?q=a&b=c');
    const ex = list.find(n => !n.isFolder && /example\.com\/x/.test(n.url || ''));
    expect(ex.url).toBe('https://example.com/x?a=1&b=2');
    // 反向：不应残留被截断的形态
    expect(list.some(n => /[?&]$/.test(n.url || ''))).toBe(false);
  });

  test('标题里的数字实体被解码，且尖括号不会被去标签规则吃掉（缺陷 B）', () => {
    expect(list.find(n => n.title === '知乎 & 首页')).toBeTruthy();
    expect(list.find(n => n.title === 'A<B>C" 测试')).toBeTruthy();
    // 反向：不应出现残留实体，也不应被吃成 "AC"
    expect(list.some(n => /&#\d+;/.test(n.title))).toBe(false);
    expect(list.some(n => n.title === 'AC" 测试')).toBe(false);
  });

  test('文件夹层级与标题正确（嵌套 DL 归属到父文件夹）', () => {
    const tech = list.find(n => n.isFolder && n.title === '技术');
    expect(tech).toBeTruthy();
    const mdn = list.find(n => n.title === 'MDN');
    expect(mdn.parentId).toBe(tech.id);
    expect(mdn.url).toBe('https://developer.mozilla.org/zh-CN');
  });

  test('解析是确定性的（同一文件两次解析 id 完全一致，去重才不会失效）', () => {
    const again = parseHtmlToBookmarks(FLOCCUS_FILE);
    expect(again.map(n => n.id).sort()).toEqual(list.map(n => n.id).sort());
  });
});

describe('bookmarks.html — 自家写出再读回（Via 方向）', () => {
  test('标题含 & / 尖括号的节点往返逐字不变（缺陷 C）', () => {
    const src = [
      { id: 'a1', title: 'A & B <b>粗</b>', url: 'https://round.example/?x=1&y=2', isFolder: false, parentId: ROOT_ID, source: 'bar', addedAt: 1700000000000 },
      { id: 'f1', title: 'A&B 文件夹', url: '', isFolder: true, parentId: ROOT_ID, source: 'bar', addedAt: 1700000000000 },
    ];
    const back = parseHtmlToBookmarks(serializeToHtml(src));
    const bm = back.find(n => !n.isFolder);
    expect(bm.title).toBe('A & B <b>粗</b>');   // 旧实现读回是 'A &amp; B &lt;b&gt;粗&lt;/b&gt;'
    expect(bm.url).toBe('https://round.example/?x=1&y=2');
    expect(back.find(n => n.isFolder).title).toBe('A&B 文件夹');
  });

  test('标题含 & 的文件夹本地/远端 pathKey 一致（否则会被判成新增而重复创建）', () => {
    const local = [
      { id: 'f1', title: 'A&B 文件夹', isFolder: true, parentId: ROOT_ID, source: 'bar', url: '' },
    ];
    const remoteFile = serializeToHtml(local);
    const remote = parseHtmlToBookmarks(remoteFile);

    const localPk = Array.from(computePathKeys(local).values());
    const remotePk = Array.from(computePathKeys(remote).values());
    expect(remotePk).toEqual(localPk);
  });

  test('home 区仍走 favorites.txt，不写进 HTML', () => {
    const html = serializeToHtml([
      { id: 'h1', title: '主页快捷', url: 'https://home.example/', isFolder: false, parentId: HOME_FOLDER_ID, source: 'home', addedAt: 1 },
      { id: HOME_FOLDER_ID, title: '主页文件夹', url: '', isFolder: true, parentId: ROOT_ID, source: 'home', addedAt: 1 },
    ]);
    expect(html).not.toContain('主页快捷');
    expect(html).not.toContain('主页文件夹');
  });

  // 缺陷 D（早前修）：写端只转义了标题、URL 裸写，而读端会 decodeHtmlEntities ⇒ 两边不对称。
  //   实测后果：① URL 里含字面量 "&amp;" 时往返一次被改写成 "&"（书签地址被篡改）；
  //             ② URL 里含引号时直接撑破 HREF 属性，解析回来被截断。
  //   normalizeUrl 只对 http(s) 走 new URL() 做百分号编码，非 http 协议（file:/data: 等）原样返回，
  //   所以带引号的 URL 真能走到写端。
  describe('URL 转义：写读对称（缺陷 D）', () => {
    test('URL 里的字面量 &amp; 往返不被改写', () => {
      const src = [{
        id: 'u1', title: '实体文本 URL', url: 'https://x.example/?a=1&amp;b=2',
        isFolder: false, parentId: ROOT_ID, source: 'bar', addedAt: 1700000000000
      }];
      const back = parseHtmlToBookmarks(serializeToHtml(src));
      expect(back.find(n => !n.isFolder).url).toBe('https://x.example/?a=1&amp;b=2');
    });

    test('非 http 协议 URL 里的引号/尖括号不撑破属性', () => {
      const src = [{
        id: 'u2', title: '怪 URL', url: 'file:///C:/odd"name<sub>.txt',
        isFolder: false, parentId: ROOT_ID, source: 'bar', addedAt: 1700000000000
      }];
      const html = serializeToHtml(src);
      // 写出的属性值里不许有裸引号（否则属性提前闭合）
      expect(html).toContain('file:///C:/odd&quot;name&lt;sub&gt;.txt');
      const back = parseHtmlToBookmarks(html);
      expect(back.find(n => !n.isFolder).url).toBe('file:///C:/odd"name<sub>.txt');
    });
  });
});

describe('favorites.txt — 主页通道（JSONL）', () => {
  test('JSONL 逐行解析，order 参与排序', () => {
    const txt = '{"title":"A & B","url":"https://a.example/?x=1&y=2","order":1}\n{"title":"C","url":"https://c.example/","order":0}\n';
    const home = parseFavoritesTxt(txt);
    expect(home.length).toBe(2);
    // JSON 里的 & 本来就是明文，不能被当成实体再解码一次
    expect(home.find(n => n.title === 'A & B').url).toBe('https://a.example/?x=1&y=2');
    expect(home.find(n => n.title === 'C')._otherIndex).toBe(0);
  });

  test('写回的 JSONL 可被自己解析（往返一致）', () => {
    const src = [{ title: 'A & B', url: 'https://a.example/', source: 'home', parentId: HOME_FOLDER_ID, isFolder: false }];
    const back = parseFavoritesTxt(serializeToFavoritesTxt(src));
    // URL 会经 normalizeUrl：尾部斜杠被有意剥掉（去重口径），标题必须逐字不变
    expect(back.map(n => [n.title, n.url])).toEqual([['A & B', 'https://a.example']]);
  });
});
