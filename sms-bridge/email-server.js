/**
 * ─────────────────────────────────────────────────────────────
 *  MyHome Connect — Email Bridge Server
 *
 *  Uses imapflow (pure JS, no native deps — works on Railway)
 *  + nodemailer for SMTP sending
 *
 *  Deploy to Railway / Render: see DEPLOY.md
 *  Run locally: node email-server.js
 * ─────────────────────────────────────────────────────────────
 */

// Works on Railway (npm install) and locally (C:\PalawanSMS)
function loadModule(name) {
  try { return require(name); } catch (e) {}
  try { return require('C:\\PalawanSMS\\node_modules\\' + name); } catch (e) {}
  console.error('Missing: ' + name + ' — run: npm install');
  process.exit(1);
}

const express    = loadModule('express');
const cors       = loadModule('cors');
const nodemailer = loadModule('nodemailer');
const { ImapFlow } = loadModule('imapflow');
const { simpleParser } = loadModule('mailparser');
const fs   = require('fs');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || process.env.EMAIL_PORT || 3001;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// ── IN-MEMORY STORES ─────────────────────────────────────────
const sessions   = {};  // token → session
const imapTimers = {};  // token → intervalId

// ── USERS FILE ────────────────────────────────────────────────
const USERS_FILE    = path.join(__dirname, 'email-users.json');
const MESSAGES_FILE = path.join(__dirname, 'email-messages.json');

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { return []; }
}
function saveUsers(users) {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch (e) {}
  // Also persist to Redis if available
  if (redisClient) redisSet('emailUsers', JSON.stringify(users)).catch(function() {});
}

async function loadUsersFromStorage() {
  if (redisClient) {
    try {
      const data = await redisGet('emailUsers');
      if (data) return JSON.parse(data);
    } catch (e) {}
  }
  return loadUsers();
}

// Message store — persisted to disk so restarts don't lose history
// On Railway: use MESSAGES_FILE path (ephemeral but better than nothing)
// For true persistence: set REDIS_URL env var to an Upstash Redis URL
let messageStore = {};
let redisClient  = null;

async function initStorage() {
  // Try Redis first (Upstash free tier — set REDIS_URL in Railway env vars)
  if (process.env.REDIS_URL) {
    try {
      // Use fetch-based Redis (no native deps needed)
      console.log('[Store] Redis URL found — using Upstash for persistence');
      redisClient = { url: process.env.REDIS_URL };
      // Load existing messages from Redis
      const data = await redisGet('messageStore');
      if (data) {
        messageStore = JSON.parse(data);
        console.log('[Store] Loaded ' + Object.keys(messageStore).length + ' conversations from Redis');
      }
      return;
    } catch (e) {
      console.warn('[Store] Redis init failed:', e.message, '— falling back to file');
      redisClient = null;
    }
  }
  // Fall back to JSON file
  try {
    const data = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    messageStore = data || {};
    console.log('[Store] Loaded ' + Object.keys(messageStore).length + ' conversations from file');
  } catch (e) {
    messageStore = {};
  }
}

async function redisGet(key) {
  if (!redisClient) return null;
  try {
    const res  = await fetch(redisClient.url + '/get/' + encodeURIComponent(key), {
      headers: { Authorization: 'Bearer ' + (process.env.REDIS_TOKEN || '') },
    });
    const data = await res.json();
    return data.result || null;
  } catch (e) { return null; }
}

async function redisSet(key, value) {
  if (!redisClient) return;
  try {
    // Upstash REST API: POST /set/key/value  OR  pipeline
    // Use pipeline for large values
    await fetch(redisClient.url + '/pipeline', {
      method:  'POST',
      headers: {
        Authorization:  'Bearer ' + (process.env.REDIS_TOKEN || ''),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([['SET', key, value]]),
    });
  } catch (e) { /* silent */ }
}

function saveMessageStore() {
  if (redisClient) {
    redisSet('messageStore', JSON.stringify(messageStore)).catch(function() {});
  } else {
    try { fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messageStore)); } catch (e) {}
  }
}

