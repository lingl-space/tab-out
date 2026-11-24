/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by site, excluding navigation homepages
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';

/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];
let tabFetchVersion = 0;

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  const version = ++tabFetchVersion;
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    if (version !== tabFetchVersion) return;
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      lastAccessed: t.lastAccessed,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    if (version === tabFetchVersion) openTabs = [];
  }
}

/** Close only the selected IDs that still exist, across all windows. */
async function closeTabsByIds(tabIds) {
  const targets = new Set(tabIds);
  const tabs = await chrome.tabs.query({});
  const ids = tabs.filter(tab => targets.has(tab.id)).map(tab => tab.id);
  if (ids.length > 0) await chrome.tabs.remove(ids);
  await fetchOpenTabs();
}

/** Activate this exact tab, never a different page on the same domain. */
async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // legacy IDs retained; new items use UUIDs
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  await updateSavedTabs({ action: 'save', tab });
}

// All pages send writes to the background worker's shared queue.
async function updateSavedTabs(change) {
  const response = await chrome.runtime.sendMessage({ type: 'update-saved-tabs', ...change });
  if (!response.ok) throw new Error(response.error);
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [], pendingBookmarkExport } = await chrome.storage.local.get(['deferred', 'pendingBookmarkExport']);
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
    pendingBookmarkExport,
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  await updateSavedTabs({ action: 'complete', id });
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  await updateSavedTabs({ action: 'dismiss', id });
}

/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">标签页已清空</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 个标签页';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return '刚刚';
  if (diffMins < 60)  return diffMins + ' 分钟前';
  if (diffHours < 24) return diffHours + ' 小时前';
  if (diffDays === 1) return '昨天';
  return diffDays + ' 天前';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return '早上好';
  if (hour < 17) return '下午好';
  return '晚上好';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('zh-CN', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}

/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const NAV_ICONS = {
  "baidu": "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><text x=\"12\" y=\"12\" dy=\".35em\" text-anchor=\"middle\" fill=\"currentColor\" font-size=\"17\" font-family=\"system-ui, sans-serif\" font-weight=\"600\">百</text></svg>",
  "translate": "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><text x=\"12\" y=\"12\" dy=\".35em\" text-anchor=\"middle\" fill=\"currentColor\" font-size=\"17\" font-family=\"system-ui, sans-serif\" font-weight=\"600\">译</text></svg>",
  "qianwen": "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><text x=\"12\" y=\"12\" dy=\".35em\" text-anchor=\"middle\" fill=\"currentColor\" font-size=\"11\" font-family=\"system-ui, sans-serif\" font-weight=\"600\">千问</text></svg>",
  "github": "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><text x=\"12\" y=\"12\" dy=\".35em\" text-anchor=\"middle\" fill=\"currentColor\" font-size=\"11\" font-family=\"system-ui, sans-serif\" font-weight=\"600\">GH</text></svg>",
  "huggingface": "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><text x=\"12\" y=\"12\" dy=\".35em\" text-anchor=\"middle\" fill=\"currentColor\" font-size=\"11\" font-family=\"system-ui, sans-serif\" font-weight=\"600\">HF</text></svg>",
  "x": "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><text x=\"12\" y=\"12\" dy=\".35em\" text-anchor=\"middle\" fill=\"currentColor\" font-size=\"17\" font-family=\"system-ui, sans-serif\" font-weight=\"600\">X</text></svg>",
  "youtube": "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"2\" y=\"5\" width=\"20\" height=\"14\" rx=\"4\" fill=\"currentColor\"/><path d=\"m10 9 6 3-6 3V9Z\" fill=\"var(--card-bg)\"/></svg>"
};

function buildGroupId(key) {
  return 'domain-' + encodeURIComponent(key);
}

function getGroupPrimaryHostname(group) {
  return group.hostnames && group.hostnames.length > 0 ? group.hostnames[0] : group.domain;
}

