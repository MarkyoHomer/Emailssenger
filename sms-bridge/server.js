/**
 * ─────────────────────────────────────────────────────────────
 *  Palawan Connect — SMS Bridge Server
 *  Supports three SMS transport methods (in priority order):
 *    1. WiFi  — SMS Gateway for Android app (wireless)
 *    2. ADB   — Android Debug Bridge over USB (no WiFi needed)
 *    3. Queue — messages stored locally, sent when transport available
 *
 *  Run: node server.js
 * ─────────────────────────────────────────────────────────────
 */

// Load modules from C:\PalawanSMS\node_modules (installed by setup.js / install.bat)
const MODULE_DIR = 'C:\\PalawanSMS\\node_modules';
const express = require(MODULE_DIR + '\\express');
const cors    = require(MODULE_DIR + '\\cors');
const https   = require('https');
const http    = require('http');
const path    = require('path');
const { exec, execSync } = require('child_process');

const app  = express();
const PORT = 3000;

// ── YOUR FIREBASE PROJECT ID ─────────────────────────────────
const PROJECT_ID    = 'pconnect-9e7db';
const FIRESTORE_URL = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents';

// Default channel for SMS messages
const DEFAULT_CHANNEL = 'general';

// ── SMS GATEWAY ANDROID APP CONFIG ───────────────────────────
// The "SMS Gateway for Android" app exposes a local REST API for sending SMS.
// Set the IP of the phone running the app (must be on same WiFi as this PC).
// You can find it in the app under: Menu → API → Local server address
// Example: 192.168.1.10
var SMS_GATEWAY_IP   = process.env.SMS_GATEWAY_IP   || '';   // set in .env or below
var SMS_GATEWAY_PORT = process.env.SMS_GATEWAY_PORT || '8080';
var SMS_GATEWAY_USER = process.env.SMS_GATEWAY_USER || 'sms';
var SMS_GATEWAY_PASS = process.env.SMS_GATEWAY_PASS || 'sms';

// ── MIDDLEWARE ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── SMS LOG (in-memory) ──────────────────────────────────────
const smsLog = [];

// ── LOCAL USER STORE — loaded from a JSON file, no Firebase needed ──
// The web app writes users to sms-bridge/users.json whenever someone logs in.
// This lets the SMS bridge authenticate and route messages without Firebase.
const fs   = require('fs');
const USERS_FILE = __dirname + '/users.json';

function loadLocalUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch (e) { console.warn('[Users] Could not load users.json:', e.message); }
  return [];
}

function saveLocalUsers(users) {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch (e) {}
}

var localUsers = loadLocalUsers();

// ── OTP STORE (in-memory, expires in 10 minutes) ─────────────
// { phone: { code, expiresAt } }
const otpStore = {};

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
}

function cleanPhone(phone) {
  // Normalize: strip spaces/dashes, ensure +63 prefix for PH numbers
  var p = String(phone || '').replace(/[\s\-().]/g, '');
  if (p.startsWith('09') && p.length === 11) p = '+63' + p.slice(1);
  if (p.startsWith('9')  && p.length === 10) p = '+63' + p;
  return p;
}

