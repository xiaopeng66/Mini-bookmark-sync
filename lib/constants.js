// constants.js — 全局常量定义
// ⚠️ 所有 var 声明必须在 IIFE 外部！importScripts 共享全局作用域

var MiniSync = MiniSync || {};

// ====== 全局常量声明（importScripts 全局共享）======
var CURRENT_VERSION = 2;

var STORAGE_KEYS = {
  CLOUD_LAST_MODIFIED: 'cloud_last_modified',
  SNAPSHOTS: 'sync_snapshots',
  TOMBSTONES: 'sync_tombstones',
  LOCAL_BACKUP: 'local_bookmark_backup'
};

var IDLE = 'idle';
var SYNCING = 'syncing';
var SUCCESS = 'success';
var FAILED = 'failed';

var UPLOAD_MODE = 'upload';
var DOWNLOAD_MODE = 'download';
var MERGE_MODE = 'merge';

var DEFAULT_FILENAME = 'minibookmarks.xbel';
// 旧默认主文件名：供 getWebDAVConfig 识别老配置并迁移到新默认名
var LEGACY_DEFAULT_FILENAME = 'bookmarks.xbel';

var MAIN_ENDPOINT_KEY = '__main__';

var SYNC_ALARM = 'webdav_bookmark_auto_sync';

var TOMBSTONE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3天

var ROOT_ID = 'root';
var HOME_FOLDER_ID = '__home_folder__';
var MOBILE_FOLDER_ID = '__mobile_folder__';
var OTHER_FOLDER_ID = '__other_folder__';

var FOLDER_TITLES = {
  bookmarkBar: ['书签栏', '书签', 'bookmark bar', 'bookmarks bar', 'bookmarks', '收藏夹栏', 'favorites bar'],
  otherBookmarks: ['其他书签', '其他', 'other bookmarks', 'other', '其他收藏夹', 'other favorites'],
  mobileBookmarks: ['移动设备书签', '移动书签', 'mobile bookmarks', 'mobile', '移动收藏夹'],
  // Berry主页（现名「移动端主页」）别名：首位为标准名（新建/展示用它），
  // 旧名「Berry主页」/'berry home' 保留用于识别存量数据（本地旧文件夹 + 云端旧 XBEL），
  // 识别命中后由 ensureBerryHome 自动迁移改名为新名。pathKey 不受标题影响
  // （home 容器由 HOME_FOLDER_ID 虚拟根归一为 ROOT:home），改名安全。
  // ⚠️ '主页'/'主页文件夹' 过于泛化已移除：会把用户自建同名文件夹误吸进 home 体系，
  // 上传时又被 chromeToXbel 统一改名，云端出现多个同名容器（两个 Berry主页 的污染源）。
  berryHome: ['移动端主页', 'Berry主页', 'berry home'],
};

var VIA_FILE = 'bookmarks.html';
var VIA_FAVORITES_FILE = 'favorites.txt';
var BERRY_FILE = 'bookmarks.json';
var AIRA_FILE = 'snapshot.json';

// ====== 同时挂载到命名空间 ======
MiniSync.constants = {
  CURRENT_VERSION,
  STORAGE_KEYS,
  IDLE,
  SYNCING,
  SUCCESS,
  FAILED,
  UPLOAD_MODE,
  DOWNLOAD_MODE,
  MERGE_MODE,
  DEFAULT_FILENAME,
  LEGACY_DEFAULT_FILENAME,
  MAIN_ENDPOINT_KEY,
  SYNC_ALARM,
  TOMBSTONE_TTL_MS,
  ROOT_ID,
  HOME_FOLDER_ID,
  MOBILE_FOLDER_ID,
  OTHER_FOLDER_ID,
  FOLDER_TITLES,
  VIA_FILE,
  VIA_FAVORITES_FILE,
  BERRY_FILE,
  AIRA_FILE
};