function getGroupDisplayName(group) {
  if (group.domain === '__landing-pages__') return '导航主页';
  return group.displayName || friendlyDomain(getGroupPrimaryHostname(group));
}

function createGroup(groupMap, key, { domain, displayName, configured = false, siteId }) {
  if (!groupMap[key]) {
    groupMap[key] = {
      domain,
      displayName,
      configured,
      siteId,
      hostnames: [],
      tabs: [],
    };
  }
  return groupMap[key];
}

function addHostnameToGroup(group, hostname) {
  if (!hostname) return;
  if (!group.hostnames.includes(hostname)) group.hostnames.push(hostname);
}

function getGroupKey(hostname) {
  const site = findSite(hostname);
  return {
    key: site ? 'site/' + site.id : 'host/' + hostname,
    displayName: site ? site.name : friendlyDomain(hostname),
    configured: Boolean(site),
    siteId: site?.id,
  };
}

function findSite(hostname) {
  if (!hostname) return null;
  hostname = hostname.toLowerCase();
  const exact = SITES.find(site => site.hosts.includes(hostname));
  if (exact) return exact;
  return SITES.filter(site => site.includeSubdomains)
    .flatMap(site => site.hosts.map(host => ({ site, host })))
    .filter(({ host }) => hostname.endsWith('.' + host))
    .sort((a, b) => b.host.length - a.host.length)[0]?.site || null;
}

function isNavigationPage(url) {
  try {
    const parsed = new URL(url);
    const site = findSite(parsed.hostname);
    const navigation = site?.navigation;
    return Boolean(navigation
      && navigation.excludeHosts.includes(parsed.hostname)
      && navigation.excludePaths.includes(parsed.pathname));
  } catch {
    return false;
  }
}

function renderQuickNavigation() {
  const nav = document.getElementById('quickNav');
  if (!nav) return;
  nav.innerHTML = SITES.filter(site => site.navigation)
    .sort((a, b) => a.navigation.order - b.navigation.order)
    .map(site => {
      const { url, icon, label } = site.navigation;
      const name = label || site.name;
      return `<a class="quick-nav-item" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(name)}（新标签页打开）" title="${escapeHtml(name)}">${NAV_ICONS[icon]}</a>`;
    }).join('');
}

function friendlyDomain(hostname) {
  if (!hostname) return '';
  const site = findSite(hostname);
  if (site) return site.name;
  
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `@${username} 的帖子` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube 视频';
  }

  return title || url;
}

/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
  undo:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" /></svg>`,
};

/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];
const expandedGroups = new Set();

/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      url.length > 0 &&
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.visibility = 'visible';
  } else {
    banner.style.visibility = 'hidden';
  }
}

/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

