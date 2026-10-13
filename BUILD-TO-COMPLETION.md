# Email Toolkit: the remaining build

This is your write-it-yourself implementation guide. Code below is reference code
to type into the named files; it has **not** been installed into your extension.
Keep the working sender/rule UI. Complete the checkpoints in order.

Guide verification, 7 October 2026: all six JavaScript listings passed Node syntax
checks after extraction to a temporary directory. The included API test passed
against a temporary SQLite database: token/origin rejection, duplicate prevention,
field limits, application linking and transactional status history. The extension
worker, Gmail DOM reader, native notifications and tracker UI have not been run in
Edge. Those require the manual acceptance checklist below.

The target is a small local MVP: read an explicitly opened Gmail message, apply
saved rules, queue matches, save them to SQLite, notify, and manually link them
to applications with an editable status history. No paid services or packages.

## 0. Boundaries and architecture

```text
Gmail content script -> extension service worker -> local Node API -> SQLite
                              ^                         ^
                           popup                 tracking page
```

- The reader inspects loaded, expanded messages. It does not crawl unopened
  emails, bypass Gmail, or monitor Gmail after its tab closes.
- Exactly one expanded message is required for this first reader. When several
  are expanded, collapse the others. This avoids ambiguous selection.
- Monitoring is explicitly enabled for one Gmail tab and one account label.
  It ends when the tab closes or the browser session ends. Re-enable it after a
  browser restart. It scans newly displayed content, not the whole mailbox.
- Application statuses are manually confirmed. A subject containing
  "application" is not proof that you applied, got an interview, or were hired.
- Node runs on `127.0.0.1:4318`. Never bind it to `0.0.0.0` for this project.
- Use Node 22.5+ with `--experimental-sqlite` for compatibility with your existing
  Node 22.12 installation. The built-in SQLite API is experimental on that line.
  No `npm install` is needed.

Create a branch/commit checkpoint first. Add these entries to `.gitignore`:

```gitignore
API/data/
*.pem
*.crx
```

Do not commit database files or pairing tokens. The token is a local connection
secret, not a Gmail password.

## 1. Replace `Extension/manifest.json`

We use a declared Gmail content script for monitoring, so `scripting` is no longer
needed. `activeTab` lets the popup identify the tab on which you invoked it.

```json
{
  "manifest_version": 3,
  "name": "Email Toolkit",
  "version": "0.2.0",
  "description": "Local email rules and application tracking.",
  "permissions": ["storage", "activeTab", "notifications", "alarms"],
  "host_permissions": ["https://mail.google.com/*", "http://127.0.0.1:4318/*"],
  "background": { "service_worker": "JS/background.js" },
  "content_scripts": [{
    "matches": ["https://mail.google.com/*"],
    "js": ["JS/gmail-reader.js"],
    "run_at": "document_idle"
  }],
  "action": { "default_popup": "index.html", "default_title": "Email Toolkit" }
}
```

Don't reload yet: write the files referenced by this manifest first.

## 2. Create `Extension/JS/gmail-reader.js`

**Selectors below are provisional, not verified against your current Gmail.**
Gmail's `data-legacy-message-id`, `.adn`, `.a3s`, `h2.hP` and `span[email]`
are implementation details. Stop at the checkpoint if they do not work; do not
replace a missing message ID with the subject or sender (different emails can
have identical values).

```js
(() => {
  const visible = (node) => node && node.getClientRects().length > 0;

  function readOpenedEmail() {
    const main = [...document.querySelectorAll('[role="main"]')].find(visible);
    if (!main) throw new Error("Gmail is still loading or its layout is unsupported.");
    const cards = [...main.querySelectorAll('.adn[data-legacy-message-id]')]
      .filter((card) => visible(card) && visible(card.querySelector('.a3s')));
    if (cards.length !== 1) {
      throw new Error("Open one email and leave exactly one message expanded.");
    }
    const card = cards[0];
    // Read the header only, never a sender-looking address inside quoted body text.
    const header = card.querySelector('.gE');
    const from = header?.querySelector('span[email]')?.getAttribute('email');
    const subjectNode = [...main.querySelectorAll('h2.hP')].find(visible);
    const messageId = card.getAttribute('data-legacy-message-id');
    if (!from || !subjectNode || !messageId) {
      throw new Error("Could not identify sender, subject and message ID safely.");
    }
    return { from: from.trim(), subject: subjectNode.textContent.trim(), messageId };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'READ_OPEN_EMAIL') return;
    try { respond({ ok: true, email: readOpenedEmail() }); }
    catch (error) { respond({ ok: false, error: error.message }); }
  });

  // Only attempt automatic extraction when this tab is explicitly enabled.
  let running = false;
  let lastAttempt = 0;
  async function scanIfEnabled() {
    if (running || document.hidden || Date.now() - lastAttempt < 2000) return;
    running = true;
    lastAttempt = Date.now();
    try {
      const state = await chrome.runtime.sendMessage({ type: 'MONITOR_STATE' });
      if (!state?.ok || !state.enabled) return;
      const email = readOpenedEmail();
      const response = await chrome.runtime.sendMessage({ type: 'CANDIDATE', email });
      if (!response?.ok) console.warn('Email Toolkit:', response?.error);
    } catch {
      // Ambiguous views and extension reloads must not break Gmail.
    } finally { running = false; }
  }
  let timer;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(scanIfEnabled, 800);
  }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(scanIfEnabled, 10000);
})();
```

