const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'extension/app.js'), 'utf8');
const rules = fs.readFileSync(path.join(root, 'extension/rules.js'), 'utf8');
const background = fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8');
const tick = () => new Promise(setImmediate);
function event() { const listeners = []; return { listeners, addListener(fn) { listeners.push(fn); } }; }
function host(initialTabs = [], deferred = []) {
  let tabs = structuredClone(initialTabs), data = structuredClone(deferred), nextTimer = 0;
  const extraStorage = {}, alarms = new Map(), downloads = new Map(), downloadRequests = [];
  const timers = new Map(), elements = {}, counts = { query: 0 }, removed = [], restored = [], focused = [];
  const errors = [], storageEvents = event(), tabEvents = { onCreated: event(), onRemoved: event(), onUpdated: event() };
  const chrome = {
    runtime: { id: 'test', onMessage: event(), onInstalled: event(), onStartup: event() },
    tabs: { ...tabEvents, query: async () => { counts.query++; return structuredClone(tabs); },
      remove: async ids => { ids = Array.isArray(ids) ? ids : [ids]; removed.push(...ids); tabs = tabs.filter(t => !ids.includes(t.id)); },
      update: async id => { const tab = tabs.find(t => t.id === id); if (!tab) throw Error('Missing tab'); focused.push(id); return tab; } },
    windows: { update: async id => { focused.push('window-' + id); }, getCurrent: async () => ({ id: 1 }) },
    sessions: { getRecentlyClosed: async () => [{ window: { sessionId: 'window-session' } }], restore: async id => restored.push(id) },
    storage: { onChanged: storageEvents, local: { get: async () => ({ ...structuredClone(extraStorage), deferred: structuredClone(data) }), set: async value => { if ('deferred' in value) data = structuredClone(value.deferred); for (const [key, item] of Object.entries(value)) if (key !== 'deferred') extraStorage[key] = structuredClone(item); } } },
    alarms: { onAlarm: event(), create: async (name, info) => { alarms.set(name, info); } },
    downloads: { onChanged: event(),
      download: async options => { downloadRequests.push(options); const id = downloadRequests.length; downloads.set(id, { id, state: 'in_progress' }); return id; },
      search: async ({id}) => downloads.has(id) ? [structuredClone(downloads.get(id))] : [],
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} }
  };
  function element(id) { return elements[id] ||= { style: {}, innerHTML: '', textContent: '', value: '', classList: { add() {}, remove() {} } }; }
  const docEvents = {};
  const context = vm.createContext({ URL, console: { warn: (...args) => errors.push(args), error: (...args) => errors.push(args) }, chrome, crypto: webcrypto,
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    document: { addEventListener(name, fn) { (docEvents[name] ||= []).push(fn); },
      getElementById: element, querySelectorAll: () => [], querySelector: () => null } });
  vm.runInContext(rules, context); vm.runInContext(app, context);
  async function ready() { await tick(); }
  async function click(action, extra = {}) {
    const actionEl = { dataset: { action, ...extra }, closest: () => null };
    await context.handleDashboardClick({ target: { closest: () => actionEl }, stopPropagation() {} });
  }
  async function flush() { const queued = [...timers.values()]; timers.clear(); for (const fn of queued) await fn(); }
  return { context, chrome, alarms, extraStorage, downloads, downloadRequests, counts, removed, restored, focused, elements, element, timers, errors, docEvents, ready, click, flush,
    tabs: () => tabs, data: () => data, setData(value) { data = structuredClone(value); },
    async changed() { await Promise.all(storageEvents.listeners.map(fn => fn({ deferred: {} }, 'local'))); } };
}
const web = (id, url = 'https://example.com/' + id, windowId = 1) => ({ id, url, windowId, title: '页面 ' + id });