// Escape dynamic text and quoted attributes before inserting HTML templates.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function buildOverflowChips(hiddenTabs, urlCounts = {}, expanded = false) {
  const hiddenChips = hiddenTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = parsed.port + ' ' + label;
    } catch {}
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = escapeHtml(tab.url);
    const safeTitle = escapeHtml(label);
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-id="${tab.id}" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${escapeHtml(faviconUrl)}" alt="">` : ''}
      <span class="chip-text">${safeTitle}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-id="${tab.id}" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="保存到待办清单">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-id="${tab.id}" data-tab-url="${safeUrl}" title="关闭此标签">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:${expanded ? 'contents' : 'none'}">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips"${expanded ? ' style="display:none"' : ''}>
      <span class="chip-text">展开其余 ${hiddenTabs.length} 项</span>
    </div>`;
}

/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderSiteTitleIcon(group) {
  const site = SITES.find(site => site.id === group.siteId);
  const label = site?.icon || Array.from(getGroupDisplayName(group)).slice(0, 2).join('');
  const icon = site?.navigation && NAV_ICONS[site.navigation.icon]
    || (site?.id === 'local-files' ? ICONS.archive :
      `<svg viewBox="0 0 24 24"><text x="12" y="12" dy=".35em" text-anchor="middle" fill="currentColor" font-size="${Array.from(label).length > 1 ? 11 : 17}" font-family="system-ui, sans-serif" font-weight="600">${escapeHtml(label)}</text></svg>`);
  return `<span class="site-title-icon" aria-hidden="true">${icon}</span>`;
}

function renderDomainCard(group, { embedded = false } = {}) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const stableId  = buildGroupId(group.domain);

  // Count duplicates (exact URL match)
  const urlCounts = Object.create(null);
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    标签总数：${tabCount}
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        重复标签：${totalExtras}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 5);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), getGroupPrimaryHostname(group));
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = escapeHtml(tab.url);
    const safeTitle = escapeHtml(label);
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-id="${tab.id}" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${escapeHtml(faviconUrl)}" alt="">` : ''}
      <span class="chip-text">${safeTitle}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-id="${tab.id}" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="保存到待办清单">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-id="${tab.id}" data-tab-url="${safeUrl}" title="关闭此标签">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(5), urlCounts, expandedGroups.has(stableId)) : '');

  if (embedded) {
    return `<section class="unconfigured-site-section" data-domain-id="${escapeHtml(stableId)}">
      <div class="unconfigured-site-host">${renderSiteTitleIcon(group)}${escapeHtml(getGroupPrimaryHostname(group))}</div>
      <div class="mission-pages">${pageChips}</div>
    </section>`;
  }

  let dedupHtml = '';
  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    dedupHtml = `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}" style="font-size:10px; padding:2px 8px; margin-left: 8px;">
        清理重复项
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${escapeHtml(stableId)}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${renderSiteTitleIcon(group)}${escapeHtml(getGroupDisplayName(group))}</span>
          <div style="margin-left: auto; display: flex; align-items: center;">
            <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${escapeHtml(stableId)}" style="font-size:10px; padding:2px 8px;">
              ${ICONS.close} 关闭全部标签
            </button>
            ${dedupHtml}
          </div>
        </div>
        <div class="mission-badges">
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
      </div>
    </div>`;
}

/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
let deferredRenderPromise = null;
let deferredRenderPending = false;

function renderDeferredColumn() {
  deferredRenderPending = true;
  if (!deferredRenderPromise) {
    deferredRenderPromise = (async () => {
      try {
        do {
          deferredRenderPending = false;
          await renderDeferredColumnContent();
        } while (deferredRenderPending);
      } finally {
        deferredRenderPromise = null;
      }
    })();
  }
  return deferredRenderPromise;
}