// ── SEND SMS VIA ANDROID GATEWAY APP ─────────────────────────
function sendSmsViaGateway(to, message) {
  return new Promise(function(resolve, reject) {
    if (!SMS_GATEWAY_IP) {
      return reject(new Error('SMS_GATEWAY_IP not configured. Set it in sms-bridge/.env'));
    }

    // SMS Gateway for Android local API: POST /message
    // Docs: https://docs.sms-gate.app/api/
    var body = JSON.stringify({ phoneNumber: to, message: message });
    var auth = Buffer.from(SMS_GATEWAY_USER + ':' + SMS_GATEWAY_PASS).toString('base64');

    var options = {
      hostname: SMS_GATEWAY_IP,
      port:     parseInt(SMS_GATEWAY_PORT),
      path:     '/message',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  'Basic ' + auth,
      },
    };

    var req = http.request(options, function(res) {
      var raw = '';
      res.on('data', function(c) { raw += c; });
      res.on('end', function() {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, response: raw });
        } else {
          reject(new Error('Gateway returned ' + res.statusCode + ': ' + raw));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(8000, function() { req.destroy(new Error('Gateway request timed out')); });
    req.write(body);
    req.end();
  });
}

// ── ADB SMS MODULE ───────────────────────────────────────────
// Reads SMS from a USB-connected Android phone via ADB.
// No app needed on the phone — just USB debugging enabled.
//
// SETUP:
//   1. On your Android phone: Settings → Developer Options → USB Debugging ON
//   2. Connect phone to PC via USB
//   3. Accept the "Allow USB debugging?" prompt on the phone
//   4. ADB is bundled with Android SDK Platform Tools — download from:
//      https://developer.android.com/tools/releases/platform-tools
//      Or set ADB_PATH in .env to point to your adb.exe
// ─────────────────────────────────────────────────────────────

var ADB_PATH    = process.env.ADB_PATH || 'adb';  // 'adb' if in PATH, else full path
var ADB_ENABLED = process.env.ADB_ENABLED !== 'false'; // set ADB_ENABLED=false in .env to disable
var adbAvailable = false;   // set to true after first successful adb check
var adbPollTimer = null;
var adbSeenIds   = new Set(); // track SMS IDs already processed

// Check if ADB is available and a device is connected
function checkAdb() {
  return new Promise(function(resolve) {
    exec('"' + ADB_PATH + '" devices', { timeout: 5000 }, function(err, stdout) {
      if (err) { resolve(false); return; }
      // Look for a connected device (not just "List of devices attached")
      var lines = stdout.trim().split('\n').slice(1);
      var connected = lines.some(function(l) {
        return l.trim() && l.indexOf('device') !== -1 && l.indexOf('offline') === -1;
      });
      resolve(connected);
    });
  });
}

// Read SMS inbox from phone via ADB content provider
// Returns array of { id, address, body, date }
function readSmsViaAdb(type) {
  // type: 'inbox' (received) or 'sent'
  type = type || 'inbox';
  return new Promise(function(resolve) {
    var cmd = '"' + ADB_PATH + '" shell content query --uri content://sms/' + type +
              ' --projection _id:address:body:date --sort "date DESC" --limit 30';
    exec(cmd, { timeout: 10000 }, function(err, stdout) {
      if (err || !stdout) { resolve([]); return; }
      var results = [];
      // ADB output format: "Row: 0 _id=123, address=+63917..., body=Hello, date=1234567890"
      var rows = stdout.trim().split(/\r?\nRow: /);
      rows.forEach(function(row) {
        if (!row.trim()) return;
        var id      = (row.match(/_id=(\d+)/)      || [])[1];
        var address = (row.match(/address=([^,\n]+)/) || [])[1];
        var body    = (row.match(/body=([^,\n][\s\S]*?)(?:, date=|$)/) || [])[1];
        var date    = (row.match(/date=(\d+)/)      || [])[1];
        if (id && address && body) {
          results.push({
            id:      id,
            address: (address || '').trim(),
            body:    (body    || '').trim(),
            date:    date ? new Date(parseInt(date)).toISOString() : new Date().toISOString(),
          });
        }
      });
      resolve(results);
    });
  });
}

// Send SMS via ADB using the phone's built-in SMS app
// Uses Android's am broadcast with SMS_SEND intent
function sendSmsViaAdb(to, message) {
  return new Promise(function(resolve, reject) {
    if (!adbAvailable) {
      return reject(new Error('ADB not available or no device connected'));
    }
    // Escape message for shell — replace quotes and newlines
    var safeMsg = message.replace(/'/g, "\\'").replace(/\n/g, ' ');
    var safeTo  = to.replace(/'/g, '');
    // Use service call to send SMS directly (works on most Android versions)
    var cmd = '"' + ADB_PATH + '" shell service call isms 5 s16 "com.android.mms" ' +
              's16 "' + safeTo + '" s16 "null" s16 "' + safeMsg + '" s16 "null" s16 "null"';
    exec(cmd, { timeout: 15000 }, function(err, stdout) {
      if (err) { reject(err); return; }
      // Check result — "Result: Parcel(00000000 00000000" means success
      if (stdout && stdout.indexOf('00000000') !== -1) {
        console.log('[ADB→SMS] Sent to ' + to);
        resolve({ ok: true });
      } else {
        reject(new Error('ADB send returned: ' + (stdout || '').trim()));
      }
    });
  });
}

// Poll ADB for new SMS messages every 4 seconds
async function pollAdbSms() {
  if (!ADB_ENABLED) return;
  try {
    var msgs = await readSmsViaAdb('inbox');
    msgs.forEach(function(sms) {
      if (adbSeenIds.has(sms.id)) return;
      adbSeenIds.add(sms.id);
      // Keep seen set bounded
      if (adbSeenIds.size > 1000) {
        var first = adbSeenIds.values().next().value;
        adbSeenIds.delete(first);
      }

      // Match sender phone to a known user
      var senderUser = localUsers.find(function(u) {
        return u.mobile && (
          u.mobile === sms.address ||
          u.mobile.replace(/\D/g,'') === sms.address.replace(/\D/g,'')
        );
      });
      var senderName = senderUser ? senderUser.name : null;

      // Parse DM reply format: "[RecipientName]: message"
      var dmReplyMatch = sms.body.match(/^\[([^\]]+)\]:\s*([\s\S]+)$/);
      var channel     = DEFAULT_CHANNEL;
      var displayText = sms.body;

      if (dmReplyMatch && senderUser) {
        var originalSender = dmReplyMatch[1];
        displayText = dmReplyMatch[2];
        channel = 'dm-' + [senderUser.name, originalSender].sort()
                    .join('-').toLowerCase().replace(/[\s.]+/g, '_');
      } else {
        channel = resolveChannel(sms.address, sms.body);
      }

      var entry = {
        id:         'adb-' + sms.id,
        from:       senderName || sms.address,
        smsFrom:    sms.address,
        channel:    channel,
        text:       displayText,
        color:      senderUser ? (senderUser.color || '#e67e22') : '#e67e22',
        receivedAt: sms.date,
        viaSms:     true,
        viaAdb:     true,
        injected:   false,
      };

      console.log('[ADB] SMS from ' + sms.address +
                  (senderName ? ' (' + senderName + ')' : '') +
                  ' → #' + channel + ': ' + displayText.slice(0, 60));

      // Add to chat log and sms log
      chatLog.unshift(entry);
      if (chatLog.length > 500) chatLog.pop();
      smsLog.unshift({ id: entry.id, from: entry.from, text: displayText,
                       channel, receivedAt: sms.date, injected: false, viaAdb: true });
      if (smsLog.length > 200) smsLog.pop();

      // Try to inject into Firestore (best-effort)
      var injectSender = senderName || ('📱 ADB (' + sms.address + ')');
      injectMessage(injectSender, displayText, channel, sms.date).then(function() {
        entry.injected = true;
      }).catch(function() {});
    });
  } catch (e) {
    // ADB poll failed — device may have been disconnected
    console.warn('[ADB] Poll error:', e.message);
  }
}

// Start ADB polling — checks device connection first
async function startAdbPoll() {
  if (!ADB_ENABLED) {
    console.log('  ℹ️  ADB disabled (ADB_ENABLED=false in .env)');
    return;
  }
  adbAvailable = await checkAdb();
  if (adbAvailable) {
    console.log('  ✅ ADB device connected — SMS polling active (USB)');
    // Seed seen IDs from existing inbox so we don't replay old messages on startup
    var existing = await readSmsViaAdb('inbox');
    existing.forEach(function(s) { adbSeenIds.add(s.id); });
    adbPollTimer = setInterval(pollAdbSms, 4000);
  } else {
    console.log('  📵 No ADB device — USB SMS polling inactive');
    console.log('     Connect phone via USB with USB Debugging enabled to activate');
    // Retry every 30 seconds in case phone is plugged in later
    setTimeout(startAdbPoll, 30000);
  }
}

// ADB status endpoint
app.get('/adb-status', async function(req, res) {
  var connected = await checkAdb();
  if (connected !== adbAvailable) {
    adbAvailable = connected;
    if (connected && !adbPollTimer) {
      var existing = await readSmsViaAdb('inbox');
      existing.forEach(function(s) { adbSeenIds.add(s.id); });
      adbPollTimer = setInterval(pollAdbSms, 4000);
    } else if (!connected && adbPollTimer) {
      clearInterval(adbPollTimer);
      adbPollTimer = null;
    }
  }
  res.json({
    ok:        true,
    adbEnabled:   ADB_ENABLED,
    adbAvailable: adbAvailable,
    adbPath:      ADB_PATH,
    seenCount:    adbSeenIds.size,
  });
});

// ── SEND SMS — tries WiFi gateway first, falls back to ADB ───
async function sendSms(to, message) {
  // Try WiFi gateway first
  if (SMS_GATEWAY_IP) {
    try {
      return await sendSmsViaGateway(to, message);
    } catch (e) {
      console.warn('[SMS] WiFi gateway failed, trying ADB:', e.message);
    }
  }
  // Fall back to ADB
  if (adbAvailable) {
    return await sendSmsViaAdb(to, message);
  }
  throw new Error('No SMS transport available. Configure SMS_GATEWAY_IP or connect phone via USB.');
}
function firestorePost(collectionPath, data) {
  return new Promise(function(resolve, reject) {
    const fields = {};
    Object.keys(data).forEach(function(key) {
      const val = data[key];
      if (typeof val === 'string')       fields[key] = { stringValue: val };
      else if (typeof val === 'boolean') fields[key] = { booleanValue: val };
      else if (typeof val === 'number')  fields[key] = { integerValue: String(val) };
      else if (val === null)             fields[key] = { nullValue: null };
      else if (Array.isArray(val))       fields[key] = { arrayValue: { values: [] } };
      else                               fields[key] = { stringValue: String(val) };
    });

    const body = JSON.stringify({ fields: fields });
    const url  = FIRESTORE_URL + '/' + collectionPath;
    const urlObj = new URL(url);

    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, function(res) {
      let raw = '';
      res.on('data', function(chunk) { raw += chunk; });
      res.on('end', function() {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(raw));
        } else {
          reject(new Error('Firestore error ' + res.statusCode + ': ' + raw));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── ROUTING RULES ────────────────────────────────────────────
const routingRules = [
  { match: /urgent|emergency|asap/i, channel: 'general' },
  { match: /report|update|status/i,  channel: 'general' },
];

function resolveChannel(from, body) {
  for (var i = 0; i < routingRules.length; i++) {
    var rule = routingRules[i];
    if (rule.match.test(body) || rule.match.test(from)) {
      return rule.channel;
    }
  }
  return DEFAULT_CHANNEL;
}

// ── INJECT INTO FIRESTORE ────────────────────────────────────
async function injectMessage(from, text, channel, receivedAt) {
  const time = new Date(receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  await firestorePost(
    'channels/' + channel + '/messages',
    {
      sender:   '📱 SMS (' + from + ')',
      color:    '#e67e22',
      text:     text,
      time:     time,
      viaSms:   true,
      smsFrom:  from,
    }
  );
}

// ── SEND OTP — called by the web app registration form ───────
app.post('/send-otp', async function(req, res) {
  try {
    var phone = cleanPhone(req.body.phone || '');
    if (!phone) return res.status(400).json({ ok: false, error: 'Phone number required.' });

    var code      = generateOtp();
    var expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    otpStore[phone] = { code: code, expiresAt: expiresAt };

    var message = 'MyHome Connect verification code: ' + code + '. Valid for 10 minutes. Do not share this code.';

    console.log('[OTP] Sending to ' + phone + ' → code: ' + code);

    try {
      await sendSms(phone, message);
      console.log('[OTP] Sent successfully to ' + phone);
      res.json({ ok: true });
    } catch (smsErr) {
      console.error('[OTP] SMS send failed:', smsErr.message);
      // In development/testing: return the code in the response so you can test without a phone
      res.status(500).json({
        ok: false,
        error: 'SMS gateway error: ' + smsErr.message,
        // Remove the line below in production!
        devCode: process.env.NODE_ENV !== 'production' ? code : undefined,
      });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── VERIFY OTP ───────────────────────────────────────────────
app.post('/verify-otp', function(req, res) {
  var phone = cleanPhone(req.body.phone || '');
  var code  = String(req.body.code || '').trim();

  var entry = otpStore[phone];
  if (!entry) {
    return res.json({ ok: false, error: 'No OTP was sent to this number. Request a new code.' });
  }
  if (Date.now() > entry.expiresAt) {
    delete otpStore[phone];
    return res.json({ ok: false, error: 'Code expired. Please request a new one.' });
  }
  if (entry.code !== code) {
    return res.json({ ok: false, error: 'Incorrect code. Please try again.' });
  }

  // Valid — mark as verified (single-use)
  delete otpStore[phone];
  res.json({ ok: true });
});

// ── SYNC USERS from web app (called on login, no Firebase needed) ──
app.post('/sync-users', function(req, res) {
  try {
    var incoming = req.body.users;
    if (!Array.isArray(incoming)) return res.status(400).json({ ok: false, error: 'users array required' });
    // Merge: update existing, add new
    incoming.forEach(function(u) {
      var idx = localUsers.findIndex(function(x) { return x.id === u.id || x.nameLower === u.nameLower; });
      if (idx >= 0) localUsers[idx] = Object.assign(localUsers[idx], u);
      else localUsers.push(u);
    });
    saveLocalUsers(localUsers);
    res.json({ ok: true, count: localUsers.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET USERS (for dashboard / debugging) ────────────────────
app.get('/users', function(req, res) {
  res.json(localUsers.map(function(u) {
    return { id: u.id, name: u.name, status: u.status || 'offline' };
  }));
});

// ── IN-MEMORY CHAT LOG (SMS-based messages when Firebase is down) ──
// Stores messages sent/received via SMS so the web app can poll them
const chatLog = [];   // { id, from, to, channel, text, time, receivedAt }

// ── SEND CHAT MESSAGE VIA SMS ─────────────────────────────────
// Called by the web app when Firebase is unavailable.
// Looks up the target user's phone number and sends the message as SMS.
app.post('/send-chat', async function(req, res) {
  try {
    var from      = req.body.from    || '';   // sender username
    var channel   = req.body.channel || DEFAULT_CHANNEL;
    var text      = req.body.text    || '';
    var color     = req.body.color   || '#6264a7';

    if (!text.trim()) return res.status(400).json({ ok: false, error: 'Empty message' });

    // Store in chat log so all clients can poll it
    var entry = {
      id:         Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      from:       from,
      channel:    channel,
      text:       text,
      color:      color,
      receivedAt: new Date().toISOString(),
      viaSms:     false,   // sent from web app, not from phone
    };
    chatLog.unshift(entry);
    if (chatLog.length > 500) chatLog.pop();

    // Also try to inject into Firestore (best-effort)
    injectMessage(from, '[' + from + ']: ' + text, channel, entry.receivedAt).catch(function() {});

    // If this is a DM channel, find the other user's phone and SMS them
    var smsSent = false;
    if (channel.startsWith('dm-')) {
      // DM channel id format: dm-name1-name2 (sorted)
      // Find the recipient (not the sender)
      var recipient = localUsers.find(function(u) {
        return u.name !== from &&
               channel.indexOf(u.name.toLowerCase().replace(/[\s.]+/g, '_')) !== -1;
      });
      if (recipient && recipient.mobile) {
        var smsText = '[' + from + ']: ' + text;
        try {
          await sendSms(recipient.mobile, smsText);
          smsSent = true;
          console.log('[Chat→SMS] ' + from + ' → ' + recipient.name + ' (' + recipient.mobile + '): ' + text);
        } catch (e) {
          console.warn('[Chat→SMS] SMS send failed:', e.message);
        }
      }
    } else {
      // Group channel — SMS all users who have a phone number (except sender)
      var targets = localUsers.filter(function(u) { return u.name !== from && u.mobile; });
      for (var i = 0; i < targets.length; i++) {
        var smsText = '[#' + channel + '] ' + from + ': ' + text;
        try {
          await sendSms(targets[i].mobile, smsText);
          smsSent = true;
        } catch (e) {}
      }
    }

    res.json({ ok: true, id: entry.id, smsSent: smsSent });
  } catch (err) {
    console.error('[Chat] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POLL CHAT LOG (web app polls this when Firebase is down) ──
app.get('/chat-log', function(req, res) {
  var limit  = parseInt(req.query.limit)  || 50;
  var since  = req.query.since || '';     // ISO timestamp — only return newer entries
  var channel = req.query.channel || '';

  var results = chatLog.filter(function(e) {
    if (channel && e.channel !== channel) return false;
    if (since && e.receivedAt <= since)   return false;
    return true;
  }).slice(0, limit);

  res.json(results);
});

// ── WEBHOOK — receives SMS from Android app ──────────────────
app.post('/sms', async function(req, res) {
  try {
    const body = req.body;
    const from       = body.from        || body.phoneNumber || body.sender || 'Unknown';
    const text       = body.message     || body.messageText || body.text   || body.body || '';
    const receivedAt = body.receivedAt  || body.timestamp   || new Date().toISOString();

    if (!text.trim()) return res.status(400).json({ error: 'Empty message' });

    // Try to match the sender's phone number to a known user
    var senderUser = localUsers.find(function(u) {
      return u.mobile && (u.mobile === from || u.mobile.replace(/\D/g,'') === from.replace(/\D/g,''));
    });
    var senderName = senderUser ? senderUser.name : null;

    // Parse DM replies: if SMS text starts with "[username]:" it's a reply to a DM
    // Format sent by /send-chat: "[SenderName]: message text"
    var dmReplyMatch = text.match(/^\[([^\]]+)\]:\s*([\s\S]+)$/);
    var channel = DEFAULT_CHANNEL;
    var displayText = text;

    if (dmReplyMatch && senderUser) {
      // This is a reply from a known user — route to their DM channel with the original sender
      var originalSender = dmReplyMatch[1];
      displayText = dmReplyMatch[2];
      // Build DM channel id the same way the web app does
      channel = 'dm-' + [senderUser.name, originalSender].sort().join('-').toLowerCase().replace(/[\s.]+/g, '_');
    } else {
      channel = resolveChannel(from, text);
    }

    const entry = {
      id:         Date.now(),
      from:       senderName || from,
      smsFrom:    from,
      channel:    channel,
      text:       displayText,
      color:      senderUser ? (senderUser.color || '#e67e22') : '#e67e22',
      receivedAt: receivedAt,
      viaSms:     true,
      injected:   false,
      error:      null,
    };

    console.log('[SMS] From: ' + from + (senderName ? ' (' + senderName + ')' : '') + ' → #' + channel + ': ' + displayText);

    // Store in chat log for web app polling
    chatLog.unshift(entry);
    if (chatLog.length > 500) chatLog.pop();

    // Also store in smsLog for the dashboard
    smsLog.unshift({ id: entry.id, from, text: displayText, channel, receivedAt, injected: false, error: null });
    if (smsLog.length > 200) smsLog.pop();

    // Try to inject into Firestore (best-effort)
    try {
      var injectSender = senderName ? senderName : ('📱 SMS (' + from + ')');
      await injectMessage(injectSender, displayText, channel, receivedAt);
      entry.injected = true;
      smsLog[0].injected = true;
    } catch (e) {
      entry.error = e.message;
      smsLog[0].error = e.message;
      console.error('[SMS] Firestore error:', e.message);
    }

    res.json({ ok: true, channel: channel, injected: entry.injected });

  } catch (err) {
    console.error('[SMS] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STATUS ───────────────────────────────────────────────────
app.get('/status', function(req, res) {
  res.json({
    ok:         true,
    uptime:     Math.floor(process.uptime()),
    projectId:  PROJECT_ID,
    logCount:   smsLog.length,
    chatCount:  chatLog.length,
    smsGateway: SMS_GATEWAY_IP ? SMS_GATEWAY_IP + ':' + SMS_GATEWAY_PORT : 'not configured',
    adb:        { enabled: ADB_ENABLED, connected: adbAvailable, path: ADB_PATH },
    timestamp:  new Date().toISOString(),
  });
});

// ── LOG ──────────────────────────────────────────────────────
app.get('/log', function(req, res) {
  var limit = parseInt(req.query.limit) || 50;
  res.json(smsLog.slice(0, limit));
});

// ── DASHBOARD ────────────────────────────────────────────────
app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── START ────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', function() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Palawan Connect — SMS Bridge Server    ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Dashboard  →  http://localhost:' + PORT + '      ║');
  console.log('║  Webhook    →  http://YOUR-IP:' + PORT + '/sms   ║');
  console.log('║  OTP Send   →  POST /send-otp            ║');
  console.log('║  OTP Verify →  POST /verify-otp          ║');
  console.log('║  ADB Status →  GET  /adb-status          ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('  SMS Transport priority:');
  if (SMS_GATEWAY_IP) {
    console.log('  1. ✅ WiFi Gateway: ' + SMS_GATEWAY_IP + ':' + SMS_GATEWAY_PORT);
  } else {
    console.log('  1. ⚠️  WiFi Gateway: not configured (set SMS_GATEWAY_IP in .env)');
  }
  console.log('  2. 🔌 ADB (USB): checking for connected device...');
  console.log('  Firebase project: ' + PROJECT_ID);
  console.log('');

  // Start ADB polling after server is up
  startAdbPoll();
});