test('首页分类、内部页过滤和统计', async () => {
  const h = host([web(1, 'https://github.com/'), web(2, 'https://github.com/a/b'), web(3, 'chrome://settings/'), web(4, '')]); await h.ready();
  const groups = vm.runInContext('domainGroups', h.context);
  assert.equal(groups.length, 1); assert.deepEqual(Array.from(groups[0].tabs, tab => tab.id), [2]);
  assert.equal(h.element('statTabs').textContent, 2);
});
test('单标签跳转与关闭按 ID，不混淆重复 URL', async () => {
  const h = host([web(1), web(2, 'https://example.com/1', 2)]); await h.ready();
  await h.click('focus-tab', { tabId: '2' }); assert.deepEqual(h.focused, [2, 'window-2']);
  await h.click('close-single-tab', { tabId: '2' }); assert.deepEqual(h.removed, [2]); assert.equal(h.tabs()[0].id, 1);
});
test('分组关闭保留其他组同域名标签；已经关闭的 ID 不报错', async () => {
  const h = host([web(1, 'https://github.com/'), web(2, 'https://github.com/a/b')]); await h.ready();
  const group = vm.runInContext("domainGroups.find(g => g.domain !== '__landing-pages__')", h.context);
  await h.click('close-domain-tabs', { domainId: h.context.buildGroupId(group.domain) });
  await h.context.closeTabsByIds([999]); assert.deepEqual(h.removed, [2]);
});
test('一键关闭包含本地文件，保留内部页面', async () => {
  const h = host([web(1, 'file:///tmp/a'), web(2, 'http://localhost:3000/'), web(3, 'chrome://settings/'), web(4, 'edge://settings/')]); await h.ready();
  await h.click('close-all-open-tabs'); assert.deepEqual(h.removed, [1, 2]);
});
test('去重保留活动副本，查询不到旧 URL 时不误关', async () => {
  const h = host([web(1), { ...web(2, 'https://example.com/1'), active: true }]); await h.ready();
  await h.context.closeDuplicateTabs(['https://example.com/1', 'https://gone.test/']); assert.deepEqual(h.removed, [1]);
});
test('保存成功后只关闭选中 ID，写入失败时不关闭', async () => {
  const h = host([web(1), web(2, 'https://example.com/1')]); await h.ready();
  h.chrome.runtime.sendMessage = async () => ({ ok: false, error: 'storage failed' });
  await h.click('defer-single-tab', { tabId: '2', tabUrl: 'https://example.com/1' }); assert.equal(h.removed.length, 0);
  h.chrome.runtime.sendMessage = async () => ({ ok: true });
  await h.click('defer-single-tab', { tabId: '2', tabUrl: 'https://example.com/1' }); assert.deepEqual(h.removed, [2]);
});
test('连续事件合并为一次查询', async () => {
  const h = host([web(1)]); await h.ready(); const before = h.counts.query;
  for (let i = 0; i < 5; i++) h.chrome.tabs.onRemoved.listeners[0]();
  assert.equal(h.timers.size, 1); await h.flush(); assert.equal(h.counts.query, before + 1);
});
test('展开状态跨重绘保留，中文组 ID 不冲突，隐藏项显示端口', async () => {
  const h = host(); await h.ready();
  const tabs = Array.from({ length: 9 }, (_, i) => web(i, 'http://localhost:3000/' + i));
  const group = { domain: '测试组', hostnames: ['localhost'], tabs };
  assert.notEqual(h.context.buildGroupId('测试组'), h.context.buildGroupId('另一个组'));
  h.context.testGroup = group; vm.runInContext('expandedGroups.add(buildGroupId(testGroup.domain))', h.context);
  const html = h.context.renderDomainCard(group);
  assert(html.includes('display:contents')); assert(html.includes('3000 页面 8'));
});
test('标题和属性统一转义，不把文字解析为标签', async () => {
  const h = host(); await h.ready();
  const title = '<b>示例</b> & "引号"';
  for (const html of [h.context.renderArchiveItem({ id: 'a', title, url: 'https://example.com/?x="a"&q=&quot;' }), h.context.renderDomainCard({ domain: 'example.com', tabs: [{ ...web(1), title }] })]) {
    assert(!html.includes('<b>')); assert(html.includes('&lt;b&gt;')); assert(html.includes('&quot;引号&quot;'));
  }
});
test('侧栏变化同步，保留归档搜索；不刷新主面板', async () => {
  const h = host(); await h.ready(); const queries = h.counts.query;
  h.element('archiveSearch').value = 'Alpha'; h.element('archiveBody').style.display = 'block';
  h.setData([{ id: 'a', title: 'Alpha', url: 'https://example.com', completed: true }, { id: 'b', title: 'Beta', url: 'https://example.org', completed: true }]); await h.changed();
  assert(h.element('archiveList').innerHTML.includes('Alpha')); assert(!h.element('archiveList').innerHTML.includes('Beta'));
  assert.equal(h.element('archiveBody').style.display, 'block'); assert.equal(h.counts.query, queries);
});
test('侧栏并发刷新串行补刷，避免旧快照覆盖新状态', async () => {
  const h = host(); await h.ready(); let release, runs = 0, active = 0, peak = 0;
  h.context.controlled = async () => { runs++; active++; peak = Math.max(peak, active); if (runs === 1) await new Promise(resolve => { release = resolve; }); active--; };
  vm.runInContext('renderDeferredColumnContent = controlled', h.context);
  const first = h.context.renderDeferredColumn(); const second = h.context.renderDeferredColumn();
  release(); await Promise.all([first, second]); assert.equal(runs, 2); assert.equal(peak, 1);
});
test('恢复窗口使用完整 session ID', async () => {
  const h = host(); await h.ready(); await h.click('restore-tab'); assert.deepEqual(h.restored, ['window-session']);
});
test('后台并发写入、旧 ID、失败恢复', async () => {
  const h = host([], [{ id: 'old', title: '旧记录', url: 'https://example.com', completed: false }]); await h.ready();
  vm.runInNewContext(background, { chrome: h.chrome, crypto: webcrypto, setTimeout, clearTimeout });
  h.chrome.runtime.sendMessage = message => new Promise(resolve => { assert.equal(h.chrome.runtime.onMessage.listeners.at(-1)(message, {}, resolve), true); });
  await Promise.all(Array.from({ length: 10 }, (_, i) => h.context.saveTabForLater({ url: 'https://example.com/' + i, title: '新增' + i })));
  assert.equal(h.data().length, 11); assert.equal(new Set(h.data().map(t => t.id)).size, 11);
  await Promise.all([h.context.checkOffSavedTab('old'), h.context.dismissSavedTab('old')]);
  assert(h.data()[0].completed); assert(h.data()[0].dismissed);
  const set = h.chrome.storage.local.set; let fail = true;
  h.chrome.storage.local.set = async value => { if (fail) { fail = false; throw Error('写入失败'); } await set(value); };
  const result = await Promise.allSettled([h.context.saveTabForLater({ title: '失败' }), h.context.saveTabForLater({ title: '成功' })]);
  assert.equal(result[0].status, 'rejected'); assert.equal(result[1].status, 'fulfilled');
});