Checkpoint after the next two files are installed: manually compare extracted
sender/subject against a harmless test email. Also test the inbox and a thread
with two expanded messages: they should produce a clear error, not a guess.

## 3. Create `API/server.mjs`

This is a complete small server. The token and extension ID are supplied at
startup. It checks the browser origin, Host header, bearer token, body size,
field types and lengths. SQL values use placeholders. Status changes and their
history records are committed together.

```js
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const statuses = ['unreviewed', 'applied', 'interview', 'offer', 'rejected', 'withdrawn'];
const token = process.env.TOOLKIT_TOKEN;
const extensionId = process.env.TOOLKIT_EXTENSION_ID;
if (!token || !/^[a-f0-9]{64}$/.test(token) || !/^[a-p]{32}$/.test(extensionId ?? '')) {
  throw new Error('Set TOOLKIT_TOKEN (64 hex characters) and TOOLKIT_EXTENSION_ID.');
}
const origin = `chrome-extension://${extensionId}`;
const directory = new URL('./data/', import.meta.url);
mkdirSync(directory, { recursive: true });
const db = new DatabaseSync(fileURLToPath(new URL('toolkit.sqlite', directory)));
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY, company TEXT NOT NULL, title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unreviewed', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, account TEXT NOT NULL, message_id TEXT NOT NULL,
    sender TEXT NOT NULL, subject TEXT NOT NULL, captured_at TEXT NOT NULL,
    application_id INTEGER REFERENCES applications(id),
    UNIQUE(account, message_id)
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id),
    status TEXT NOT NULL, created_at TEXT NOT NULL
  );
  PRAGMA user_version = 1;
