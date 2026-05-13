/**
 * ─────────────────────────────────────────────────────────────
 *  MyHome Connect — Email Bridge Server
 *
 *  Turns email into a messenger-style chat backend.
 *  - Sends messages via SMTP (nodemailer)
 *  - Reads messages via IMAP (imap-simple)
 *  - Web app polls this server every 3s for new messages
 *
 *  Deploy to Railway: https://railway.app (free tier)
 *  Or run locally: node email-server.js
 * ─────────────────────────────────────────────────────────────
 */

// Works both locally (C:\PalawanSMS) and on Railway/cloud (npm install)
function loadModule(name) {
  try { return require(name); } catch (e) {}
  try { return require('C:\\PalawanSMS\\node_modules\\' + name); } catch (e) {}
  console.error('Missing module: ' + name + '. Run: npm install');
  process.exit(1);
}

const express    = loadModule('express');
const cors       = loadModule('cors');
const nodemailer = loadModule('nodemailer');
const imapSimple = loadModule('imap-simple');
const fs         = require('fs');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || process.env.EMAIL_PORT || 3001;

// Allow requests from GitHub Pages, localhost, and any origin
app.use(cors({
  origin: function(origin, callback) { callback(null, true); },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── USER SESSIONS ─────────────────────────────────────────────
// { token: { email, name, color, imapConfig, smtpConfig, lastSeen } }
const sessions = {};

// ── MESSAGE STORE ─────────────────────────────────────────────
// { conversationId: [ { id, from, fromName, fromColor, to, subject, text, date, attachments } ] }
const messageStore = {};

// ── IMAP CONNECTIONS ──────────────────────────────────────────
// { token: imapConnection }
const imapConnections = {};

// ── USERS FILE (for user discovery) ──────────────────────────
const USERS_FILE = path.join(__dirname, 'email-users.json');
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { return []; }
}
function saveUsers(users) {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch (e) {}
}

// ── HELPERS ───────────────────────────────────────────────────
function generateToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getColor(name) {
  const palette = ['#0e7c63','#8e44ad','#e67e22','#2980b9','#c0392b','#16a085','#d35400'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
}

// Build a deterministic conversation ID for a DM between two emails
function dmConvId(emailA, emailB) {
  return 'dm-' + [emailA, emailB].sort().join('--').replace(/[@.]/g, '_');
}

// Build channel conversation ID
function channelConvId(channelName) {
  return 'ch-' + channelName.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

// Parse conversation ID from email subject
// Subject format: [DM:conv-id] or [CH:channel-name]
function parseSubject(subject) {
  subject = subject || '';
  var dmMatch = subject.match(/\[DM:([^\]]+)\]/);
  if (dmMatch) return { type: 'dm', convId: dmMatch[1] };
  var chMatch = subject.match(/\[CH:([^\]]+)\]/);
  if (chMatch) return { type: 'channel', convId: 'ch-' + chMatch[1], channelName: chMatch[1] };
  return null;
}

// Build email subject from conversation
function buildSubject(convId, displayName) {
  if (convId.startsWith('dm-')) return '[DM:' + convId + '] ' + (displayName || 'Direct Message');
  if (convId.startsWith('ch-')) {
    var chName = convId.replace(/^ch-/, '');
    return '[CH:' + chName + '] #' + chName;
  }
  return '[DM:' + convId + '] Message';
}

// ── AUTH: LOGIN ───────────────────────────────────────────────
app.post('/auth/login', async function(req, res) {
  var { email, password, name, imapHost, imapPort, smtpHost, smtpPort, secure } = req.body;

  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'Email and password required.' });
  }

  // Default IMAP/SMTP settings — auto-detect from email domain
  var domain = email.split('@')[1] || '';
  var defaults = getEmailDefaults(domain);
  imapHost = imapHost || defaults.imapHost;
  imapPort = imapPort || defaults.imapPort;
  smtpHost = smtpHost || defaults.smtpHost;
  smtpPort = smtpPort || defaults.smtpPort;
  secure   = secure !== undefined ? secure : defaults.secure;

  // Test IMAP connection
  var imapConfig = {
    imap: {
      user:     email,
      password: password,
      host:     imapHost,
      port:     imapPort,
      tls:      true,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 10000,
    }
  };

  try {
    var conn = await imapSimple.connect(imapConfig);
    await conn.end();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Login failed: ' + e.message });
  }

  var token = generateToken();
  var displayName = name || email.split('@')[0];
  var color = getColor(displayName);

  sessions[token] = {
    email, name: displayName, color,
    imapConfig,
    smtpConfig: { host: smtpHost, port: smtpPort, secure: !!secure, auth: { user: email, pass: password } },
    lastSeen: Date.now(),
  };

  // Register user for discovery
  var users = loadUsers();
  var existing = users.findIndex(u => u.email === email);
  var userRecord = { email, name: displayName, color, lastSeen: new Date().toISOString() };
  if (existing >= 0) users[existing] = Object.assign(users[existing], userRecord);
  else users.push(userRecord);
  saveUsers(users);

  // Start IMAP polling for this user
  startImapPoll(token);

  res.json({
    ok: true,
    token,
    user: { email, name: displayName, color, id: email },
  });
});