test('过期标签查询不覆盖较新的查询结果', async () => {
  const h = host(); await h.ready(); let release;
  h.chrome.tabs.query = () => new Promise(resolve => { release = resolve; });
  const older = h.context.fetchOpenTabs();
  h.chrome.tabs.query = async () => [web(9)]; await h.context.fetchOpenTabs();
  release([web(1)]); await older;
  assert.equal(vm.runInContext('openTabs[0].id', h.context), 9);
});
test('后台角标合并事件，忽略无关更新', async () => {
  const h = host([web(1)]); await h.ready();
  const timers = new Map(); let id = 0;
  vm.runInNewContext(background, { chrome: h.chrome, crypto: webcrypto, setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(key) { timers.delete(key); } });
  await tick(); const before = h.counts.query;
  const updated = h.chrome.tabs.onUpdated.listeners.at(-1);
  updated(1, { title: '新标题' }); assert.equal(timers.size, 0);
  for (let i = 0; i < 5; i++) h.chrome.tabs.onRemoved.listeners.at(-1)();
  assert.equal(timers.size, 1); await [...timers.values()][0](); assert.equal(h.counts.query, before + 1);
});
test('失败的标签操作给出提示并安排刷新', async () => {
  const h = host(); await h.ready();
  const actionEl = { dataset: { action: 'focus-tab', tabId: '999' }, closest: () => null };
  h.docEvents.click[0]({ target: { closest: () => actionEl } }); await tick();
  assert.equal(h.element('toastText').textContent, '操作失败，请刷新后重试');
  assert(h.timers.size > 0);
});


test('两个管理页共享数据后均自动更新待办与归档', async () => {
  const a = host(), b = host(); await Promise.all([a.ready(), b.ready()]);
  let shared = [{ id: 'shared', title: '共享待办', url: 'https://example.com' }];
  for (const h of [a, b]) h.chrome.storage.local.get = async () => ({ deferred: structuredClone(shared) });
  await Promise.all([a.changed(), b.changed()]);
  for (const h of [a, b]) assert(h.element('deferredList').innerHTML.includes('共享待办'));
  shared[0].completed = true; await Promise.all([a.changed(), b.changed()]);
  for (const h of [a, b]) { assert.equal(h.element('deferredList').style.display, 'none'); assert(h.element('archiveList').innerHTML.includes('共享待办')); }
  shared = []; await Promise.all([a.changed(), b.changed()]);
  for (const h of [a, b]) {
    assert.equal(h.element('deferredColumn').style.display, 'block');
    assert.equal(h.element('deferredEmpty').style.display, 'block');
    assert.equal(h.element('deferredCount').textContent, '0 项');
  }
});
test('主面板渲染期间的新请求串行补刷', async () => {
  const h = host(); await h.ready(); let runs = 0, active = 0, peak = 0, release;
  h.context.controlled = async () => { runs++; active++; peak = Math.max(peak, active); if (runs === 1) await new Promise(resolve => { release = resolve; }); active--; };
  vm.runInContext('renderStaticDashboard = controlled', h.context);
  const first = h.context.renderDashboard(); await h.context.renderDashboard(); await h.context.renderDashboard();
  release(); await first; assert.equal(runs, 2); assert.equal(peak, 1);
});


test('顶部七个导航主页不显示活动卡片，具体内容页和其他站点照常展示', async () => {
  const navigation = ['https://www.baidu.com/', 'https://translate.google.com/?sl=auto&tl=zh-CN', 'https://www.qianwen.com/chat/', 'https://github.com/', 'https://huggingface.co/', 'https://x.com/home', 'https://www.youtube.com/'];
  const others = ['https://mail.google.com/', 'https://www.linkedin.com/', 'https://grrrs.sdkdns1.com/', 'https://github.com/a/b', 'https://huggingface.co/models', 'https://x.com/user/status/123', 'https://www.youtube.com/watch?v=abc', 'https://www.baidu.com/s?wd=test', 'https://www.qianwen.com/chat/session-123'];
  const h = host([...navigation, ...others].map((url, i) => web(i + 1, url))); await h.ready();
  const groups = vm.runInContext('domainGroups', h.context);
  assert(!groups.some(g => g.domain === '__landing-pages__'));
  const ids = Array.from(groups).flatMap(group => Array.from(group.tabs, tab => tab.id)).sort((a, b) => a - b);
  assert.deepEqual(ids, others.map((_, i) => i + 8));
  assert.equal(h.element('statTabs').textContent, 16);
});

