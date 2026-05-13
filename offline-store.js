/**
 * ─────────────────────────────────────────────────────────────
 *  offline-store.js  —  MyHome Connect Local Storage Layer
 *
 *  Handles all offline data: cached users, cached channels,
 *  cached messages, outbox queue, and incoming SMS queue.
 *  Works entirely from localStorage — no network needed.
 * ─────────────────────────────────────────────────────────────
 */

const OfflineStore = (function () {

  // ── KEYS ──────────────────────────────────────────────────
  const KEYS = {
    USERS:       'pc_users',
    CHANNELS:    'pc_channels',
    MESSAGES:    'pc_messages_',   // + channelId
    OUTBOX:      'pc_outbox',
    SMS_INBOX:   'pc_sms_inbox',
    LAST_SYNC:   'pc_last_sync',
  };

  // ── HELPERS ───────────────────────────────────────────────
  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function nowIso() { return new Date().toISOString(); }

  // ── USERS ─────────────────────────────────────────────────
  function cacheUsers(users) {
    save(KEYS.USERS, users);
  }

  function getCachedUsers() {
    return load(KEYS.USERS, []);
  }

  function getCachedUser(nameLower) {
    return getCachedUsers().find(u => u.nameLower === nameLower) || null;
  }

  function upsertCachedUser(user) {
    const users = getCachedUsers();
    const idx   = users.findIndex(u => u.id === user.id || u.nameLower === user.nameLower);
    if (idx >= 0) users[idx] = { ...users[idx], ...user };
    else          users.push(user);
    save(KEYS.USERS, users);
  }

  function removeCachedUser(userId) {
    const users = getCachedUsers().filter(u => u.id !== userId);
    save(KEYS.USERS, users);
  }

  // ── CHANNELS ──────────────────────────────────────────────
  function cacheChannels(channels) {
    save(KEYS.CHANNELS, channels);
  }

  function getCachedChannels() {
    return load(KEYS.CHANNELS, []);
  }

  function upsertCachedChannel(ch) {
    const channels = getCachedChannels();
    const idx      = channels.findIndex(c => c.id === ch.id);
    if (idx >= 0) channels[idx] = { ...channels[idx], ...ch };
    else          channels.push(ch);
    save(KEYS.CHANNELS, channels);
  }

  // ── MESSAGES ──────────────────────────────────────────────
  function cacheMessages(channelId, msgs) {
    // Keep last 500 messages per channel for better offline coverage
    const trimmed = msgs.slice(-500);
    save(KEYS.MESSAGES + channelId, trimmed);
  }

  function getCachedMessages(channelId) {
    return load(KEYS.MESSAGES + channelId, []);
  }

  function appendCachedMessage(channelId, msg) {
    const msgs = getCachedMessages(channelId);
    // avoid duplicates by id
    if (msg.id && msgs.find(m => m.id === msg.id)) return;
    msgs.push(msg);
    cacheMessages(channelId, msgs);
  }

  // ── OUTBOX (messages typed while offline) ─────────────────
  function addToOutbox(channelId, msg) {
    const outbox = load(KEYS.OUTBOX, []);
    outbox.push({ channelId, msg, queuedAt: nowIso() });
    save(KEYS.OUTBOX, outbox);
  }

  function getOutbox() {
    return load(KEYS.OUTBOX, []);
  }

  function clearOutbox() {
    save(KEYS.OUTBOX, []);
  }

  function removeFromOutbox(index) {
    const outbox = load(KEYS.OUTBOX, []);
    outbox.splice(index, 1);
    save(KEYS.OUTBOX, outbox);
  }

  // ── SMS INBOX (SMS received while offline / from bridge) ──
  function addSmsMessage(channelId, msg) {
    const inbox = load(KEYS.SMS_INBOX, []);
    inbox.push({ channelId, msg, receivedAt: nowIso() });
    save(KEYS.SMS_INBOX, inbox);
    // also append to channel message cache
    appendCachedMessage(channelId, msg);
  }

  function getSmsInbox() {
    return load(KEYS.SMS_INBOX, []);
  }

  function clearSmsInbox() {
    save(KEYS.SMS_INBOX, []);
  }

  // ── SYNC TIMESTAMP ────────────────────────────────────────
  function setLastSync() {
    save(KEYS.LAST_SYNC, nowIso());
  }

  function getLastSync() {
    return load(KEYS.LAST_SYNC, null);
  }

  // ── PUBLIC API ────────────────────────────────────────────
  return {
    cacheUsers, getCachedUsers, getCachedUser, upsertCachedUser, removeCachedUser,
    cacheChannels, getCachedChannels, upsertCachedChannel,
    cacheMessages, getCachedMessages, appendCachedMessage,
    addToOutbox, getOutbox, clearOutbox, removeFromOutbox,
    addSmsMessage, getSmsInbox, clearSmsInbox,
    setLastSync, getLastSync,
  };

})();

// ── EMAIL SESSION STORAGE (added for email-based architecture) ──
(function() {
  const EMAIL_USERS_KEY   = 'pc_email_users';
  const EMAIL_SESSION_KEY = 'pc_email_session';

  function loadRaw(key, fallback) {
    try { var r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback; } catch(e) { return fallback; }
  }
  function saveRaw(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) {}
  }

  OfflineStore.getCachedEmailUser = function(email) {
    var users = loadRaw(EMAIL_USERS_KEY, []);
    return users.find(function(u) { return u.email === email; }) || null;
  };

  OfflineStore.upsertCachedEmailUser = function(user) {
    var users = loadRaw(EMAIL_USERS_KEY, []);
    var idx   = users.findIndex(function(u) { return u.email === user.email; });
    if (idx >= 0) users[idx] = Object.assign(users[idx], user);
    else          users.push(user);
    saveRaw(EMAIL_USERS_KEY, users);
  };

  OfflineStore.getAllEmailUsers = function() {
    return loadRaw(EMAIL_USERS_KEY, []);
  };

  OfflineStore.saveEmailSession = function(data) {
    saveRaw(EMAIL_SESSION_KEY, data);
  };

  OfflineStore.getEmailSession = function() {
    return loadRaw(EMAIL_SESSION_KEY, null);
  };

  // Channels stored locally (email-based channels have no server registry)
  const EMAIL_CHANNELS_KEY = 'pc_email_channels';

  OfflineStore.getEmailChannels = function() {
    return loadRaw(EMAIL_CHANNELS_KEY, [
      { id: 'ch-general', label: '# general', desc: 'General discussion', type: 'channel' },
    ]);
  };

  OfflineStore.saveEmailChannels = function(channels) {
    saveRaw(EMAIL_CHANNELS_KEY, channels);
  };

  OfflineStore.upsertEmailChannel = function(ch) {
    var channels = OfflineStore.getEmailChannels();
    var idx = channels.findIndex(function(c) { return c.id === ch.id; });
    if (idx >= 0) channels[idx] = Object.assign(channels[idx], ch);
    else          channels.push(ch);
    OfflineStore.saveEmailChannels(channels);
  };
})();