// Auto-save every 30 seconds
setInterval(saveMessageStore, 30000);

// ── HELPERS ───────────────────────────────────────────────────
function generateToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getColor(name) {
  const p = ['#0e7c63','#8e44ad','#e67e22','#2980b9','#c0392b','#16a085','#d35400'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return p[Math.abs(h) % p.length];
}

function extractEmail(str) {
  const m = (str || '').match(/<([^>]+)>/);
  return m ? m[1] : (str || '').trim();
}

function buildSubject(convId, channelName) {
  if (convId.startsWith('dm-')) return '[DM:' + convId + '] Direct Message';
  if (convId.startsWith('ch-')) {
    const ch = channelName || convId.replace(/^ch-/, '');
    return '[CH:' + ch + '] #' + ch;
  }
  return '[DM:' + convId + '] Message';
}

function parseSubject(subject) {
  subject = subject || '';
  const dm = subject.match(/\[DM:([^\]]+)\]/);
  if (dm) return { type: 'dm', convId: dm[1] };
  const ch = subject.match(/\[CH:([^\]]+)\]/);
  if (ch) return { type: 'channel', convId: 'ch-' + ch[1] };
  return null;
}

function getEmailDefaults(domain) {
  const p = {
    'gmail.com':           { imap: 'imap.gmail.com',          smtp: 'smtp.gmail.com',          port: 587 },
    'yahoo.com':           { imap: 'imap.mail.yahoo.com',     smtp: 'smtp.mail.yahoo.com',     port: 587 },
    'outlook.com':         { imap: 'outlook.office365.com',   smtp: 'smtp.office365.com',      port: 587 },
    'hotmail.com':         { imap: 'outlook.office365.com',   smtp: 'smtp.office365.com',      port: 587 },
    'live.com':            { imap: 'outlook.office365.com',   smtp: 'smtp.office365.com',      port: 587 },
    'icloud.com':          { imap: 'imap.mail.me.com',        smtp: 'smtp.mail.me.com',        port: 587 },
    'palawanpawnshop.com': { imap: 'mail.palawanpawnshop.com',smtp: 'mail.palawanpawnshop.com',port: 587 },
  };
  return p[domain] || { imap: 'imap.' + domain, smtp: 'smtp.' + domain, port: 587 };
}

// ── IMAP: test connection using imapflow ──────────────────────
async function testImap(email, password, imapHost, imapPort) {
  const client = new ImapFlow({
    host:    imapHost,
    port:    imapPort || 993,
    secure:  true,
    auth:    { user: email, pass: password },
    logger:  false,
    tls:     { rejectUnauthorized: false },
  });
  await client.connect();
  await client.logout();
}