// ── AUTH: LOGOUT ──────────────────────────────────────────────
app.post('/auth/logout', function(req, res) {
  var token = req.headers['x-token'] || req.body.token;
  if (token) {
    stopImapPoll(token);
    delete sessions[token];
  }
  res.json({ ok: true });
});

// ── USERS: LIST ───────────────────────────────────────────────
app.get('/users', function(req, res) {
  res.json(loadUsers());
});

// ── CHANNELS: LIST ────────────────────────────────────────────
// Channels are stored locally — no server-side channel registry needed
// The web app manages its own channel list in localStorage
app.get('/channels', function(req, res) {
  var token = req.headers['x-token'];
  var sess  = sessions[token];
  if (!sess) return res.status(401).json({ ok: false, error: 'Not authenticated' });

  // Return all conversation IDs this user has messages in
  var convIds = Object.keys(messageStore).filter(function(id) {
    var msgs = messageStore[id] || [];
    return msgs.some(function(m) { return m.from === sess.email || (m.to || []).includes(sess.email); });
  });
  res.json(convIds);
});

// ── MESSAGES: GET ─────────────────────────────────────────────
app.get('/messages/:convId', function(req, res) {
  var token  = req.headers['x-token'];
  var sess   = sessions[token];
  if (!sess) return res.status(401).json({ ok: false, error: 'Not authenticated' });

  var convId = req.params.convId;
  var since  = req.query.since || '';
  var msgs   = (messageStore[convId] || []).filter(function(m) {
    if (since && m.date <= since) return false;
    return true;
  });
  res.json(msgs);
});

// ── MESSAGES: SEND ────────────────────────────────────────────
app.post('/messages/send', async function(req, res) {
  var token  = req.headers['x-token'];
  var sess   = sessions[token];
  if (!sess) return res.status(401).json({ ok: false, error: 'Not authenticated' });

  var { convId, text, to, channelName, quoteText, quoteSender } = req.body;
  if (!text && !req.body.attachmentData) {
    return res.status(400).json({ ok: false, error: 'Message text required.' });
  }

  // Build recipient list
  var recipients = [];
  if (to && Array.isArray(to)) {
    recipients = to;
  } else if (to) {
    recipients = [to];
  }

  // Build email body — include quote if present
  var body = text || '';
  if (quoteText) {
    body = '> ' + (quoteSender || '') + ': ' + quoteText + '\n\n' + body;
  }

  // Add metadata footer for parsing
  var metaFooter = '\n\n--mhc--\nfrom:' + sess.email + '\nname:' + sess.name +
                   '\ncolor:' + sess.color + '\nconv:' + convId;

  var subject = buildSubject(convId, channelName);

  try {
    var transporter = nodemailer.createTransport(sess.smtpConfig);
    await transporter.sendMail({
      from:    '"' + sess.name + '" <' + sess.email + '>',
      to:      recipients.join(', '),
      subject: subject,
      text:    body + metaFooter,
    });

    // Store in local message store immediately (optimistic)
    var msgId = 'sent-' + Date.now();
    var msgObj = {
      id:          msgId,
      from:        sess.email,
      fromName:    sess.name,
      fromColor:   sess.color,
      to:          recipients,
      convId:      convId,
      channelName: channelName || null,
      text:        text,
      quoteText:   quoteText || null,
      quoteSender: quoteSender || null,
      date:        new Date().toISOString(),
      sent:        true,
    };
    if (!messageStore[convId]) messageStore[convId] = [];
    messageStore[convId].push(msgObj);
    // Keep last 500
    if (messageStore[convId].length > 500) messageStore[convId].shift();

    res.json({ ok: true, id: msgId });
  } catch (e) {
    console.error('[SMTP] Send failed:', e.message);
    res.status(500).json({ ok: false, error: 'Send failed: ' + e.message });
  }
});

// ── IMAP POLLING ──────────────────────────────────────────────
var imapPollTimers = {};
var imapLastUid   = {}; // { token: lastSeenUID }

function startImapPoll(token) {
  if (imapPollTimers[token]) return;
  imapPollTimers[token] = setInterval(function() { pollImap(token); }, 5000);
  pollImap(token); // immediate first poll
}

function stopImapPoll(token) {
  clearInterval(imapPollTimers[token]);
  delete imapPollTimers[token];
  delete imapLastUid[token];
}

