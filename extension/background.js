/**
 * background.js — Service Worker for Badge Updates and Saved Tab Writes
 *
 * Event-driven background worker for Tab Out. Maintains the toolbar tab
 * count and serializes saved-tab writes from all dashboard pages.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping chrome:// and extension pages).
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

// ─── Saved tab writes ─────────────────────────────────────────────────────────

let savedTabWriteQueue = Promise.resolve();

function queueSavedTabWrite(task) {
  const write = savedTabWriteQueue.then(task);
  savedTabWriteQueue = write.catch(() => {});
  return write;
}

function buildBookmarkHtml(items) {
  const escape = value => String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const links = items.map(item => `    <DT><A HREF="${escape(item.url)}">${escape(item.title || item.url)}</A>`).join('\n');
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Tab Out 待办</TITLE>
<H1>Tab Out 待办</H1>
<DL><p>
${links}
</DL><p>
`;
}

// Runs inside the shared storage queue. Archive only after confirmed download completion.
async function finishBookmarkExport() {
  const { pendingBookmarkExport: pending } = await chrome.storage.local.get('pendingBookmarkExport');
  if (!pending) return;
  const [download] = await chrome.downloads.search({ id: pending.downloadId });
  if (download && download.state === 'in_progress') return;
  if (download && download.state === 'complete') {
    const { deferred = [] } = await chrome.storage.local.get('deferred');
    const ids = new Set(pending.ids);
    for (const item of deferred) {
      if (ids.has(item.id) && !item.completed && !item.dismissed) {
        item.completed = true;
        item.completedAt = new Date().toISOString();
      }
    }
    await chrome.storage.local.set({ deferred, pendingBookmarkExport: null });
  } else {
    await chrome.storage.local.set({ pendingBookmarkExport: null });
  }
}

let bookmarkExportStarting = false;

async function exportTodos() {
  if (bookmarkExportStarting) throw new Error('A bookmark export is already starting');
  bookmarkExportStarting = true;
  try {
    const items = await queueSavedTabWrite(async () => {
      await finishBookmarkExport();
      const { deferred = [], pendingBookmarkExport } = await chrome.storage.local.get(['deferred', 'pendingBookmarkExport']);
      if (pendingBookmarkExport) throw new Error('A bookmark download is already in progress');
      return deferred.filter(item => !item.completed && !item.dismissed);
    });
    if (!items.length) return { count: 0 };
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    const downloadId = await chrome.downloads.download({
      url: 'data:text/html;charset=utf-8,' + encodeURIComponent(buildBookmarkHtml(items)),
      filename: `Tab-Out-待办-${date}.html`,
      saveAs: true,
    });
    await queueSavedTabWrite(async () => {
      await chrome.storage.local.set({ pendingBookmarkExport: { downloadId, ids: items.map(item => item.id) } });
      // The download may have completed before its tracking record was persisted.
      await finishBookmarkExport();
    });
    return { count: items.length };
  } finally {
    bookmarkExportStarting = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'export-todos') return;
  exportTodos().then(
    result => sendResponse({ ok: true, ...result }),
    error => sendResponse({ ok: false, error: error.message })
  );
  return true;
});

chrome.downloads.onChanged.addListener(change => {
  if (!change.state) return;
  return queueSavedTabWrite(finishBookmarkExport).catch(error => console.warn('[tab-out] Could not finish bookmark export:', error));
});

// Restore completion tracking even when the dashboard was closed or the worker restarted.
queueSavedTabWrite(finishBookmarkExport).catch(error => console.warn('[tab-out] Could not restore bookmark export:', error));

async function updateSavedTabs(message) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');

  if (message.action === 'save') {
    deferred.push({
      id: crypto.randomUUID(),
      url: message.tab.url,
      title: message.tab.title,
      savedAt: new Date().toISOString(),
      completed: false,
      dismissed: false,
    });
  } else {
    const tab = deferred.find(item => item.id === message.id);
    if (!tab) return;
    if (message.action === 'complete') {
      tab.completed = true;
      tab.completedAt = new Date().toISOString();
    } else {
      tab.dismissed = true;
    }
  }

  await chrome.storage.local.set({ deferred });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'update-saved-tabs') return;
  if (!['save', 'complete', 'dismiss'].includes(message.action)) {
    sendResponse({ ok: false, error: 'Unknown saved-tab action' });
    return;
  }

  const write = queueSavedTabWrite(() => updateSavedTabs(message));
  write.then(
    () => sendResponse({ ok: true }),
    error => sendResponse({ ok: false, error: error.message })
  );
  // Keep the message channel open until this request's write finishes.
  return true;
});

// ─── Daily inactive-tab collection (local midnight) ──────────────────────────
const INACTIVE_ALARM = 'collect-inactive-tabs';
const INACTIVE_DUE_KEY = 'inactiveCollectionDue';
let dailyCollectionRun = null;

function isInactiveTab(tab, cutoff) {
  return /^(https?:|file:)\/\//.test(tab.url || '') && !tab.active
    && Number.isFinite(tab.lastAccessed) && tab.lastAccessed > 0
    && tab.lastAccessed < cutoff;
}

async function collectInactiveTabs() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const candidates = (await chrome.tabs.query({})).filter(tab => isInactiveTab(tab, cutoff));
  if (!candidates.length) return;
  // The caller holds the shared write queue, so this URL index stays valid throughout the run.
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const activeUrls = new Set(deferred.filter(item => !item.completed && !item.dismissed).map(item => item.url));
  for (const candidate of candidates) {
    // Recheck live state: a user may activate or navigate a tab during collection.
    const current = (await chrome.tabs.query({})).find(tab => tab.id === candidate.id);
    if (!current || current.url !== candidate.url || !isInactiveTab(current, cutoff)) continue;
    if (!activeUrls.has(current.url)) {
      await updateSavedTabs({ action: 'save', tab: { url: current.url, title: current.title || current.url } });
      activeUrls.add(current.url);
    }
    const latest = (await chrome.tabs.query({})).find(tab => tab.id === current.id);
    if (latest && latest.url === current.url && isInactiveTab(latest, cutoff)
      && latest.lastAccessed === current.lastAccessed) await chrome.tabs.remove(latest.id);
  }
}

function ensureDailyCollection() {
  if (dailyCollectionRun) return dailyCollectionRun;
  dailyCollectionRun = (async () => {
    const state = await chrome.storage.local.get(INACTIVE_DUE_KEY);
    if (Number.isFinite(state[INACTIVE_DUE_KEY]) && state[INACTIVE_DUE_KEY] <= Date.now()) {
      await queueSavedTabWrite(collectInactiveTabs);
    }
    const next = new Date();
    next.setHours(24, 0, 0, 0);
    // Calendar midnight rather than a 24-hour interval also handles DST changes.
    await chrome.alarms.create(INACTIVE_ALARM, { when: next.getTime() });
    await chrome.storage.local.set({ [INACTIVE_DUE_KEY]: next.getTime() });
  })().catch(async error => {
    console.warn('[tab-out] Daily collection failed:', error);
    // Preserve overdue state and retry without closing unsaved tabs.
    await chrome.alarms.create(INACTIVE_ALARM, { when: Date.now() + 5 * 60 * 1000 });
  }).finally(() => { dailyCollectionRun = null; });
  return dailyCollectionRun;
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === INACTIVE_ALARM) return ensureDailyCollection();
});

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        url.length > 0 &&
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────
let badgeRefreshTimer = null;

function scheduleBadgeRefresh() {
  clearTimeout(badgeRefreshTimer);
  badgeRefreshTimer = setTimeout(updateBadge, 100);
}

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
  ensureDailyCollection();
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  ensureDailyCollection();
});

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(() => {
  scheduleBadgeRefresh();
});

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener(() => {
  scheduleBadgeRefresh();
});

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'complete') scheduleBadgeRefresh();
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();

// Recreate alarms after worker/browser restarts and catch up missed midnight runs.
ensureDailyCollection();