`);

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
function text(value, max, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('Invalid text field.');
  }
  const result = value.trim();
  if (!allowEmpty && !result) fail('Required text field is empty.');
  return result;
}
function address(value) {
  const result = text(value, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail('Invalid email address.');
  return result;
}
function id(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) fail('Invalid ID.');
  return result;
}
async function body(request) {
  if (request.headers['content-type'] !== 'application/json') fail('JSON required.', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) fail('Request too large.', 413);
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Invalid JSON.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('Object required.');
  return result;
}
function transaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function authorised(header) {
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(header ?? '');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

const server = http.createServer(async (request, response) => {
  function send(status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  }
  try {
    if (request.headers.host !== '127.0.0.1:4318') fail('Invalid host.', 403);
    // Some extension GET requests omit Origin. Token authentication is always required.
    if (request.headers.origin && request.headers.origin !== origin) fail('Origin denied.', 403);
    if (request.headers.origin === origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      if (request.headers.origin !== origin) fail('Origin denied.', 403);
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.writeHead(204); response.end(); return;
    }
    if (!authorised(request.headers.authorization)) fail('Pairing token rejected.', 401);
    const url = new URL(request.url, 'http://127.0.0.1:4318');
    const route = url.pathname;
    if (request.method === 'GET' && route === '/state') {
      const before = url.searchParams.has('before') ? id(url.searchParams.get('before')) : Number.MAX_SAFE_INTEGER;
      const messages = db.prepare('SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT 100').all(before);
      send(200, {
        messages,
        nextBefore: messages.length === 100 ? messages.at(-1).id : null,
        applications: db.prepare('SELECT * FROM applications ORDER BY id DESC').all(),
        events: db.prepare('SELECT * FROM events ORDER BY id DESC').all()
      }); return;
    }
    if (request.method === 'POST' && route === '/messages') {
      const input = await body(request);
      const account = address(input.account);
      const from = address(input.from);
      const messageId = text(input.messageId, 200);
      if (!/^[A-Za-z0-9:_-]+$/.test(messageId)) fail('Invalid message ID.');
      const subject = text(input.subject, 1000, true);
      const result = db.prepare(`INSERT INTO messages(account,message_id,sender,subject,captured_at)
        VALUES(?,?,?,?,?) ON CONFLICT(account,message_id) DO NOTHING`)
        .run(account, messageId, from, subject, new Date().toISOString());
      send(200, { created: Number(result.changes) === 1 }); return;
    }
    if (request.method === 'POST' && route === '/applications') {
      const input = await body(request);
      const company = text(input.company, 200);
      const title = text(input.title, 200);
      const now = new Date().toISOString();
      const applicationId = transaction(() => {
        const result = db.prepare('INSERT INTO applications(company,title,created_at) VALUES(?,?,?)').run(company,title,now);
        const newId = Number(result.lastInsertRowid);
        db.prepare('INSERT INTO events(application_id,status,created_at) VALUES(?,?,?)').run(newId,'unreviewed',now);
        return newId;
      });
      send(201, { id: applicationId }); return;
    }
    const applicationRoute = route.match(/^\/applications\/(\d+)$/);
    if (request.method === 'PATCH' && applicationRoute) {
      const input = await body(request);
      if (!statuses.includes(input.status)) fail('Invalid application status.');
      transaction(() => {
        const applicationId = id(applicationRoute[1]);
        const current = db.prepare('SELECT status FROM applications WHERE id=?').get(applicationId);
        if (!current) fail('Application not found.', 404);
        if (current.status === input.status) return;
        db.prepare('UPDATE applications SET status=? WHERE id=?').run(input.status,applicationId);
        db.prepare('INSERT INTO events(application_id,status,created_at) VALUES(?,?,?)')
          .run(applicationId,input.status,new Date().toISOString());
      });
      send(200, { ok: true }); return;
    }
    const messageRoute = route.match(/^\/messages\/(\d+)$/);
    if (request.method === 'PATCH' && messageRoute) {
      const input = await body(request);
      const applicationId = input.applicationId === null ? null : id(input.applicationId);
      if (applicationId !== null && !db.prepare('SELECT id FROM applications WHERE id=?').get(applicationId)) {
        fail('Application not found.', 404);
      }
      const result = db.prepare('UPDATE messages SET application_id=? WHERE id=?').run(applicationId,id(messageRoute[1]));
      if (!Number(result.changes)) fail('Message not found.', 404);
      send(200, { ok: true }); return;
    }
    fail('Route not found.', 404);
  } catch (error) {
    send(error.status ?? 500, { error: error.status ? error.message : 'Local database operation failed.' });
  }
});
server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.listen(4318, '127.0.0.1', () => console.log('Email Toolkit API: http://127.0.0.1:4318'));
function shutdown() { server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

This has one schema version. Future schema changes need explicit migrations;
`CREATE TABLE IF NOT EXISTS` is not a migration mechanism.

## 4. Create `Extension/JS/background.js`

This worker is the only writer for the pending email queue. It revalidates
content-script data, checks the tab/account binding, and only saves rule matches.
It never accepts an arbitrary URL to fetch from the content script.

```js
importScripts('matching.js');
const API = 'http://127.0.0.1:4318';
let serial = Promise.resolve();
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
function enqueue(action) {
  const result = serial.then(() => storageReady).then(action);
  serial = result.catch(() => {});
  return result;
}
function gmailSlot(value) {
  const url = new URL(value);
  if (url.origin !== 'https://mail.google.com') throw new Error('Open Gmail first.');
  const slot = url.pathname.match(/^\/mail\/u\/(\d+)\//)?.[1];
  if (slot === undefined) throw new Error('Unsupported Gmail account URL.');
  return slot;
}
function validAddress(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
async function binding(tab) {
  const key = `tab:${tab.id}`;
  const config = (await chrome.storage.session.get(key))[key];
  if (!config || config.slot !== gmailSlot(tab.url)) throw new Error('Enable this Gmail tab and confirm its account first.');
  return config;
}
async function api(path, method = 'GET', value) {
  const { apiToken } = await chrome.storage.local.get('apiToken');
  if (!apiToken) throw new Error('Pair the local API first.');
  const response = await fetch(API + path, {
    method, headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
    signal: AbortSignal.timeout(5000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Local API request failed.');
  return result;
}
async function flush() {
  const { pending = [] } = await chrome.storage.local.get('pending');
  while (pending.length) {
    const result = await api('/messages', 'POST', pending[0]);
    pending.shift();
    await chrome.storage.local.set({ pending, lastSyncError: '' });
    if (result.created) {
      try {
        await chrome.notifications.create({ type: 'basic', iconUrl: 'icon.png',
          title: 'Email Toolkit', message: 'A matching email was saved locally.' });
      } catch { /* Saved data does not depend on OS notification settings. */ }
    }
  }
}
async function syncSafely() {
  try { await flush(); }
  catch (error) { await chrome.storage.local.set({ lastSyncError: error.message }); }
}
async function capture(email, tab) {
  const config = await binding(tab);
  if (!email || !validAddress(email.from) || typeof email.subject !== 'string' || email.subject.length > 1000 ||
      typeof email.messageId !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(email.messageId) ||
      /[\u0000-\u001f\u007f]/.test(email.subject)) throw new Error('Unsupported email fields. Nothing saved.');
  const { monitoredSenders = [], pending = [] } = await chrome.storage.local.get(['monitoredSenders','pending']);
  if (!Array.isArray(monitoredSenders)) throw new Error('Invalid saved rules.');
  const rules = monitoredSenders.map(record => typeof record === 'string'
    ? { email: record, subjectContains: '' } : record);
  if (rules.some(record => !record || !validAddress(record.email) || typeof record.subjectContains !== 'string' || record.subjectContains.length > 200)) {
    throw new Error('Invalid saved rules.');
  }
  const match = matchEmail(rules, email);
  if (!match.matched) return { matched: false, reason: match.reason, email };
  if (!pending.some(item => item.account === config.account && item.messageId === email.messageId)) {
    if (pending.length >= 100) throw new Error('Pending queue full. Start the API and sync, then scan again.');
    pending.push({ account: config.account, from: email.from, subject: email.subject, messageId: email.messageId });
    await chrome.storage.local.set({ pending });
  }
  await syncSafely();
  const state = await chrome.storage.local.get(['pending','lastSyncError']);
  return { matched: true, email, pending: state.pending?.length ?? 0, error: state.lastSyncError || '' };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  enqueue(async () => {
    if (sender.id !== chrome.runtime.id) throw new Error('Unknown caller.');
    if (sender.tab) {
      if (sender.frameId !== 0) throw new Error('Main frame required.');
      gmailSlot(sender.url);
      if (message?.type === 'MONITOR_STATE') {
        try { await binding(sender.tab); return { enabled: true }; }
        catch { return { enabled: false }; }
      }
      if (message?.type === 'CANDIDATE') return capture(message.email, sender.tab);
      throw new Error('Content script action not allowed.');
    }
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('Extension page required.');
    if (message?.type === 'PAIR') {
      if (!/^[a-f0-9]{64}$/.test(message.token ?? '')) throw new Error('Use the 64-character token from your API terminal.');
      await chrome.storage.local.set({ apiToken: message.token });
      return api('/state');
    }
    if (message?.type === 'ENABLE') {
      if (!validAddress(message.account)) throw new Error('Enter the Gmail account address for this tab.');
      const tab = await chrome.tabs.get(message.tabId);
      await chrome.storage.session.set({ [`tab:${tab.id}`]: { slot: gmailSlot(tab.url), account: message.account.toLowerCase() } });
      return { enabled: true };
    }
    if (message?.type === 'DISABLE') {
      await chrome.storage.session.remove(`tab:${message.tabId}`); return {};
    }
    if (message?.type === 'SCAN') {
      const tab = await chrome.tabs.get(message.tabId);
      await binding(tab);
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'READ_OPEN_EMAIL' });
      if (!response?.ok) throw new Error(response?.error || 'Reload Gmail after reloading the extension.');
      return capture(response.email, tab);
    }
    if (message?.type === 'SYNC') { await syncSafely(); return chrome.storage.local.get(['pending','lastSyncError']); }
    if (message?.type === 'STATE') {
      const suffix = Number.isSafeInteger(message.before) && message.before > 0 ? `?before=${message.before}` : '';
      return api('/state' + suffix);
    }
    if (message?.type === 'CREATE_APPLICATION') return api('/applications', 'POST', {company:message.company,title:message.title});
    if (message?.type === 'STATUS' && Number.isSafeInteger(message.id) && message.id > 0) {
      return api(`/applications/${message.id}`, 'PATCH', {status:message.status});
    }
    if (message?.type === 'LINK' && Number.isSafeInteger(message.id) && message.id > 0) {
      return api(`/messages/${message.id}`, 'PATCH', {applicationId:message.applicationId});
    }
    throw new Error('Unknown action.');
  }).then(value => respond({ ok: true, ...value }), error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { chrome.storage.session.remove(`tab:${tabId}`); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'sync') enqueue(syncSafely);
});
function schedule() { chrome.alarms.create('sync', { periodInMinutes: 1 }); }
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
```

The durable queue survives worker restarts. SQLite's unique account/message key
handles retry after a successful insert whose response was lost. Notifications
are attempted only for new inserts; a crash after saving can miss a notification,
but repeated scans should not repeatedly alert. The notification is deliberately
generic so private subjects do not appear on the lock screen.

The first version may re-send an already stored visible message every ten
seconds. SQLite deduplicates it. Later, a bounded recent-ID cache can reduce
those calls without becoming the source of truth.

## 5. Create a notification icon

Save a small square PNG as `Extension/icon.png` (for example a black envelope on
white, exported from Paint). A real PNG is required; renaming an SVG is not a
conversion. This is a local asset, not a web URL. Missing icons must not prevent
email storage, but notifications may fail until the icon exists.

## 6. Connect the popup

In `Extension/index.html`, add this section inside `<main>`:

```html
<section aria-labelledby="connection-heading">
  <h2 id="connection-heading">Gmail connection</h2>
  <label for="account-address">Account open in this Gmail tab</label>
  <input id="account-address" type="email" maxlength="254" placeholder="you@gmail.com">
  <p>Confirm this is the account shown in Gmail. Enable again after changing accounts.</p>
  <button id="enable-monitor" type="button">Enable this tab</button>
  <button id="disable-monitor" type="button">Stop this tab</button>
  <button id="open-tracker" type="button">Open local tracker and pairing</button>
  <p id="capture-status" role="status" aria-atomic="true"></p>
</section>
```

Add `<script src="JS/capture-ui.js" defer></script>` **after** `popup.js`.
Delete only the old `scanButton.addEventListener("click", ...)` placeholder at
the top of `popup.js`. Keep its `scanButton` and `statusMessage` declarations.

Create `Extension/JS/capture-ui.js`:

```js
(() => {
  const output = document.querySelector('#capture-status');
  const controls = ['#scan-button','#enable-monitor','#disable-monitor'];
  let busy = false;
  async function call(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || 'Extension worker did not respond.');
    return result;
  }
  async function activeTab() {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.id || !tab.url || new URL(tab.url).origin !== 'https://mail.google.com') {
      throw new Error('Open Gmail in the active tab first.');
    }
    return tab.id;
  }
  async function perform(action) {
    if (busy) return;
    busy = true;
    controls.forEach(selector => { document.querySelector(selector).disabled = true; });
    try { await action(); }
    catch (error) { output.textContent = error.message; }
    finally {
      busy = false;
      // Respect the original sender storage loading/saving state.
      updateControls();
      document.querySelector('#enable-monitor').disabled = false;
      document.querySelector('#disable-monitor').disabled = false;
    }
  }
  document.querySelector('#enable-monitor').addEventListener('click', () => perform(async () => {
    const account = document.querySelector('#account-address').value.trim();
    await call({type:'ENABLE',tabId:await activeTab(),account});
    output.textContent = 'Enabled for this tab. Only opened, expanded messages can be read.';
  }));
  document.querySelector('#disable-monitor').addEventListener('click', () => perform(async () => {
    await call({type:'DISABLE',tabId:await activeTab()});
    output.textContent = 'Monitoring stopped for this tab.';
  }));
  document.querySelector('#scan-button').addEventListener('click', () => perform(async () => {
    output.textContent = 'Reading opened email…';
    const result = await call({type:'SCAN',tabId:await activeTab()});
    output.textContent = `${result.email.from} — ${result.email.subject || '(empty subject)'}\n` +
      (!result.matched ? `No match: ${result.reason}.` : result.pending
        ? `Matched; waiting to sync. ${result.error}` : 'Matched and stored locally (or already stored).');
  }));
  document.querySelector('#open-tracker').addEventListener('click', () => {
    chrome.tabs.create({url:chrome.runtime.getURL('tracker.html')});
  });
})();
```

Append to `styles.css`:

```css
#capture-status { white-space: pre-wrap; overflow-wrap: anywhere; }
#account-address { padding: 8px; width: 100%; font: inherit; }
```

## 7. Create `Extension/tracker.html`

This uses its own full-tab layout rather than the fixed-width popup stylesheet.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Email Toolkit — local tracker</title>
  <link rel="stylesheet" href="CSS/tracker.css">
  <script src="JS/tracker.js" defer></script>
</head>
<body>
  <h1>Local application tracker</h1>
  <p>Emails are evidence. Choose application statuses yourself.</p>
  <form id="pair-form">
    <label for="api-token">Local API pairing token</label>
    <input id="api-token" type="password" required pattern="[a-f0-9]{64}" autocomplete="off">
    <button>Pair</button>
  </form>
  <button id="refresh" type="button">Refresh</button>
  <button id="sync" type="button">Retry pending emails</button>
  <p id="tracker-status" role="status" aria-atomic="true"></p>
  <h2>Add an application</h2>
  <form id="application-form">
    <label for="company">Company</label><input id="company" required maxlength="200">
    <label for="job-title">Job title</label><input id="job-title" required maxlength="200">
    <button>Add application</button>
  </form>
  <h2>Applications and history</h2><div id="applications"></div>
  <h2>Saved matching emails</h2><div id="messages"></div>
  <button id="more" type="button" hidden>Older emails</button>
</body>
</html>
```

## 8. Create `Extension/CSS/tracker.css`

```css
:root { color-scheme: light; font: 15px/1.5 'Segoe UI', sans-serif; color: #202020; background: white; }
* { box-sizing: border-box; }
body { max-width: 1000px; margin: 0 auto; padding: 24px; }
form { display: grid; gap: 8px; margin-block: 16px; }
input, select, button { font: inherit; padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: white; color: inherit; max-width: 100%; }
button { cursor: pointer; }
button:disabled { cursor: default; color: #666; }
:focus-visible { outline: 2px solid black; outline-offset: 3px; }
article { border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin-block: 12px; overflow-wrap: anywhere; }
label { display: block; }
#tracker-status { white-space: pre-wrap; }
```

## 9. Create `Extension/JS/tracker.js`

```js
const output = document.querySelector('#tracker-status');
let before = null;
let busy = false;
async function call(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Worker unavailable.');
  return response;
}
function node(tag, text) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  return result;
}
async function act(action) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button,input,select').forEach(control => { control.disabled = true; });
  try { await action(); }
  catch (error) { output.textContent = error.message; }
  finally {
    busy = false;
    document.querySelectorAll('button,input,select').forEach(control => { control.disabled = false; });
  }
}
async function refresh(older = false) {
  const state = await call({type:'STATE',before:older ? before : undefined});
  const applications = document.querySelector('#applications');
  const messages = document.querySelector('#messages');
  applications.replaceChildren();
  if (!older) messages.replaceChildren();
  for (const app of state.applications) {
    const card = node('article');
    const label = node('label', 'Application status');
    const select = node('select');
    for (const status of ['unreviewed','applied','interview','offer','rejected','withdrawn']) {
      const option = node('option',status); option.value = status; select.append(option);
    }
    select.value = app.status;
    label.append(select);
    const save = node('button','Save status'); save.type = 'button';
    save.addEventListener('click', () => {
      const status = select.value;
      act(async () => { await call({type:'STATUS',id:app.id,status}); await refresh(); output.focus(); });
    });
    card.append(node('h3',`${app.company} — ${app.title}`),label,save);
    const history = node('ul');
    for (const event of state.events.filter(event => event.application_id === app.id)) {
      history.append(node('li',`${event.created_at}: ${event.status}`));
    }
    card.append(history); applications.append(card);
  }
  if (!state.applications.length) applications.append(node('p','No applications yet.'));
  for (const email of state.messages) {
    const card = node('article');
    const select = node('select');
    const empty = node('option','Unlinked'); empty.value = ''; select.append(empty);
    for (const app of state.applications) {
      const option = node('option',`${app.company} — ${app.title}`); option.value = String(app.id); select.append(option);
    }
    select.value = email.application_id === null ? '' : String(email.application_id);
    const label = node('label','Link to application'); label.append(select);
    const save = node('button','Save link'); save.type = 'button';
    save.addEventListener('click', () => {
      const applicationId = select.value ? Number(select.value) : null;
      act(async () => { await call({type:'LINK',id:email.id,applicationId}); await refresh(); output.focus(); });
    });
    card.append(node('h3',email.subject || '(empty subject)'),
      node('p',`${email.sender} → ${email.account}`),node('p',`Captured: ${email.captured_at}`),label,save);
    messages.append(card);
  }
  if (!older && !state.messages.length) messages.append(node('p','No matching emails saved yet.'));
  before = state.nextBefore;
  document.querySelector('#more').hidden = before === null;
  output.textContent = 'Loaded from the local database.';
}
output.tabIndex = -1;
document.querySelector('#pair-form').addEventListener('submit', event => {
  event.preventDefault();
  const token = document.querySelector('#api-token').value.trim();
  act(async () => { await call({type:'PAIR',token}); document.querySelector('#api-token').value = ''; await refresh(); });
});
document.querySelector('#application-form').addEventListener('submit', event => {
  event.preventDefault();
  const company = document.querySelector('#company').value.trim();
  const title = document.querySelector('#job-title').value.trim();
  act(async () => {
    await call({type:'CREATE_APPLICATION',company,title});
    event.target.reset(); await refresh(); document.querySelector('#company').focus();
  });
});
document.querySelector('#refresh').addEventListener('click', () => act(() => refresh()));
document.querySelector('#more').addEventListener('click', () => act(() => refresh(true)));
document.querySelector('#sync').addEventListener('click', () => act(async () => {
  const result = await call({type:'SYNC'}); await refresh();
  output.textContent = `Pending: ${result.pending?.length ?? 0}. ${result.lastSyncError || 'Sync complete.'}`;
}));
act(() => refresh());
```

## 10. Start and pair the API

After all files above exist, reload the extension and **refresh Gmail**. Existing
tabs do not automatically receive a newly declared content script.

Copy the extension ID from `edge://extensions`. In a PowerShell terminal at the
repository root, run:

```powershell
$env:TOOLKIT_EXTENSION_ID = 'paste-your-extension-id-here'
$env:TOOLKIT_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
Write-Output $env:TOOLKIT_TOKEN
node --experimental-sqlite API/server.mjs
```

Copy the printed token into the tracker's pairing form. The terminal stays open
while the server runs. Ctrl+C stops it. A new terminal/session token requires
pairing again; do not put the token in source code or commit it.

The tracker is an extension page, so it can talk to the worker. Opening its HTML
as a filesystem page will not work. Open it using the popup button.

Then: save a test sender rule, open a harmless Gmail test message, enter the
current account address, click Enable this tab, and click Scan page. Compare the
extracted values to Gmail before relying on automated capture.

## 11. CI and syntax checks

Update `.github/workflows/checks.yml`: use `actions/checkout@v5` and
`actions/setup-node@v5`, keeping `node-version: "22"`. Add these commands to the
existing syntax step:

```sh
node --check Extension/JS/gmail-reader.js
node --check Extension/JS/background.js
node --check Extension/JS/capture-ui.js
node --check Extension/JS/tracker.js
node --check API/server.mjs
```

Keep `node --test tests/toolkit.test.cjs`. Add the API smoke test below as a new
step. This uses Node's built-in test APIs and SQLite; no dependency installation.

## 12. Create `tests/api.test.mjs`

The test copies the server into a temporary directory so it never touches your
real database. Stop the real API before running: the test uses the same port.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('local API authentication, duplicate capture, linking and status history', async () => {
  const directory = await mkdtemp(join(tmpdir(),'toolkit-test-'));
  await copyFile(new URL('../API/server.mjs',import.meta.url),join(directory,'server.mjs'));
  const token = 'a'.repeat(64);
  const child = spawn(process.execPath,['--experimental-sqlite',join(directory,'server.mjs')], {
    env:{...process.env,TOOLKIT_TOKEN:token,TOOLKIT_EXTENSION_ID:'a'.repeat(32)},stdio:['ignore','pipe','pipe']
  });
  try {
    await new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(Error('API did not start; check port 4318.')),5000);
      child.stdout.once('data',() => { clearTimeout(timer); resolve(); });
      child.once('error',error => { clearTimeout(timer); reject(error); });
      child.once('exit',code => { clearTimeout(timer); reject(Error(`API exited: ${code}`)); });
    });
    async function request(route,method='GET',value,auth=token,origin) {
      const headers = {'Content-Type':'application/json',Authorization:`Bearer ${auth}`};
      if(origin) headers.Origin=origin;
      return fetch('http://127.0.0.1:4318'+route,{method,headers,body:value===undefined?undefined:JSON.stringify(value)});
    }
    assert.equal((await request('/state','GET',undefined,'wrong')).status,401);
    assert.equal((await request('/state','GET',undefined,token,'https://example.com')).status,403);
    const email={account:'me@example.com',from:'jobs@example.com',subject:'Application received',messageId:'abc123'};
    assert.equal((await (await request('/messages','POST',email)).json()).created,true);
    assert.equal((await (await request('/messages','POST',email)).json()).created,false);
    assert.equal((await request('/messages','POST',{...email,subject:'x'.repeat(1001)})).status,400);
    const app=await (await request('/applications','POST',{company:"Test ' Company",title:'Developer'})).json();
    assert.equal((await request('/messages/1','PATCH',{applicationId:app.id})).status,200);
    assert.equal((await request(`/applications/${app.id}`,'PATCH',{status:'interview'})).status,200);
    assert.equal((await request(`/applications/${app.id}`,'PATCH',{status:'interview'})).status,200);
    const state=await (await request('/state')).json();
    assert.equal(state.messages.length,1);
    assert.equal(state.messages[0].application_id,app.id);
    assert.equal(state.applications[0].status,'interview');
    assert.equal(state.events.length,2);
  } finally {
    if(child.exitCode===null && child.signalCode===null) {
      const exited=once(child,'exit');child.kill();await exited;
    }
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('toolkit-test-')) {
      throw new Error('Refusing cleanup outside the test temporary directory.');
    }
    await rm(directory,{recursive:true,force:true});
  }
});
```

Run `node --test tests/api.test.mjs`, then the existing suite. CI uses the same
command. These tests do not prove the Gmail selectors work or that OS
notifications are enabled.

## 13. End-to-end acceptance checklist

Do not mark the project complete until these pass in your Edge/Gmail setup:

| Test | Expected |
| --- | --- |
| Popup on another website | Scan refuses; no page content captured. |
| Gmail inbox / unloaded view | Clear extraction error, no guessed email. |
| One opened message | Sender/subject agree with Gmail. |
| Two expanded messages | Ask to leave one expanded. |
| Matching rule | Message appears in local tracker. |
| No matching rule | Nothing queued, stored or notified. |
| Rescan / two tabs displaying same message | One database record, no repeated successful-insert notification. |
| Same message ID under different account labels | Separate records (account must be confirmed correctly). |
| Stop tab monitoring | Automatic capture stops; manual scan requires enabling again. |
| Browser restart | Monitoring off until re-enabled; pending items remain. |
| API stopped | Match queues, visible pending/error state; retry succeeds after startup. |
| More than 100 pending items | Explicit queue-full error, no silent eviction; rescan after syncing. |
| Wrong pairing token | API denies access; pair with current token. |
| Notification permission disabled | Database still saves; no crash. |
| Edit application status | Status and dated history update together. |
| Link/unlink email | Correct application assignment persists. |
| More than 100 emails | Older emails button retrieves the next page. |
| Cancel / keyboard / long text | Focus usable, labels associated, no executable HTML. |

## 14. Known limitations to keep in the README

- Gmail DOM selectors need testing and maintenance. This guide cannot verify
  your live mailbox. If selectors fail, inspect a harmless test message's header
  in DevTools and adjust only the reader module; do not copy private bodies here.
- Monitoring reads opened expanded messages only. Full inbox discovery, unread
  detection, and mailbox-wide background polling are **not** implemented.
- The account label is user-confirmed, not extracted/authenticated. Logging out
  and replacing an account in the same Gmail `/u/0/` slot requires disabling and
  enabling the tab again. Wrong labels can misattribute records.
- Matching by address is not verification of sender authenticity.
- A permanently rejected pending record blocks queue flushing; keep the error
  visible and repair the data/validation deliberately. Do not silently drop it.
- SQLite and extension storage are local, not application-encrypted. Back up
  the database with the API stopped; never include it in Git.
- Notification delivery is best effort, not exactly-once. SQLite storage is
  idempotent through its unique key.
- Sender-rule editing still has the existing simultaneous-view overwrite limit.
- Application creation is not idempotent: if a response is lost, refresh before
  retrying to avoid creating the same application twice.
- The tracker is a basic manual workflow. Automatic status inference, export,
  delete/retention controls, unattended API startup, encrypted storage and full
  mailbox capture are future improvements, not implied completed features.

## 15. Final documentation and commits

Update README after your tests, not ahead of them. Document Node version, start
command, pairing, account confirmation, Gmail refresh, visible-message scope,
queue capacity, database path, backup instructions, and which tests you ran.
Suggested checkpoints:

1. `feat: read opened Gmail messages on demand`
2. `feat: store matching emails through a local SQLite API`
3. `feat: monitor enabled Gmail tabs and notify on new captures`
4. `feat: link emails to applications and track status history`
5. `test: verify API and document end-to-end setup`

## Official references

- [Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Extension messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [Node 22 SQLite API](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html)
- [Setup Node action](https://github.com/actions/setup-node)

The reference listings are a starting implementation for the scoped MVP, not a
claim that Gmail extraction or the completed extension has already been tested.