// ── IMAP: fetch unseen MHC messages ──────────────────────────
async function fetchNewMessages(sess) {
  const client = new ImapFlow({
    host:   sess.imapHost,
    port:   sess.imapPort || 993,
    secure: true,
    auth:   { user: sess.email, pass: sess.password },
    logger: false,
    tls:    { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Search for unseen messages with MHC subject tags
      const uids = await client.search({
        unseen: true,
        or: [
          { subject: '[DM:' },
          { subject: '[CH:' },
        ],
      });

      if (!uids || !uids.length) return;

      for await (const msg of client.fetch(uids, { source: true, flags: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          const subject = parsed.subject || '';
          const conv    = parseSubject(subject);
          if (!conv) continue;

          const fromAddr  = parsed.from && parsed.from.value && parsed.from.value[0]
            ? parsed.from.value[0].address : '';
          const fromName  = parsed.from && parsed.from.value && parsed.from.value[0]
            ? (parsed.from.value[0].name || fromAddr.split('@')[0]) : fromAddr;
          const rawText   = parsed.text || '';

          // Parse MHC metadata footer
          const metaMatch = rawText.match(/--mhc--\nfrom:([^\n]+)\nname:([^\n]+)\ncolor:([^\n]+)\nconv:([^\n]+)/);
          const senderEmail = metaMatch ? metaMatch[1].trim() : fromAddr;
          const senderName  = metaMatch ? metaMatch[2].trim() : fromName;
          const senderColor = metaMatch ? metaMatch[3].trim() : getColor(senderName);
          const convId      = metaMatch ? metaMatch[4].trim() : conv.convId;

          // Clean body
          const cleanText = rawText.replace(/--mhc--[\s\S]*$/, '').trim();

          // Parse quote
          const qm = rawText.match(/^> ([^:]+): (.+)\n\n/m);

          const msgId = 'imap-' + msg.uid + '-' + sess.email.replace(/[^a-z0-9]/gi, '').slice(0, 8);
          if (messageStore[convId] && messageStore[convId].find(m => m.id === msgId)) continue;

          const msgObj = {
            id:          msgId,
            from:        senderEmail,
            fromEmail:   senderEmail,   // explicit for client "mine" detection
            fromName:    senderName,
            fromColor:   senderColor,
            to:          [sess.email],
            convId:      convId,
            text:        cleanText,
            quoteText:   qm ? qm[2] : null,
            quoteSender: qm ? qm[1] : null,
            date:        (parsed.date || new Date()).toISOString(),
            received:    true,
          };

          if (!messageStore[convId]) messageStore[convId] = [];
          messageStore[convId].push(msgObj);
          if (messageStore[convId].length > 500) messageStore[convId].shift();
          saveMessageStore(); // persist immediately

          console.log('[IMAP] ' + senderName + ' → ' + convId + ': ' + cleanText.slice(0, 60));

          // Mark as seen
          await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
        } catch (parseErr) {
          console.warn('[IMAP] Parse error:', parseErr.message);
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    if (!e.message.includes('ECONNRESET') && !e.message.includes('closed')) {
      console.warn('[IMAP] ' + sess.email + ':', e.message);
    }
    try { await client.logout(); } catch (_) {}
  }
}

function startImapPoll(token) {
  if (imapTimers[token]) return;
  const poll = () => {
    const sess = sessions[token];
    if (!sess) { stopImapPoll(token); return; }
    fetchNewMessages(sess).catch(() => {});
  };
  poll(); // immediate
  imapTimers[token] = setInterval(poll, 8000); // every 8s
}

function stopImapPoll(token) {
  clearInterval(imapTimers[token]);
  delete imapTimers[token];
}

// ── AUTH: LOGIN ───────────────────────────────────────────────
app.post('/auth/login', async function(req, res) {
  const { email, password, imapHost, imapPort, smtpHost, smtpPort } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password required.' });

  const domain   = email.split('@')[1] || '';
  const defaults = getEmailDefaults(domain);
  const iHost    = imapHost || defaults.imap;
  const iPort    = parseInt(imapPort) || 993;
  const sHost    = smtpHost || defaults.smtp;
  const sPort    = parseInt(smtpPort) || defaults.port;

  // Test IMAP credentials
  try {
    await testImap(email, password, iHost, iPort);
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Login failed: ' + e.message });
  }

  const token       = generateToken();
  const displayName = email.split('@')[0];
  const color       = getColor(displayName);

  sessions[token] = {
    email, password, name: displayName, color,
    imapHost: iHost, imapPort: iPort,
    smtpHost: sHost, smtpPort: sPort,
    lastSeen: Date.now(),
  };

  // Register for user discovery
  const users    = loadUsers();
  const existing = users.findIndex(u => u.email === email);
  const record   = { email, name: displayName, color, lastSeen: new Date().toISOString() };
  if (existing >= 0) users[existing] = Object.assign(users[existing], record);
  else users.push(record);
  saveUsers(users);

  startImapPoll(token);

  res.json({ ok: true, token, user: { email, name: displayName, color, id: email } });
});

// ── AUTH: LOGOUT ──────────────────────────────────────────────
app.post('/auth/logout', function(req, res) {
  const token = req.headers['x-token'] || (req.body && req.body.token);
  if (token) { stopImapPoll(token); delete sessions[token]; }
  res.json({ ok: true });
});

// ── USERS ─────────────────────────────────────────────────────
app.get('/users', function(req, res) { res.json(loadUsers()); });

// ── MESSAGES: GET ─────────────────────────────────────────────
app.get('/messages/:convId', function(req, res) {
  const token = req.headers['x-token'];
  const sess  = sessions[token];
  if (!sess) {
    // Token expired (server restarted) — tell client to re-login
    return res.status(401).json({ ok: false, error: 'Session expired. Please refresh and log in again.', reauth: true });
  }
  const since = req.query.since || '';
  const msgs  = (messageStore[req.params.convId] || []).filter(function(m) {
    if (!since) return true;
    return m.date > since;
  });
  res.json(msgs);
});

// ── MESSAGES: FORCE SYNC (triggers immediate IMAP fetch) ──────
app.post('/messages/sync', async function(req, res) {
  const token = req.headers['x-token'];
  const sess  = sessions[token];
  if (!sess) return res.status(401).json({ ok: false, error: 'Not authenticated' });

  try {
    await fetchNewMessages(sess);
    const convId = req.body.convId;
    const msgs   = convId ? (messageStore[convId] || []) : [];
    res.json({ ok: true, count: msgs.length });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── MESSAGES: SEND ────────────────────────────────────────────
app.post('/messages/send', async function(req, res) {
  const token = req.headers['x-token'];
  const sess  = sessions[token];
  if (!sess) return res.status(401).json({ ok: false, error: 'Not authenticated' });

  const { convId, text, to, channelName, quoteText, quoteSender } = req.body;
  if (!text) return res.status(400).json({ ok: false, error: 'Message text required.' });

  const recipients = Array.isArray(to) ? to : (to ? [to] : []);
  let body = text;
  if (quoteText) body = '> ' + (quoteSender || '') + ': ' + quoteText + '\n\n' + body;
  const footer = '\n\n--mhc--\nfrom:' + sess.email + '\nname:' + sess.name +
                 '\ncolor:' + sess.color + '\nconv:' + convId;

  try {
    const transporter = nodemailer.createTransport({
      host: sess.smtpHost, port: sess.smtpPort,
      secure: false,
      auth: { user: sess.email, pass: sess.password },
      tls: { rejectUnauthorized: false },
    });
    await transporter.sendMail({
      from:    '"' + sess.name + '" <' + sess.email + '>',
      to:      recipients.join(', '),
      subject: buildSubject(convId, channelName),
      text:    body + footer,
    });

    const msgId  = 'sent-' + Date.now();
    const msgObj = {
      id: msgId, from: sess.email, fromName: sess.name, fromColor: sess.color,
      fromEmail: sess.email,   // explicit email field for client "mine" detection
      to: recipients, convId, text, quoteText: quoteText || null,
      quoteSender: quoteSender || null, date: new Date().toISOString(), sent: true,
    };
    if (!messageStore[convId]) messageStore[convId] = [];
    messageStore[convId].push(msgObj);
    if (messageStore[convId].length > 500) messageStore[convId].shift();
    saveMessageStore(); // persist immediately

    res.json({ ok: true, id: msgId });
  } catch (e) {
    console.error('[SMTP]', e.message);
    res.status(500).json({ ok: false, error: 'Send failed: ' + e.message });
  }
});

// ── STATUS ────────────────────────────────────────────────────
app.get('/status', function(req, res) {
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    sessions: Object.keys(sessions).length,
    conversations: Object.keys(messageStore).length,
    messages: Object.values(messageStore).reduce((s, a) => s + a.length, 0),
  });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', async function() {
  await initStorage();
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  MyHome Connect — Email Bridge Server    ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Port    →  ' + PORT + '                          ║');
  console.log('║  Storage →  ' + (redisClient ? 'Redis (persistent)' : 'File (ephemeral)') + '         ║');
  console.log('║  Status  →  GET  /status                 ║');
  console.log('║  Login   →  POST /auth/login             ║');
  console.log('║  Send    →  POST /messages/send          ║');
  console.log('║  Poll    →  GET  /messages/:convId       ║');
  console.log('╚══════════════════════════════════════════╝\n');
});