test('活动区直接展示站点卡片，未知站点合并为一张卡片', async () => {
  const h = host([web(1, 'https://github.com/a/b'), web(2, 'https://arxiv.org/abs/123'), web(3, 'https://unknown-one.example/article'), web(4, 'https://unknown-two.example/article')]);
  await h.ready();
  const html = h.element('openTabsMissions').innerHTML;
  assert.equal((html.match(/class="mission-card domain-card/g) || []).length, 2);
  assert.equal((html.match(/class="mission-card unconfigured-card/g) || []).length, 1);
  assert(!html.includes('category-module'));
  assert(!html.includes('category-title'));
  assert.equal(vm.runInContext('domainGroups.length', h.context), 4);
});

test('已配置站点在左侧，未知站点合并在右侧且没有批量关闭', async () => {
  const h = host([web(1, 'https://unknown-one.example/a'), web(2, 'https://arxiv.org/abs/123'), web(3, 'https://unknown-two.example/b')]);
  await h.ready();
  const groups = vm.runInContext('domainGroups', h.context);
  assert.deepEqual(Array.from(groups, g => g.configured), [true, false, false]);
  const html = h.element('openTabsMissions').innerHTML;
  const split = html.indexOf('class="unconfigured-sites"');
  assert(split > html.indexOf('class="configured-sites"'));
  assert(html.slice(0, split).includes('arXiv'));
  assert(!html.slice(0, split).includes('Unknown-one'));
  const right = html.slice(split);
  assert(right.includes('其他站点'));
  assert(!right.includes('未配置站点'));
  const badge = right.match(/<span class="open-tabs-badge">([\s\S]*?)<\/span>/)[1];
  assert(badge.includes(vm.runInContext('ICONS.tabs', h.context)));
  assert(badge.includes('标签总数：2'));
  assert.equal((right.match(/class="mission-card unconfigured-card/g) || []).length, 1);
  assert.equal((right.match(/<section class="unconfigured-site-section"/g) || []).length, 2);
  assert(!right.includes('data-action="close-domain-tabs"'));
  assert(right.includes('data-action="close-single-tab"'));
  assert(right.includes('data-action="defer-single-tab"'));
  const unknown = groups.find(g => !g.configured);
  await h.click('close-domain-tabs', { domainId: h.context.buildGroupId(unknown.domain) });
  assert.equal(h.removed.length, 0);
  assert(h.element('openTabsSectionCount').innerHTML.includes('标签组数量：2'));
});

test('站点配置 ID 和域名唯一，七个导航入口由配置生成', async () => {
  const h = host(); await h.ready();
  const sites = vm.runInContext('SITES', h.context);
  assert.equal(sites.length, new Set(sites.map(s => s.id)).size);
  const hosts = Array.from(sites).flatMap(s => Array.from(s.hosts));
  assert.equal(hosts.length, new Set(hosts).size);
  const navigation = sites.filter(s => s.navigation).sort((a, b) => a.navigation.order - b.navigation.order);
  assert.equal(navigation.length, 7);
  for (const site of navigation) {
    assert(site.hosts.includes(new URL(site.navigation.url).hostname));
    assert(h.context.isNavigationPage(site.navigation.url));
    assert(vm.runInContext('NAV_ICONS', h.context)[site.navigation.icon]);
  }
  const html = h.element('quickNav').innerHTML;
  assert.equal((html.match(/class="quick-nav-item"/g) || []).length, 7);
  assert(html.indexOf('百度') < html.indexOf('谷歌翻译'));
});
test('未启用子域名时不继承父站点；显式别名与子域开关有效', async () => {
  const h = host(); await h.ready();
  assert.equal(h.context.findSite('unlisted.google.com'), null);
  assert.equal(h.context.findSite('unlisted.chatgpt.com'), null);
  assert.equal(h.context.findSite('docs.google.com').name, 'Google 文档');
  assert.equal(h.context.findSite('tenant.feishu.cn').name, '飞书');
  assert.equal(h.context.findSite('grapecity.csdn.net').name, 'CSDN');
  assert.equal(h.context.findSite('notfeishu.cn'), null);
  assert.equal(h.context.findSite('feishu.cn.attacker.test'), null);
  assert.equal(h.context.getGroupKey('twitter.com').key, h.context.getGroupKey('x.com').key);
  assert.equal(h.context.getGroupKey('qianwen.com').key, h.context.getGroupKey('tongyi.aliyun.com').key);
});
test('阿里云子站合并，千问精确别名优先且不误匹配其他域名', async () => {
  const urls = ['https://help.aliyun.com/zh/a', 'https://help.aliyun.com/zh/b', 'https://devops.aliyun.com/appstack/', 'https://codeup.aliyun.com/repo'];
  const h = host([...urls, 'https://tongyi.aliyun.com/chat/session'].map((url, i) => web(i + 1, url)));
  await h.ready();
  const groups = vm.runInContext('domainGroups', h.context);
  const aliyun = groups.find(g => g.siteId === 'aliyun');
  assert.equal(aliyun.tabs.length, 4);
  assert.equal(aliyun.displayName, 'Aliyun');
  assert.equal(groups.find(g => g.siteId === 'tongyi-aliyun-com').tabs.length, 1);
  assert.equal(h.context.findSite('aliyun.com').id, 'aliyun');
  for (const hostname of ['fakealiyun.com', 'aliyun.com.evil.test']) assert.equal(h.context.findSite(hostname), null);
});
test('改名不改变分组 ID，同名站点及未知主机不误合并', async () => {
  const h = host(); await h.ready();
  const before = h.context.getGroupKey('github.com').key;
  h.context.findSite('github.com').name = '新名称';
  assert.equal(h.context.getGroupKey('github.com').key, before);
  vm.runInContext("SITES.push({id:'test-a',name:'同名',hosts:['a.example']},{id:'test-b',name:'同名',hosts:['b.example']})", h.context);
  assert.notEqual(h.context.getGroupKey('a.example').key, h.context.getGroupKey('b.example').key);
  assert.notEqual(h.context.getGroupKey('one.com').key, h.context.getGroupKey('one.net').key);
});
test('导航排除同时检查主机和路径，不隐藏音乐站及旧别名主页', async () => {
  const h = host(); await h.ready();
  assert(h.context.isNavigationPage('https://youtube.com/?theme=dark'));
  assert(h.context.isNavigationPage('https://qianwen.com/chat/'));
  for (const url of ['https://music.youtube.com/', 'https://tongyi.aliyun.com/chat/', 'https://github.com/org/repo', 'https://www.qianwen.com/chat/session-1']) {
    assert.equal(h.context.isNavigationPage(url), false);
  }
});
test('自定义分组仍优先，本地文件保持已配置站点', async () => {
  const h = host([web(1,'https://custom.example/project/a'),web(2,'file:///tmp/a')]); await h.ready();
  h.context.LOCAL_CUSTOM_GROUPS = [{hostname:'custom.example',pathPrefix:'/project/',groupKey:'work',groupLabel:'我的项目'}];
  await h.context.renderDashboard();
  const groups = vm.runInContext('domainGroups',h.context);
  assert(groups.some(g => g.domain==='custom/work' && g.configured));
  assert(groups.some(g => g.siteId==='local-files' && g.configured));
});

test('同一站点别名合并，导航排除仅限原入口', async () => {
  const h = host(); await h.ready();
  for (const [primary, aliases] of [
    ['github.com', ['gist.github.com', 'docs.github.com']],
    ['google.com', ['www.google.com.hk', 'google.co.jp', 'www.google.co.uk']],
    ['kimi.moonshot.cn', ['kimi.com', 'www.kimi.com']],
    ['leetcode.cn', ['leetcode.com', 'www.leetcode.com']],
    ['cloud.tencent.com', ['console.cloud.tencent.com']],
    ['huaweicloud.com', ['support.huaweicloud.com', 'console.huaweicloud.com']],
    ['aws.amazon.com', ['console.aws.amazon.com', 'docs.aws.amazon.com', 'console.aws.amazon.com.cn']],
    ['developers.openai.com', ['platform.openai.com']],
  ]) {
    for (const alias of aliases) assert.equal(h.context.getGroupKey(primary).key, h.context.getGroupKey(alias).key, alias);
  }
  for (const url of ['https://gist.github.com/', 'https://docs.github.com/', 'https://www.google.com.hk/', 'https://kimi.com/']) {
    assert.equal(h.context.isNavigationPage(url), false, url);
  }
});

test('同公司独立产品保留卡片，租户托管域名及伪造后缀不归并', async () => {
  const h = host(); await h.ready();
  for (const [a, b] of [
    ['google.com', 'play.google.com'], ['google.com', 'mail.google.com'],
    ['docs.google.com', 'drive.google.com'], ['claude.ai', 'code.claude.com'],
    ['chatgpt.com', 'learn.chatgpt.com'], ['chatgpt.com', 'developers.openai.com'],
    ['amazon.com', 'aws.amazon.com'], ['hailuoai.com', 'minimax.io'],
  ]) assert.notEqual(h.context.getGroupKey(a).key, h.context.getGroupKey(b).key);
  for (const hostname of ['example.github.io', 'example.vercel.app', 'example.workers.dev', 'example.notion.site', 'bucket.s3.amazonaws.com', 'bucket.s3.amazonaws.cn', 'notaliyun.com', 'aliyun.com.attacker.test', 'cloud.tencent.com.attacker.test', 'notcloud.tencent.com']) {
    assert.equal(h.context.findSite(hostname), null, hostname);
  }
});

test('当前浏览器常用站点可识别，未确认的个人网站与 IP 仍归其他', async () => {
  const hosts = ['gitcode.com', 'git-scm.com', 'skillhub.cn', 'clawhubcn.com', 'reddit.com', 'google.com.hk', 'learn.chatgpt.com', 'play.google.com', 'developers.openai.com', 'cn.origincoder.com'];
  const h = host(hosts.map((host, i) => web(i + 1, 'https://' + host + '/content'))); await h.ready();
  const groups = vm.runInContext('domainGroups', h.context);
  assert(groups.every(g => g.configured));
  assert(!h.element('openTabsMissions').innerHTML.includes('class="unconfigured-sites"'));
  for (const host of ['43.110.151.227', '129.121.97.124', 'www.roydust.top', '21obsidian.com']) assert.equal(h.context.findSite(host), null);
});

test('配置图标全部为本地简短文本且可渲染', async () => {
  const h = host(); await h.ready();
  for (const site of vm.runInContext('SITES', h.context)) {
    assert.equal(typeof site.icon, 'string', site.id);
    assert(Array.from(site.icon).length >= 1 && Array.from(site.icon).length <= 3, site.id);
    const html = h.context.renderSiteTitleIcon({siteId:site.id,displayName:site.name});
    assert(html.includes('<svg'), site.id);
    assert(!html.includes('<img'), site.id);
    assert(!html.includes('https://'), site.id);
  }
});

test('仅 Git 集合合并，统一列表与五项展开保留，其他产品独立', async () => {
  const gitUrls = ['https://github.com/org/repo', 'https://gist.github.com/example', 'https://docs.github.com/en', 'https://gitlab.com/org/repo', 'https://gitee.com/org/repo', 'https://gitcode.com/org/repo', 'https://git-scm.com/docs'];
  const others = ['https://codeup.aliyun.com/repo', 'https://cloud.tencent.com/product', 'https://chatgpt.com/c/1', 'https://claude.ai/chat/1', 'https://docs.google.com/document/1', 'https://drive.google.com/drive/1'];
  const h = host([...gitUrls, ...others, 'https://github.com/'].map((url, i) => web(i + 1, url)));
  await h.ready();
  const groups = vm.runInContext('domainGroups', h.context);
  const git = groups.find(g => g.siteId === 'github-com');
  assert.equal(git.displayName, 'Git 与代码托管');
  assert.deepEqual(Array.from(git.tabs, t => t.id), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(groups.length, 1 + others.length);
  const html = h.context.renderDomainCard(git);
  assert(!html.includes('unconfigured-site-section'));
  assert(html.includes('展开其余 2 项'));
  assert(html.includes('标签总数：7'));
  for (const url of gitUrls) assert.equal(h.context.getGroupKey(new URL(url).hostname).key, 'site/github-com');
  assert(h.context.isNavigationPage('https://github.com/'));
  for (const url of ['https://gitlab.com/', 'https://gitee.com/', 'https://gitcode.com/', 'https://git-scm.com/', 'https://gist.github.com/']) assert.equal(h.context.isNavigationPage(url), false);
  const nav = h.element('quickNav').innerHTML;
  assert.equal((nav.match(/class="quick-nav-item"/g) || []).length, 7);
  assert(nav.includes('https://github.com/'));
  assert(!nav.includes('Git 与代码托管'));
  await h.click('close-domain-tabs', {domainId:h.context.buildGroupId(git.domain)});
  assert.deepEqual(h.removed, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(h.tabs().length, others.length + 1);
});

test('已配置站点按显示名称排序，不受标签数量和查询顺序影响', async () => {
  const urls = ['https://zhihu.com/a', 'https://zhihu.com/b', 'https://unknown-sort.example/a', 'https://csdn.net/a', 'https://arxiv.org/abs/a', 'https://help.aliyun.com/a', 'https://baidu.com/s?wd=a', 'https://feishu.cn/a'];
  const h = host(urls.map((url, i) => web(i + 1, url))); await h.ready();
  const expected = ['百度', '飞书', '知乎', 'Aliyun', 'arXiv', 'CSDN'];
  const names = () => Array.from(vm.runInContext('domainGroups', h.context)).filter(g => g.configured).map(g => g.displayName);
  assert.deepEqual(names(), expected);
  const html = h.element('openTabsMissions').innerHTML;
  for (let i = 1; i < expected.length; i++) assert(html.indexOf('>' + expected[i - 1] + '</span>') < html.indexOf('>' + expected[i] + '</span>'));
  assert.equal(vm.runInContext('domainGroups[domainGroups.length - 1].configured', h.context), false);
  const query = h.chrome.tabs.query;
  h.chrome.tabs.query = async () => (await query()).reverse();
  await h.context.renderDashboard();
  assert.deepEqual(names(), expected);
});


function backgroundHost(h, now) {
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context=vm.createContext({chrome:h.chrome,crypto:webcrypto,Date:Clock,setTimeout,clearTimeout,console:{warn(){}}});
  vm.runInContext(background,context);
  return context;
}

test('后台首次启用只安排下个本地零点，不立即收纳', async () => {
  const now=new Date(2026,10,18,15,30).getTime();
  const h=host([{...web(1),lastAccessed:now-9*86400000}]); await h.ready();
  const ctx=backgroundHost(h,now); await ctx.ensureDailyCollection();
  assert.equal(h.alarms.get('collect-inactive-tabs').when,new Date(2026,10,19,0,0).getTime());
  assert.equal(h.extraStorage.inactiveCollectionDue,new Date(2026,10,19,0,0).getTime());
  assert.equal(h.removed.length,0);
});

test('零点自动收纳及重启补跑，无需管理页，跳过近期活跃和未知时间', async () => {
  const now=new Date(2026,10,19,0,5).getTime(),week=7*86400000;
  const h=host([
    {...web(1),lastAccessed:now-week-1}, {...web(2),lastAccessed:now-week},
    {...web(3),lastAccessed:now-week-1,active:true},web(4),
    {...web(5,'chrome://settings/'),lastAccessed:now-week-1},
    {...web(6,'https://github.com/'),lastAccessed:now-week-1},
  ]);await h.ready();
  h.extraStorage.inactiveCollectionDue=now-300000;
  const ctx=backgroundHost(h,now);await ctx.ensureDailyCollection();
  assert.deepEqual(h.removed,[1,6]);
  assert.deepEqual(h.data().map(t=>t.url),['https://example.com/1','https://github.com/']);
  assert.equal(h.alarms.get('collect-inactive-tabs').when,new Date(2026,10,20).getTime());
  await h.chrome.alarms.onAlarm.listeners[0]({name:'unrelated'});
  await ctx.ensureDailyCollection();
  assert.equal(h.data().length,2);
});

test('自动收纳保存失败不关闭标签，保留到期状态并安排五分钟后重试', async () => {
  const now=Date.now();const h=host([{...web(1),lastAccessed:now-8*86400000}]);await h.ready();
  h.extraStorage.inactiveCollectionDue=now-1;
  const set=h.chrome.storage.local.set;
  let fail=true;
  h.chrome.storage.local.set=async value=>{if(value.deferred&&fail)throw Error('disk full');await set(value);};
  const ctx=backgroundHost(h,now);await ctx.ensureDailyCollection();
  assert.equal(h.removed.length,0);
  assert.equal(h.extraStorage.inactiveCollectionDue,now-1);
  assert.equal(h.alarms.get('collect-inactive-tabs').when,now+300000);
  fail=false;await h.chrome.alarms.onAlarm.listeners[0]({name:'collect-inactive-tabs'});
  assert.deepEqual(h.removed,[1]);assert.equal(h.data().length,1);
});

test('自动收纳复用未完成待办，运行中激活或导航的标签不关闭', async () => {
  const now=Date.now(),old=now-8*86400000;
  const h=host([{...web(1),lastAccessed:old},{...web(2),lastAccessed:old}], [{id:'existing',url:'https://example.com/1',completed:false}]);await h.ready();
  h.extraStorage.inactiveCollectionDue=now-1;
  const query=h.chrome.tabs.query;
  let calls=0;
  h.chrome.tabs.query=async()=>{const tabs=await query();calls++;if(calls>=3)for(const tab of tabs)if(tab.id===2)tab.active=true;return tabs;};
  const ctx=backgroundHost(h,now);await ctx.ensureDailyCollection();
  assert.deepEqual(h.removed,[1]);assert.equal(h.data().length,1);
});

test('自动收纳关闭失败后重试不重复保存，后台写队列仍可继续', async () => {
  const now=Date.now();const h=host([{...web(1),lastAccessed:now-8*86400000}]);await h.ready();
  h.extraStorage.inactiveCollectionDue=now-1;
  const remove=h.chrome.tabs.remove;let fail=true;
  h.chrome.tabs.remove=async ids=>{if(fail)throw Error('remove failed');return remove(ids);};
  const ctx=backgroundHost(h,now);await ctx.ensureDailyCollection();
  assert.equal(h.data().length,1);assert.equal(h.removed.length,0);
  fail=false;await ctx.ensureDailyCollection();
  assert.equal(h.data().length,1);assert.deepEqual(h.removed,[1]);
});

test('缓存导出全部待办为书签 HTML，下载完成才归档本次快照', async () => {
  const initial=[
    {id:'a',url:'https://example.com/?a=1&b="2"',title:'中文 <标题> & "引号"',completed:false},
    {id:'b',url:'https://example.org/',title:'第二项',completed:false},
    {id:'old',url:'https://archive.example/',title:'已归档',completed:true},
    {id:'gone',url:'https://dismissed.example/',title:'已移除',completed:false,dismissed:true},
  ];
  const h=host([],initial);await h.ready();
  h.element('archiveSearch').value='不匹配任何待办';
  const ctx=backgroundHost(h,Date.now());await tick();
  const result=await ctx.exportTodos();
  assert.equal(result.count,2);
  const request=h.downloadRequests[0];
  assert(request.saveAs);
  assert.match(request.filename,/^Tab-Out-待办-\d{4}-\d{2}-\d{2}\.html$/);
  const html=decodeURIComponent(request.url.slice(request.url.indexOf(',')+1));
  assert(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>'));
  assert(html.includes('charset=UTF-8'));
  assert(html.includes('HREF="https://example.com/?a=1&amp;b=&quot;2&quot;"'));
  assert(html.includes('中文 &lt;标题&gt; &amp; &quot;引号&quot;'));
  assert(!html.includes('已归档'));assert(!html.includes('已移除'));
  assert.equal(h.data().filter(t=>t.completed).length,1);
  await h.context.renderDeferredColumn();
  assert.equal(h.element('cacheTodos').disabled,true);
  h.setData([...h.data(),{id:'new',url:'https://new.example/',title:'新待办',completed:false}]);
  h.downloads.set(1,{id:1,state:'complete'});
  await h.chrome.downloads.onChanged.listeners[0]({id:1,state:{current:'complete'}});
  assert(h.data().find(t=>t.id==='a').completed);
  assert(h.data().find(t=>t.id==='b').completed);
  assert(h.data().find(t=>t.id==='a').completedAt);
  assert.equal(h.data().find(t=>t.id==='new').completed,false);
  assert.equal(h.data().find(t=>t.id==='gone').completed,false);
  assert.equal(h.extraStorage.pendingBookmarkExport,null);
  await h.context.renderDeferredColumn();
  assert.equal(h.element('cacheTodos').disabled,false);
});

test('缓存取消、下载中断或启动失败不归档，空待办不创建文件', async () => {
  const h=host([],[{id:'a',url:'https://example.com',completed:false}]);await h.ready();
  const ctx=backgroundHost(h,Date.now());await tick();
  h.chrome.downloads.download=async()=>{throw Error('User canceled');};
  await assert.rejects(ctx.exportTodos(),/User canceled/);
  assert.equal(h.data()[0].completed,false);
  h.chrome.downloads.download=async()=>{h.downloads.set(2,{id:2,state:'interrupted'});return 2;};
  await ctx.exportTodos();
  assert.equal(h.data()[0].completed,false);
  assert.equal(h.extraStorage.pendingBookmarkExport,null);
  h.setData([{id:'a',url:'https://example.com',completed:true}]);
  h.chrome.downloads.download=async()=>{throw Error('Must not download');};
  assert.equal((await ctx.exportTodos()).count,0);
});

test('缓存下载立即完成也会归档，缺失标题使用 URL，事件重复不重复归档', async () => {
  const h=host([],[{id:'a',url:'https://example.com/',completed:false}]);await h.ready();
  const ctx=backgroundHost(h,Date.now());await tick();
  h.chrome.downloads.download=async options=>{
    assert(decodeURIComponent(options.url).includes('>https://example.com/</A>'));
    h.downloads.set(1,{id:1,state:'complete'});return 1;
  };
  await ctx.exportTodos();
  const completedAt=h.data()[0].completedAt;
  assert(h.data()[0].completed);
  await h.chrome.downloads.onChanged.listeners[0]({id:1,state:{current:'complete'}});
  assert.equal(h.data()[0].completedAt,completedAt);
});

test('下载完成后即使页面关闭或后台重启，仍从持久记录恢复归档', async () => {
  const h=host([],[{id:'a',url:'https://example.com',completed:false}]);await h.ready();
  h.extraStorage.pendingBookmarkExport={downloadId:5,ids:['a']};
  h.downloads.set(5,{id:5,state:'complete'});
  const ctx=backgroundHost(h,Date.now());
  await vm.runInContext('savedTabWriteQueue',ctx);
  assert.equal(h.data()[0].completed,true);
  assert.equal(h.extraStorage.pendingBookmarkExport,null);
});

test('保存文件对话框不阻塞待办写入，重复点击不启动第二个下载', async () => {
  const h=host([],[{id:'a',url:'https://example.com',completed:false}]);await h.ready();
  const ctx=backgroundHost(h,Date.now());await tick();
  let release;
  h.chrome.downloads.download=async()=>{await new Promise(resolve=>release=resolve);h.downloads.set(1,{id:1,state:'in_progress'});return 1;};
  const first=ctx.exportTodos();await tick();
  await assert.rejects(ctx.exportTodos(),/already starting/);
  await ctx.queueSavedTabWrite(()=>ctx.updateSavedTabs({action:'save',tab:{url:'https://new.example',title:'新增'}}));
  assert.equal(h.data().length,2);
  release();await first;
  await assert.rejects(ctx.exportTodos(),/already in progress/);
  h.downloads.set(1,{id:1,state:'complete'});
  await h.chrome.downloads.onChanged.listeners[0]({id:1,state:{current:'complete'}});
  assert.equal(h.data()[0].completed,true);
  assert.equal(h.data()[1].completed,false);
});

test('下载成功但归档写入失败时保留追踪，重试后完成且不影响移除条目', async () => {
  const h=host([],[{id:'a',url:'https://example.com',completed:false}]);await h.ready();
  const ctx=backgroundHost(h,Date.now());await tick();
  await ctx.exportTodos();
  h.downloads.set(1,{id:1,state:'complete'});
  const set=h.chrome.storage.local.set;
  h.chrome.storage.local.set=async value=>{if(value.deferred)throw Error('storage failed');return set(value);};
  await h.chrome.downloads.onChanged.listeners[0]({id:1,state:{current:'complete'}});
  assert.equal(h.data()[0].completed,false);
  assert(h.extraStorage.pendingBookmarkExport);
  h.chrome.storage.local.set=set;
  h.setData([...h.data(),{id:'b',url:'https://dismissed.example',dismissed:true,completed:false}]);
  await ctx.queueSavedTabWrite(ctx.finishBookmarkExport);
  assert.equal(h.data()[0].completed,true);
  assert.equal(h.data()[1].completed,false);
  assert.equal(h.extraStorage.pendingBookmarkExport,null);
});

test('待办和下载状态来自同一次读取，加载失败时禁用缓存按钮，恢复后重新启用', async () => {
  const h=host([],[{id:'a',url:'https://example.com',title:'待办',completed:false}]);await h.ready();
  let reads=0;
  const get=h.chrome.storage.local.get;
  h.chrome.storage.local.get=async keys=>{reads++;return get(keys);};
  await h.context.renderDeferredColumn();
  assert.equal(reads,1);
  assert.equal(h.element('cacheTodos').disabled,false);
  h.extraStorage.pendingBookmarkExport={downloadId:1,ids:['a']};
  await h.context.renderDeferredColumn();
  assert.equal(h.element('cacheTodos').disabled,true);
  assert.equal(h.element('cacheTodos').title,'缓存中，下载完成后自动归档');
  h.chrome.storage.local.get=async()=>{throw Error('read failed');};
  await h.context.renderDeferredColumn();
  assert.equal(h.element('cacheTodos').disabled,true);
  assert.equal(h.element('cacheTodos').title,'待办加载失败，请刷新后重试');
  assert.equal(h.element('deferredList').style.display,'none');
  assert(h.element('deferredEmpty').textContent.includes('加载失败'));
  h.chrome.storage.local.get=get;
  h.extraStorage.pendingBookmarkExport=null;
  await h.context.renderDeferredColumn();
  assert.equal(h.element('cacheTodos').disabled,false);
  assert.equal(h.element('deferredList').style.display,'block');
});

test('批量收纳共享待办 URL 索引，重复标签只保存一次且无需逐标签重读索引', async () => {
  const old=Date.now()-8*86400000;
  const h=host([
    {...web(1,'https://existing.example'),lastAccessed:old},
    {...web(2,'https://existing.example'),lastAccessed:old},
    {...web(3,'https://new.example'),lastAccessed:old},
    {...web(4,'https://new.example'),lastAccessed:old},
  ],[{id:'existing',url:'https://existing.example',completed:false}]);await h.ready();
  const ctx=backgroundHost(h,Date.now());await ctx.ensureDailyCollection();
  await vm.runInContext('savedTabWriteQueue',ctx);
  const get=h.chrome.storage.local.get;
  let reads=0;
  h.chrome.storage.local.get=async keys=>{if(keys==='deferred')reads++;return get(keys);};
  await ctx.queueSavedTabWrite(ctx.collectInactiveTabs);
  assert.deepEqual(h.removed,[1,2,3,4]);
  assert.equal(h.data().length,2);
  assert.equal(h.data().filter(item=>item.url==='https://new.example').length,1);
  assert.equal(reads,2);
});