async function pollImap(token) {
  var sess = sessions[token];
  if (!sess) { stopImapPoll(token); return; }

  try {
    var conn = await imapSimple.connect(sess.imapConfig);
    await conn.openBox('INBOX');

    // Search for unread messages with our subject tags
    var searchCriteria = ['UNSEEN', ['OR',
      ['SUBJECT', '[DM:'],
      ['SUBJECT', '[CH:']
    ]];

    var fetchOptions = {
      bodies:   ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT'],
      markSeen: true,
      struct:   true,
    };

    var messages = await conn.search(searchCriteria, fetchOptions);

    messages.forEach(function(msg) {
      try {
        var header = msg.parts.find(p => p.which === 'HEADER.FIELDS (FROM TO SUBJECT DATE)');
        var body   = msg.parts.find(p => p.which === 'TEXT');
        if (!header || !body) return;

        var h       = header.body;
        var from    = (h.from    && h.from[0])    || '';
        var to      = (h.to      && h.to[0])      || '';
        var subject = (h.subject && h.subject[0]) || '';
        var date    = (h.date    && h.date[0])    || new Date().toISOString();
        var rawText = body.body || '';

        // Parse metadata footer
        var metaMatch = rawText.match(/--mhc--\nfrom:([^\n]+)\nname:([^\n]+)\ncolor:([^\n]+)\nconv:([^\n]+)/);
        var fromEmail = metaMatch ? metaMatch[1].trim() : extractEmail(from);
        var fromName  = metaMatch ? metaMatch[2].trim() : (from.split('<')[0].trim() || fromEmail);
        var fromColor = metaMatch ? metaMatch[3].trim() : getColor(fromName);
        var convId    = metaMatch ? metaMatch[4].trim() : null;

        // Clean text — remove metadata footer and quoted lines
        var cleanText = rawText
          .replace(/--mhc--[\s\S]*$/, '')
          .replace(/^> .+\n\n/m, '')  // remove quote block
          .trim();

        // Parse quote if present
        var quoteMatch = rawText.match(/^> ([^:]+): (.+)\n\n/m);
        var quoteSender = quoteMatch ? quoteMatch[1] : null;
        var quoteText   = quoteMatch ? quoteMatch[2] : null;

        // Determine convId from subject if not in footer
        if (!convId) {
          var parsed = parseSubject(subject);
          if (parsed) convId = parsed.convId;
          else return; // not a MyHome Connect message
        }

        var msgId = 'imap-' + msg.attributes.uid + '-' + token.slice(0, 6);

        // Skip if already stored
        if (messageStore[convId] && messageStore[convId].find(m => m.id === msgId)) return;

        var msgObj = {
          id:          msgId,
          from:        fromEmail,
          fromName:    fromName,
          fromColor:   fromColor,
          to:          [sess.email],
          convId:      convId,
          text:        cleanText,
          quoteText:   quoteText,
          quoteSender: quoteSender,
          date:        new Date(date).toISOString(),
          received:    true,
        };

        if (!messageStore[convId]) messageStore[convId] = [];
        messageStore[convId].push(msgObj);
        if (messageStore[convId].length > 500) messageStore[convId].shift();

        console.log('[IMAP] New message in ' + convId + ' from ' + fromName);
      } catch (e) {
        console.warn('[IMAP] Parse error:', e.message);
      }
    });

    await conn.end();
  } catch (e) {
    // IMAP error — silent, will retry next poll
    if (e.message && !e.message.includes('ECONNRESET')) {
      console.warn('[IMAP] Poll error for ' + (sess ? sess.email : token) + ':', e.message);
    }
  }
}

// ── EMAIL DOMAIN DEFAULTS ─────────────────────────────────────
function getEmailDefaults(domain) {
  var presets = {
    'gmail.com':     { imapHost: 'imap.gmail.com',     imapPort: 993, smtpHost: 'smtp.gmail.com',     smtpPort: 587, secure: false },
    'yahoo.com':     { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 587, secure: false },
    'outlook.com':   { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587, secure: false },
    'hotmail.com':   { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587, secure: false },
    'live.com':      { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587, secure: false },
    'icloud.com':    { imapHost: 'imap.mail.me.com',   imapPort: 993, smtpHost: 'smtp.mail.me.com',   smtpPort: 587, secure: false },
    'palawanpawnshop.com': { imapHost: 'mail.palawanpawnshop.com', imapPort: 993, smtpHost: 'mail.palawanpawnshop.com', smtpPort: 587, secure: false },
  };
  return presets[domain] || { imapHost: 'imap.' + domain, imapPort: 993, smtpHost: 'smtp.' + domain, smtpPort: 587, secure: false };
}

function extractEmail(str) {
  var m = str.match(/<([^>]+)>/);
  return m ? m[1] : str.trim();
}

// ── STATUS ────────────────────────────────────────────────────
app.get('/status', function(req, res) {
  res.json({
    ok:           true,
    uptime:       Math.floor(process.uptime()),
    activeSessions: Object.keys(sessions).length,
    conversations:  Object.keys(messageStore).length,
    totalMessages:  Object.values(messageStore).reduce((s, a) => s + a.length, 0),
  });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', function() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  MyHome Connect — Email Bridge Server    ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Running on  →  http://localhost:' + PORT + '     ║');
  console.log('║  Auth        →  POST /auth/login         ║');
  console.log('║  Send        →  POST /messages/send      ║');
  console.log('║  Poll        →  GET  /messages/:convId   ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('  Supported email providers:');
  console.log('  Gmail, Outlook, Yahoo, iCloud, custom IMAP/SMTP');
  console.log('');
});