async function renderDeferredColumnContent() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const cacheButton    = document.getElementById('cacheTodos');

  if (!column) return;
  column.style.display = 'block';

  try {
    const { active, archived, pendingBookmarkExport } = await getSavedTabs();
    if (cacheButton) {
      cacheButton.disabled = !active.length || Boolean(pendingBookmarkExport);
      cacheButton.title = pendingBookmarkExport ? '缓存中，下载完成后自动归档' : '将全部待办的标题和链接导出为书签 HTML，下载完成后自动归档';
    }

    empty.textContent = '暂无待浏览内容，享受当下。';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} 项`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '0 项';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      renderArchiveList(archived);
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    if (cacheButton) {
      cacheButton.disabled = true;
      cacheButton.title = '待办加载失败，请刷新后重试';
    }
    list.style.display = 'none';
    archiveEl.style.display = 'none';
    countEl.textContent = '';
    empty.textContent = '待办加载失败，请刷新页面重试。';
    empty.style.display = 'block';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${escapeHtml(item.id)}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${escapeHtml(item.id)}">
      <div class="deferred-info">
        <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="deferred-title" title="${escapeHtml(item.title)}">
          <img src="${escapeHtml(faviconUrl)}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px">${escapeHtml(item.title || item.url)}
        </a>
        <div class="deferred-meta">
          <span>${escapeHtml(domain)}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${escapeHtml(item.id)}" title="不再提醒">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveList(archived) {
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  const q = (document.getElementById('archiveSearch')?.value || '').trim().toLowerCase();
  const results = q.length < 2 ? archived : archived.filter(item =>
    (item.title || '').toLowerCase().includes(q) ||
    (item.url || '').toLowerCase().includes(q)
  );
  archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
    || (q.length >= 2 ? '<div style="font-size:12px;color:var(--muted);padding:8px 0">没有找到匹配的标签</div>' : '');
}

function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="archive-item-title" title="${escapeHtml(item.title)}">
        ${escapeHtml(item.title || item.url)}
      </a>
      <span class="archive-item-date">${ago}</span>
      <button class="archive-item-dismiss" data-action="dismiss-archive-item" data-deferred-id="${escapeHtml(item.id)}" title="删除记录">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // Match sites and exclude navigation homepages from the shared configuration.
  domainGroups = [];
  const groupMap    = Object.create(null);

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isNavigationPage(tab.url)) {
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname.replace(/^www\./, '');
      }
      if (!hostname) continue;

      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = 'custom/' + customRule.groupKey;
        const group = createGroup(groupMap, key, {
          domain: key,
          displayName: customRule.groupLabel,
          configured: true,
        });
        addHostnameToGroup(group, hostname);
        group.tabs.push(tab);
        continue;
      }

      const groupInfo = getGroupKey(hostname);
      const group = createGroup(groupMap, groupInfo.key, {
        domain: groupInfo.key,
        displayName: groupInfo.displayName,
        configured: groupInfo.configured,
        siteId: groupInfo.siteId,
      });
      addHostnameToGroup(group, hostname);
      group.tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  domainGroups = Object.values(groupMap).sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    if (a.configured) {
      return getGroupDisplayName(a).localeCompare(getGroupDisplayName(b), 'zh-CN', { sensitivity: 'base', numeric: true })
        || a.domain.localeCompare(b.domain);
    }
    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = '活动标签概览';
    const configured = domainGroups.filter(group => group.configured);
    const unconfigured = domainGroups.filter(group => !group.configured);
    const cardCount = configured.length + (unconfigured.length ? 1 : 0);
    openTabsSectionCount.innerHTML = `标签组数量：${cardCount} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} 一键关闭所有标签</button>`;
    openTabsMissionsEl.innerHTML = `
      <div class="configured-sites">${configured.map(group => renderDomainCard(group)).join('')}</div>
      ${unconfigured.length ? `<div class="unconfigured-sites">
        <div class="mission-card unconfigured-card has-neutral-bar">
          <div class="mission-content">
            <div class="mission-top"><span class="mission-name"><span class="site-title-icon" aria-hidden="true">${ICONS.tabs}</span>其他站点</span></div>
            <div class="mission-badges"><span class="open-tabs-badge">${ICONS.tabs} 标签总数：${unconfigured.reduce((sum, group) => sum + group.tabs.length, 0)}</span></div>
            ${unconfigured.map(group => renderDomainCard(group, { embedded: true })).join('')}
          </div>
        </div>
      </div>` : ''}
    `;
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = getRealTabs().length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

let dashboardRefreshTimer = null;
let dashboardRendering = false;
let dashboardRefreshPending = false;

async function renderDashboard() {
  if (dashboardRendering) {
    dashboardRefreshPending = true;
    return;
  }

  dashboardRendering = true;
  try {
    do {
      dashboardRefreshPending = false;
      await renderStaticDashboard();
    } while (dashboardRefreshPending);
  } finally {
    dashboardRendering = false;
  }
}

function scheduleDashboardRefresh() {
  // Merge tab events arriving within 100ms into one refresh.
  clearTimeout(dashboardRefreshTimer);
  dashboardRefreshTimer = setTimeout(() => {
    dashboardRefreshTimer = null;
    return renderDashboard().catch(error => {
      console.warn('[tab-out] Refresh failed:', error);
      showToast('刷新失败，请重试');
    });
  }, 100);
}

/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

async function handleDashboardClick(e) {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  if (action === 'cache-todos') {
    if (actionEl.disabled) return;
    actionEl.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'export-todos' });
      if (!result.ok) throw new Error(result.error);
      showToast(result.count ? '书签下载已发起，完成后自动归档' : '暂无待办可缓存');
    } catch (error) {
      console.warn('[tab-out] Bookmark export failed:', error);
      showToast('缓存未完成，待办仍保留，请重试');
    } finally {
      await renderDeferredColumn();
    }
    return;
  }

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { checkTabOutDupes(); banner.style.opacity = '1'; }, 400);
    }
    showToast('已关闭多余的管理页');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const section = actionEl.closest('.unconfigured-site-section') || card;
    if (section) {
      expandedGroups.add(section.dataset.domainId);
    }
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    await focusTab(Number(actionEl.dataset.tabId));
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    await closeTabsByIds([Number(actionEl.dataset.tabId)]);

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = getRealTabs().length;

    showToast('已关闭标签');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('保存失败，请重试');
      return;
    }

    await closeTabsByIds([Number(actionEl.dataset.tabId)]);

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('已保存到待办');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    await renderDeferredColumn();
    return;
  }

  if (action === 'dismiss-deferred' || action === 'dismiss-archive-item') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;
    await dismissSavedTab(id);
    await renderDeferredColumn();
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => buildGroupId(g.domain) === domainId);
    if (!group || !group.configured) return;

    // Close only the tabs represented by this card, across all windows.
    const tabIds = group.tabs.map(t => t.id);
    await closeTabsByIds(tabIds);

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = getGroupDisplayName(group);
    showToast(`已关闭 ${groupLabel} 的全部标签`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = getRealTabs().length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    showToast('已关闭重复项');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    await closeTabsByIds(getRealTabs().map(tab => tab.id));
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('所有标签已清理');
    return;
  }
 
  // ---- Restore the most recently closed tab or window ----
  if (action === 'restore-tab') {
    try {
      const recentlyClosed = await chrome.sessions.getRecentlyClosed({ maxResults: 1 });
      if (recentlyClosed && recentlyClosed.length > 0) {
        const session = recentlyClosed[0];
        const sessionId = session.tab?.sessionId || session.window?.sessionId;
        if (!sessionId) {
          showToast('没有可恢复的标签或窗口');
          return;
        }
        await chrome.sessions.restore(sessionId);
        showToast(session.window ? '已恢复最近关闭的窗口' : '已恢复最近关闭的标签');
      } else {
        showToast('没有可恢复的标签或窗口');
      }
    } catch (err) {
      console.warn('[tab-out] Failed to restore session:', err);
      showToast('恢复失败');
    }
    return;
  }
}

document.addEventListener('click', e => {
  handleDashboardClick(e).catch(error => {
    console.warn('[tab-out] Action failed:', error);
    showToast('操作失败，请刷新后重试');
    scheduleDashboardRefresh();
  });
});

// Extension CSP disallows inline onerror handlers. Hide unavailable site icons.
document.addEventListener('error', e => {
  if (e.target.matches?.('img')) e.target.style.display = 'none';
}, true);

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  try {
    await renderDeferredColumn();
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});

/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
// ---- Real-time auto-refresh when tabs change ----
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && (changes.deferred || changes.pendingBookmarkExport)) {
    return renderDeferredColumn();
  }
});

chrome.tabs.onCreated.addListener(scheduleDashboardRefresh);
chrome.tabs.onRemoved.addListener(scheduleDashboardRefresh);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Only refresh when loading is complete or the user changes URL/Title
  if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.title) {
    scheduleDashboardRefresh();
  }
});

renderQuickNavigation();
renderDashboard();
