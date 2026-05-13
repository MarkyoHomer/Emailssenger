// AUTH GUARD
(function() {
  if (!sessionStorage.getItem('teamsUser')) window.location.href = 'index.html';
})();

// ── NETWORK HELPERS ──────────────────────────────────────────
function isOnline() { return navigator.onLine; }

// ═══════════════════════════════════════════════════════════════
//  EMAIL BRIDGE LAYER
//  Replaces Firebase Firestore with email (IMAP/SMTP) as the
//  message transport. All chat UI code below remains unchanged.
//  Messages are sent/received via the email-server.js bridge.
// ═══════════════════════════════════════════════════════════════

const EMAIL_BRIDGE_URL = localStorage.getItem('mhc_bridge_url') || 'http://localhost:3001';

// Get the auth token for the current user
function getEmailToken() {
  var u = JSON.parse(sessionStorage.getItem('teamsUser') || '{}');
  return u.token || '';
}

function emailHeaders() {
  return { 'Content-Type': 'application/json', 'x-token': getEmailToken() };
}

// ── EMAIL: SEND MESSAGE ───────────────────────────────────────
// Called instead of db.collection('channels').doc(id).collection('messages').add()
async function emailSendMessage(convId, msg, recipients) {
  var body = {
    convId:      convId,
    text:        msg.text,
    to:          recipients || [],
    quoteText:   msg.quoteText   || null,
    quoteSender: msg.quoteSender || null,
  };
  var res  = await fetch(EMAIL_BRIDGE_URL + '/messages/send', {
    method:  'POST',
    headers: emailHeaders(),
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(10000),
  });
  return res.json();
}

// ── EMAIL: POLL MESSAGES ──────────────────────────────────────
// Polls the bridge for new messages in a conversation
var _emailPollTimers  = {};
var _emailPollSince   = {}; // { convId: ISO string }

function startEmailPoll(convId) {
  if (_emailPollTimers[convId]) return;
  _emailPollTimers[convId] = setInterval(function() { fetchEmailMessages(convId); }, 10000);
  fetchEmailMessages(convId); // immediate first fetch
}

function stopEmailPoll(convId) {
  clearInterval(_emailPollTimers[convId]);
  delete _emailPollTimers[convId];
}

function stopAllEmailPolls() {
  Object.keys(_emailPollTimers).forEach(stopEmailPoll);
}

async function fetchEmailMessages(convId) {
  var since = _emailPollSince[convId] || '';
  try {
    // Trigger server-side IMAP sync first, then fetch results
    try {
      await fetch(EMAIL_BRIDGE_URL + '/messages/sync', {
        method:  'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, emailHeaders()),
        body:    JSON.stringify({ convId: convId }),
        signal:  AbortSignal.timeout(12000),
      });
    } catch (syncErr) {
      // Sync failed (timeout etc) — still try to fetch cached messages
    }

    var url = EMAIL_BRIDGE_URL + '/messages/' + encodeURIComponent(convId) +
              (since ? '?since=' + encodeURIComponent(since) : '');
    var res  = await fetch(url, { headers: emailHeaders(), signal: AbortSignal.timeout(5000) });
    var msgs = await res.json();
    if (!Array.isArray(msgs) || !msgs.length) return;

    var area    = document.getElementById('messagesArea');
    var changed = false;
    var me      = (JSON.parse(sessionStorage.getItem('teamsUser') || '{}')).email || '';

    msgs.forEach(function(m) {
      var isMine = m.from === me;

      // Skip own sent messages — they're already shown optimistically
      // BUT only skip if the optimistic bubble is still in the DOM
      if (isMine) {
        // Check if there's already a rendered bubble for this message
        // (either the optimistic opt- bubble or a previously received sent- bubble)
        if (document.querySelector('[data-msg-id="' + m.id + '"]')) return;
        // Also skip if any opt- bubble exists with same text (optimistic match)
        var optBubbles = document.querySelectorAll('[data-msg-id^="opt-"]');
        for (var i = 0; i < optBubbles.length; i++) {
          var bubbleText = optBubbles[i].querySelector('.msg-bubble');
          if (bubbleText && bubbleText.innerText && bubbleText.innerText.trim() === (m.text || '').trim()) {
            // Replace the opt- ID with the real ID so future dedup works
            optBubbles[i].dataset.msgId = m.id;
            // Clear pending style
            var pb = optBubbles[i].querySelector('.msg-bubble');
            if (pb) { pb.classList.remove('pending-bubble'); pb.style.opacity = '1'; pb.style.borderStyle = ''; }
            var badge = optBubbles[i].querySelector('.pending-badge');
            if (badge) badge.remove();
            return; // don't re-render
          }
        }
      }

      // Skip if already rendered by exact ID
      if (document.querySelector('[data-msg-id="' + m.id + '"]')) return;

      var msgObj = {
        id:          m.id,
        sender:      m.fromName || m.from,
        color:       m.fromColor || getColor(m.fromName || m.from),
        text:        m.text || '',
        time:        new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp:   { toDate: function() { return new Date(m.date); } },
        reactions:   [],
        quoteText:   m.quoteText   || null,
        quoteSender: m.quoteSender || null,
        viaEmail:    true,
      };

      // Cache locally
      OfflineStore.appendCachedMessage(convId, msgObj);

      if (convId === state.currentChannel) {
        appendMessageEl(area, msgObj);
        changed = true;
        if (!isMine) {
          state.unreadMsgIds.add(m.id);
        }
      } else {
        if (!isMine) {
          state.unread[convId] = (state.unread[convId] || 0) + 1;
          if (!state.unreadSenders[convId]) state.unreadSenders[convId] = new Set();
          state.unreadSenders[convId].add(msgObj.sender);
          renderChannels();
          renderDMsFromCache();
          updateTabTitle();
          updateFavicon(true);
          showBrowserNotification(msgObj.sender, msgObj.text, convId);
        }
      }
    });

    if (changed && area) area.scrollTop = area.scrollHeight;

    // Update since to newest message date
    _emailPollSince[convId] = msgs[msgs.length - 1].date;

  } catch (e) {
    // Bridge not reachable — silent
  }
}

// ── EMAIL: GET RECIPIENTS FOR A CONVERSATION ─────────────────
// For DMs: the other user's email
// For channels: all users who are members
function getRecipientsForConv(convId) {
  var me    = (JSON.parse(sessionStorage.getItem('teamsUser') || '{}')).email || '';
  var users = OfflineStore.getCachedUsers();

  if (convId.startsWith('dm-')) {
    // Find the other user from the DM channel ID
    // DM id format: dm-email1_at_domain--email2_at_domain (sorted)
    var allUsers = OfflineStore.getAllEmailUsers ? OfflineStore.getAllEmailUsers() : users;
    var other = allUsers.find(function(u) {
      if (!u.email || u.email === me) return false;
      var testId = emailDmConvId(me, u.email);
      return testId === convId;
    });
    return other ? [other.email] : [];
  }

  // Channel: all known users except self
  var allUsers = OfflineStore.getAllEmailUsers ? OfflineStore.getAllEmailUsers() : [];
  return allUsers.filter(function(u) { return u.email && u.email !== me; }).map(function(u) { return u.email; });
}

// Build DM conversation ID from two email addresses
function emailDmConvId(emailA, emailB) {
  return 'dm-' + [emailA, emailB].sort().join('--').replace(/[@.]/g, '_');
}

// ── STUB: disable Firebase-specific functions gracefully ──────
// These are called in the original code but not needed with email
window._firebaseAvailable = false; // tell the app Firebase is not in use

// Override db to be a no-op proxy so any remaining db.collection() calls don't crash
if (typeof firebase === 'undefined') {
  window.firebase = { firestore: { FieldValue: { serverTimestamp: function() { return new Date().toISOString(); }, delete: function() { return null; } } } };
  var _noopQuery = { get: function() { return Promise.resolve({ empty: true, docs: [] }); }, onSnapshot: function(cb) { cb({ docs: [], docChanges: function() { return []; } }); return function() {}; }, add: function() { return Promise.resolve({ id: 'local-' + Date.now() }); }, set: function() { return Promise.resolve(); }, update: function() { return Promise.resolve(); }, delete: function() { return Promise.resolve(); }, where: function() { return _noopQuery; }, orderBy: function() { return _noopQuery; }, limit: function() { return _noopQuery; }, limitToLast: function() { return _noopQuery; }, doc: function() { return _noopQuery; }, collection: function() { return _noopQuery; } };
  window.db      = { collection: function() { return _noopQuery; } };
  window.storage = { ref: function() { return { put: function() { return Promise.resolve(); }, getDownloadURL: function() { return Promise.resolve(''); } }; } };
}

// ═══════════════════════════════════════════════════════════════
//  END EMAIL BRIDGE LAYER — original app code continues below
// ═══════════════════════════════════════════════════════════════

// ── OFFLINE SMS POLLING ──────────────────────────────────────
// Polls the local SMS bridge server for new messages when on LAN
const SMS_BRIDGE_URL = 'http://localhost:3000';
let smsPollTimer = null;

function startSmsPoll() {
  if (smsPollTimer) return;
  smsPollTimer = setInterval(fetchSmsFromBridge, 5000);
  fetchSmsFromBridge(); // immediate first fetch
}

function stopSmsPoll() {
  clearInterval(smsPollTimer);
  smsPollTimer = null;
}

// Push cached users to the SMS bridge so it can work without Firebase
function syncUsersToBridge() {
  try {
    var users = OfflineStore.getCachedUsers();
    if (!users.length) return;
    fetch(SMS_BRIDGE_URL + '/sync-users', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ users: users }),
      signal:  AbortSignal.timeout(2000),
    }).catch(function() {}); // silent fail — bridge may not be running
  } catch (e) {}
}

// Send a chat message via the SMS bridge (used when Firebase is unavailable)
// Returns a Promise<boolean> — true if bridge accepted it
function sendViaSmsbridge(channelId, msg) {
  return fetch(SMS_BRIDGE_URL + '/send-chat', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      from:    msg.sender,
      channel: channelId,
      text:    msg.text,
      color:   msg.color,
    }),
    signal: AbortSignal.timeout(3000),
  })
  .then(function(r) { return r.json(); })
  .then(function(d) { return !!d.ok; })
  .catch(function() { return false; });
}

// ── CHAT-LOG POLLING ─────────────────────────────────────────
// When Firebase is unavailable, poll the bridge's /chat-log endpoint
// so messages sent by other users (via SMS or the bridge) appear in the UI.
var _chatPollTimer   = null;
var _chatPollSince   = {};   // { channelId: lastReceivedAt ISO string }

function startChatPoll() {
  if (_chatPollTimer) return;
  _chatPollTimer = setInterval(fetchChatFromBridge, 3000);
  fetchChatFromBridge();
}

function stopChatPoll() {
  clearInterval(_chatPollTimer);
  _chatPollTimer = null;
}

async function fetchChatFromBridge() {
  if (!state.currentChannel) return;
  var since = _chatPollSince[state.currentChannel] || '';
  try {
    var url = SMS_BRIDGE_URL + '/chat-log?limit=30&channel=' +
              encodeURIComponent(state.currentChannel) +
              (since ? '&since=' + encodeURIComponent(since) : '');
    var res  = await fetch(url, { signal: AbortSignal.timeout(2000) });
    var data = await res.json();
    if (!Array.isArray(data) || !data.length) return;

    var area = document.getElementById('messagesArea');
    var changed = false;

    data.forEach(function(entry) {
      // Skip messages sent by current user (already shown optimistically)
      if (entry.from === state.currentUser.name) return;

      var msgId = 'bridge-' + entry.id;
      // Skip if already rendered
      if (document.querySelector('[data-msg-id="' + msgId + '"]')) return;

      var msg = {
        id:        msgId,
        sender:    entry.viaSms ? ('📱 SMS (' + entry.from + ')') : entry.from,
        color:     entry.color || '#e67e22',
        text:      escapeHtml(entry.text || ''),
        time:      new Date(entry.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp: { toDate: function() { return new Date(entry.receivedAt); } },
        reactions: [],
        viaSms:    !!entry.viaSms,
        smsFrom:   entry.smsFrom || '',
      };

      OfflineStore.appendCachedMessage(state.currentChannel, msg);
      appendMessageEl(area, msg);
      changed = true;

      // Unread badge if not the active channel
      if (entry.channel !== state.currentChannel) {
        state.unread[entry.channel] = (state.unread[entry.channel] || 0) + 1;
        renderChannels();
        renderDMsFromCache();
        updateTabTitle();
      }
    });

    if (changed) {
      area.scrollTop = area.scrollHeight;
      // Update since timestamp to the newest entry
      _chatPollSince[state.currentChannel] = data[0].receivedAt;
    }
  } catch (e) {
    // Bridge not reachable — silent fail
  }
}

async function fetchSmsFromBridge() {
  try {
    const res  = await fetch(SMS_BRIDGE_URL + '/log?limit=20', { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    if (!Array.isArray(data)) return;

    const seen = JSON.parse(localStorage.getItem('pc_seen_sms') || '[]');
    let changed = false;

    data.forEach(function(entry) {
      if (seen.includes(entry.id)) return;
      seen.push(entry.id);
      changed = true;

      const channelId = entry.channel || state.currentChannel;
      const msg = {
        id:        'sms-' + entry.id,
        sender:    '📱 SMS (' + entry.from + ')',
        color:     '#e67e22',
        text:      escapeHtml(entry.text || ''),
        time:      new Date(entry.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp: { toDate: function() { return new Date(entry.receivedAt); } },
        reactions: [],
        viaSms:    true,
        smsFrom:   entry.from,
        offline:   true,
      };

      // Store in offline cache
      OfflineStore.addSmsMessage(channelId, msg);

      // If this channel is currently open, append live
      if (channelId === state.currentChannel) {
        const area = document.getElementById('messagesArea');
        appendMessageEl(area, msg);
        area.scrollTop = area.scrollHeight;
        showSmsToast(entry.from, entry.text);
      } else {
        // Unread badge
        state.unread[channelId] = (state.unread[channelId] || 0) + 1;
        if (!state.unreadSenders[channelId]) state.unreadSenders[channelId] = new Set();
        state.unreadSenders[channelId].add(msg.sender);
        renderChannels();
        renderDMsFromCache();
        updateTabTitle();
        updateFavicon(true);
        showSmsToast(entry.from, entry.text);
      }
    });

    if (changed) {
      // Keep seen list to last 500 entries
      if (seen.length > 500) seen.splice(0, seen.length - 500);
      localStorage.setItem('pc_seen_sms', JSON.stringify(seen));
    }
  } catch (e) {
    // Bridge not reachable — silent fail
  }
}

function showSmsToast(from, text) {
  let toast = document.getElementById('smsToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'smsToast';
    toast.className = 'sms-toast';
    document.body.appendChild(toast);
  }
  toast.innerHTML = '<strong>📱 SMS from ' + escapeHtml(from) + '</strong><br>' + escapeHtml((text || '').slice(0, 80));
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(function() { toast.classList.remove('show'); }, 4000);
}

// STATE
const state = {
  currentChannel: 'general',
  currentUser: {},
  unread: {},
  unreadSenders: {},
  unreadMsgIds: new Set(),
  lastSender: {},
  dmLastActivity: {},       // { channelId: timestamp ms } — for sorting DMs by recent activity
  msgCount: {},
  notifCount: {},
  unsubscribeMessages: null,
  unsubscribeUsers: null,
  unsubscribeNotifs: [],
  typingTimer: null,
  isOffline: false,
  quoteMsg: null,
};

// BASE CHANNELS — empty, all channels are created by users
const channels = [];

// INIT
document.addEventListener('DOMContentLoaded', async () => {
  state.currentUser = JSON.parse(sessionStorage.getItem('teamsUser'));
  state.isOffline   = !isOnline() || !!state.currentUser.isOfflineSession || !!state.currentUser.localOnly;

  document.getElementById('myName').textContent        = state.currentUser.name;
  document.getElementById('myAvatar').textContent      = state.currentUser.name[0].toUpperCase();
  document.getElementById('myAvatar').style.background = state.currentUser.color;
  updateStatusDisplay(state.currentUser.status);

  // Restore avatar photo if saved
  if (state.currentUser.avatarUrl) {
    var img = document.getElementById('myAvatarImg');
    var ini = document.getElementById('myAvatarInitial');
    if (img) { img.src = state.currentUser.avatarUrl; img.style.display = 'block'; }
    if (ini) ini.style.display = 'none';
  }

  // Show mobile linked badge if number is saved
  updateMobileLinkedBadge();

  // Show appropriate banner
  if (state.currentUser.localOnly) {
    showLocalOnlyBanner();
  } else if (state.currentUser.isOfflineSession) {
    showOfflineSessionBanner();
  }

  await loadChannelMeta();
  renderChannels();

  // ── EMAIL MODE INIT ───────────────────────────────────────
  // Load users from email bridge, fall back to local cache
  var emailUsers = OfflineStore.getAllEmailUsers ? OfflineStore.getAllEmailUsers() : [];
  if (emailUsers.length) {
    // Map email users to the format renderDMs/renderMembers expect
    var mappedUsers = emailUsers.map(function(u) {
      return { id: u.email, name: u.name, nameLower: (u.name||'').toLowerCase(), color: u.color || getColor(u.name||u.email), email: u.email, status: 'online' };
    });
    OfflineStore.cacheUsers(mappedUsers);
    renderDMs(mappedUsers);
    renderMembers(mappedUsers);
    seedDmActivityFromCache(mappedUsers);
  }

  if (channels.length > 0) {
    loadChannel(channels[0].id);
  } else {
    document.getElementById('channelTitle').textContent = 'No channels yet';
    document.getElementById('channelDesc').textContent  = 'Click + Add Channel to get started';
    document.getElementById('messagesArea').innerHTML   =
      '<div style="text-align:center;color:#aaa;margin-top:60px;font-size:14px;">No channels yet.<br>Click <strong>+ Add Channel</strong> to create one.</div>';
  }

  // Start background polling for all channels
  setTimeout(startNotifListeners, 1500);

  window.addEventListener('beforeunload', markOffline);

  // Online / offline banner
  function handleOnlineChange() {
    const online = isOnline();
    state.isOffline = !online;
    updateOfflineBanner(online);
    if (online) {
      // Back online — retry outbox and reload current channel
      syncOutbox();
      loadChannel(state.currentChannel);
    }
  }

  window.addEventListener('online',  handleOnlineChange);
  window.addEventListener('offline', handleOnlineChange);
  updateOfflineBanner(isOnline());

  // Always poll SMS bridge (works on LAN regardless of internet)
  startSmsPoll();

  // Push local user cache to SMS bridge
  syncUsersToBridge();

  // On mobile: prompt for mobile number if not yet linked
  checkMobilePrompt();
});


// OFFLINE BANNER + SESSION BANNER
function updateOfflineBanner(online) {
  const banner = document.getElementById('offlineBanner');
  if (!banner) return;
  if (online) {
    banner.style.display = 'none';
  } else {
    banner.style.display = 'block';
    banner.style.background = '#e67e22';
    banner.innerHTML = '📡 You are offline — messages will sync when reconnected.';
  }
}

function showOfflineSessionBanner() {
  const banner = document.getElementById('offlineBanner');
  banner.style.display = 'block';
  banner.style.background = '#8e44ad';
  banner.innerHTML = '🔒 Offline session — SMS inbox active. Outgoing messages queued until reconnected.';
}

function showLocalOnlyBanner() {
  const banner = document.getElementById('offlineBanner');
  banner.style.display = 'block';
  banner.style.background = '#2980b9';
  banner.innerHTML = '📡 Local mode — Firebase unavailable. <strong>SMS chat active</strong> via bridge. Messages will sync when Firebase reconnects.';
}

// OUTBOX SYNC — flush queued messages to Firestore when back online
async function syncOutbox() {
  const outbox = OfflineStore.getOutbox();
  if (!outbox.length) return;

  let synced = 0;
  for (let i = outbox.length - 1; i >= 0; i--) {
    const item = outbox[i];
    try {
      var recipients = getRecipientsForConv(item.channelId);
      var result = await emailSendMessage(item.channelId, item.msg, recipients);
      if (result.ok) {
        OfflineStore.removeFromOutbox(i);
        synced++;
      }
    } catch (e) {
      // leave in outbox, try next time
    }
  }

  if (synced > 0) {
    showSyncToast(synced + ' queued message' + (synced > 1 ? 's' : '') + ' synced ✓');
  }
}

function showSyncToast(msg) {
  let toast = document.getElementById('syncToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'syncToast';
    toast.className = 'sync-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(function() { toast.classList.remove('show'); }, 3500);
}
async function loadChannelMeta() {
  // ── EMAIL MODE: load channels from localStorage, no Firebase ──
  var emailChannels = OfflineStore.getEmailChannels();
  emailChannels.forEach(function(ch) {
    if (!channels.find(function(c) { return c.id === ch.id; })) {
      channels.push(ch);
    }
  });
  // Also try to fetch known users from bridge to discover DM channels
  try {
    var res   = await fetch(EMAIL_BRIDGE_URL + '/users', { headers: emailHeaders(), signal: AbortSignal.timeout(3000) });
    var users = await res.json();
    if (Array.isArray(users)) {
      var me = state.currentUser.email || state.currentUser.id;
      users.forEach(function(u) {
        if (!u.email || u.email === me) return;
        // Register as a known user for DM discovery
        OfflineStore.upsertCachedUser({ id: u.email, name: u.name, nameLower: (u.name || '').toLowerCase(), color: u.color || getColor(u.name), email: u.email, status: 'online' });
        if (OfflineStore.upsertCachedEmailUser) OfflineStore.upsertCachedEmailUser(u);
      });
    }
  } catch (e) { /* bridge not running — use cached users */ }
}

// Pre-cache the last 100 messages for every channel + every DM in the background
function preCacheAllMessages() {
  if (!isOnline() || window._firebaseAvailable === false) return;

  // Group channels
  channels.forEach(function(ch) {
    _cacheChannelMessages(ch.id);
  });

  // DM channels for all known users
  var users = OfflineStore.getCachedUsers();
  users.forEach(function(u) {
    if (u.name === state.currentUser.name) return;
    var dmId = dmChannelId(state.currentUser.name, u.name);
    _cacheChannelMessages(dmId);
  });
}

// Fetch and cache messages for a channel — email mode: already handled by polling
function _cacheChannelMessages(channelId) {
  // No-op in email mode — fetchEmailMessages handles caching
}

function loadChannelMetaFromCache() {
  const cached = OfflineStore.getCachedChannels();
  cached.forEach(function(ch) {
    if (!channels.find(function(c) { return c.id === ch.id; })) {
      channels.push(ch);
    }
  });
}

// RENDER CHANNELS
function renderChannels(filter) {
  filter = filter || '';
  const list = document.getElementById('channelList');
  list.innerHTML = '';
  channels
    .filter(function(c) { return c.label.toLowerCase().includes(filter.toLowerCase()); })
    .forEach(function(c) {
      const hasUnread = state.unread[c.id] > 0;

      const div = document.createElement('div');
      div.className = 'channel-item' + (c.id === state.currentChannel ? ' active' : '');
      div.onclick = function() { loadChannelAndCloseSidebar(c.id); };

      // Channel label — bold + orange when unread, normal when read
      const labelSpan = document.createElement('span');
      labelSpan.textContent = c.label;
      labelSpan.className = hasUnread ? 'ch-label unread-item' : 'ch-label';
      div.appendChild(labelSpan);

      if (hasUnread) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = state.unread[c.id];
        div.appendChild(badge);
      }

      const menuBtn = document.createElement('span');
      menuBtn.className = 'ch-menu-btn';
      menuBtn.textContent = '...';
      menuBtn.title = 'Options';
      menuBtn.onclick = function(e) { e.stopPropagation(); openChannelCtxMenu(e, c.id); };
      div.appendChild(menuBtn);

      list.appendChild(div);
    });
}

// RENDER DMs — only show users with existing conversations, sorted by most recent
function renderDMs(users, filter) {
  filter = filter || '';
  const list = document.getElementById('dmList');
  list.innerHTML = '';

  var filtered = users
    .filter(function(u) { return u.name !== state.currentUser.name; })
    .filter(function(u) { return u.name.toLowerCase().includes((filter || '').toLowerCase()); })
    // Only show if there is an existing conversation (has cached messages, unread, or known activity)
    .filter(function(u) {
      var dmId = dmChannelId(state.currentUser.name, u.name);
      var hasMsgs    = OfflineStore.getCachedMessages(dmId).length > 0;
      var hasUnread  = (state.unread[dmId] || 0) > 0;
      var hasActivity = (state.dmLastActivity[dmId] || 0) > 0;
      return hasMsgs || hasUnread || hasActivity;
    });

  // Sort: most recent activity first, then alphabetical for ties
  filtered.sort(function(a, b) {
    var dmA = dmChannelId(state.currentUser.name, a.name);
    var dmB = dmChannelId(state.currentUser.name, b.name);
    var tA  = state.dmLastActivity[dmA] || 0;
    var tB  = state.dmLastActivity[dmB] || 0;
    if (tB !== tA) return tB - tA;
    return a.name.localeCompare(b.name);
  });

  filtered.forEach(function(u) {
    const dmId      = dmChannelId(state.currentUser.name, u.name);
    const hasUnread = state.unread[dmId] > 0;

    const div = document.createElement('div');
    div.className = 'channel-item' + (dmId === state.currentChannel ? ' active' : '');
    div.onclick   = function() { loadChannelAndCloseSidebar(dmId, u.name, 'Direct message with ' + u.name); };

    const dot = document.createElement('span');
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:' + statusColor(u.status) + ';display:inline-block;flex-shrink:0;';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = u.name;
    nameSpan.className = hasUnread ? 'ch-label unread-item' : 'ch-label';

    div.appendChild(dot);
    div.appendChild(nameSpan);

    if (hasUnread) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = state.unread[dmId];
      div.appendChild(badge);
    }

    list.appendChild(div);
  });

  // Show "New Message" button to start a conversation with someone new
  renderNewDmButton(users, list);
}

// Helper to re-render DMs from cached users
function renderDMsFromCache() {
  const cached = OfflineStore.getCachedUsers();
  renderDMs(cached);
}

// "New Message" button — lets user start a DM with someone they haven't talked to yet
function renderNewDmButton(allUsers, list) {
  var btn = document.createElement('button');
  btn.className = 'add-channel-btn';
  btn.textContent = '+ New Direct Message';
  btn.style.marginTop = '6px';
  btn.onclick = function() { openNewDmModal(allUsers); };
  list.appendChild(btn);
}

// New DM modal — pick a user to start a conversation (only shows users not already in sidebar)
var _newDmModal = null;

function openNewDmModal(users) {
  // Remove existing modal if any
  if (_newDmModal) _newDmModal.remove();

  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay show';
  overlay.id = 'newDmModal';
  _newDmModal = overlay;

  // Only show users who do NOT already have a conversation in the sidebar
  var allUsers = (users || OfflineStore.getCachedUsers())
    .filter(function(u) { return u.name !== state.currentUser.name; });

  var newUsers = allUsers.filter(function(u) {
    var dmId = dmChannelId(state.currentUser.name, u.name);
    var hasMsgs    = OfflineStore.getCachedMessages(dmId).length > 0;
    var hasUnread  = (state.unread[dmId] || 0) > 0;
    var hasActivity = (state.dmLastActivity[dmId] || 0) > 0;
    return !hasMsgs && !hasUnread && !hasActivity;
  });

  overlay.innerHTML =
    '<div class="modal-box" style="width:min(340px,calc(100vw - 24px))">' +
      '<h3>New Direct Message</h3>' +
      '<p style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">Start a conversation with someone new</p>' +
      '<div style="position:relative;margin-bottom:10px;">' +
        '<input id="newDmSearch" type="text" placeholder="🔍 Search users..." autocomplete="off" ' +
          'style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text-light);font-size:13px;outline:none;" ' +
          'oninput="filterNewDmList(this.value)">' +
      '</div>' +
      '<div id="newDmUserList" style="max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;">' +
      '</div>' +
      '<div class="modal-actions">' +
        '<button class="btn cancel" onclick="closeNewDmModal()">Cancel</button>' +
      '</div>' +
    '</div>';

  overlay.onclick = function(e) { if (e.target === overlay) closeNewDmModal(); };
  document.body.appendChild(overlay);

  // Store users list on the overlay for filtering
  overlay._newUsers = newUsers;
  renderNewDmUserList(newUsers);

  // Focus search
  setTimeout(function() {
    var searchInput = document.getElementById('newDmSearch');
    if (searchInput) searchInput.focus();
  }, 50);
}

function renderNewDmUserList(users) {
  var list = document.getElementById('newDmUserList');
  if (!list) return;
  if (!users || users.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;font-size:13px;">No users found</div>';
    return;
  }
  list.innerHTML = users.map(function(u) {
    return '<div class="new-dm-row" onclick="startDmWith(\'' + escapeHtml(u.name) + '\')">' +
      '<div class="user-avatar" style="background:' + u.color + ';width:28px;height:28px;font-size:12px;flex-shrink:0">' + u.name[0] + '</div>' +
      '<span style="flex:1;font-size:13px">' + escapeHtml(u.name) + '</span>' +
      '<span style="font-size:10px;color:' + statusColor(u.status || 'offline') + '">' + (u.status || 'offline') + '</span>' +
    '</div>';
  }).join('');
}

function filterNewDmList(query) {
  if (!_newDmModal) return;
  var users = _newDmModal._newUsers || [];
  var q = (query || '').toLowerCase().trim();
  var filtered = q ? users.filter(function(u) { return u.name.toLowerCase().includes(q); }) : users;
  renderNewDmUserList(filtered);
}

function closeNewDmModal() {
  if (_newDmModal) { _newDmModal.remove(); _newDmModal = null; }
}

function startDmWith(userName) {
  closeNewDmModal();
  var dmId = dmChannelId(state.currentUser.name, userName);
  // Mark activity so this user now appears in the DM list
  state.dmLastActivity[dmId] = Date.now();
  loadChannelAndCloseSidebar(dmId, userName, 'Direct message with ' + userName);
  renderDMsFromCache();
}

// Seed DM activity timestamps from cached messages so sort order is correct on load
// Seed DM activity timestamps from cached messages so sort order is correct on load
function seedDmActivityFromCache(users) {
  if (!users) users = OfflineStore.getCachedUsers();
  var me = state.currentUser.email || state.currentUser.id;
  users.forEach(function(u) {
    var uEmail = u.email || u.id;
    if (!uEmail || uEmail === me) return;
    var dmId = emailDmConvId(me, uEmail);
    if (state.dmLastActivity[dmId]) return;

    var msgs = OfflineStore.getCachedMessages(dmId);
    if (msgs && msgs.length > 0) {
      var last = msgs[msgs.length - 1];
      var ts = last.timestamp && last.timestamp.toDate
        ? last.timestamp.toDate().getTime()
        : Date.now();
      if (ts) state.dmLastActivity[dmId] = ts;
    }
  });
  renderDMsFromCache();
}

function dmChannelId(a, b) {
  // In email mode, use email addresses if available, otherwise fall back to names
  var userA = OfflineStore.getCachedUsers().find(function(u) { return u.name === a || u.email === a; });
  var userB = OfflineStore.getCachedUsers().find(function(u) { return u.name === b || u.email === b; });
  var idA   = (userA && userA.email) ? userA.email : a;
  var idB   = (userB && userB.email) ? userB.email : b;
  return emailDmConvId(idA, idB);
}

// RENDER MEMBERS
function renderMembers(users) {
  const list = document.getElementById('membersList');
  list.innerHTML = '';
  const isAdmin = state.currentUser.name === 'Admin'; // only Admin can remove users

  users.forEach(function(u) {
    const isSelf = u.name === state.currentUser.name;
    const div = document.createElement('div');
    div.className = 'member-item';

    div.innerHTML =
      '<div class="user-avatar" style="background:' + u.color + ';width:30px;height:30px;font-size:12px;flex-shrink:0">' + u.name[0] + '</div>' +
      '<span style="flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(u.name) + (isSelf ? ' <span style="font-size:10px;color:var(--text-muted)">(you)</span>' : '') + '</span>' +
      '<span class="dot ' + (u.status || 'offline') + '"></span>';

    // Add ... menu button for every user (admin can remove others; anyone can remove themselves)
    if (!isSelf || isAdmin) {
      const menuBtn = document.createElement('span');
      menuBtn.className = 'member-menu-btn';
      menuBtn.textContent = '···';
      menuBtn.title = 'Options';
      menuBtn.onclick = function(e) {
        e.stopPropagation();
        openMemberCtxMenu(e, u);
      };
      div.appendChild(menuBtn);
    }

    list.appendChild(div);
  });
}

// LOAD CHANNEL
function loadChannel(id, title, desc) {
  if (state.unsubscribeMessages) { state.unsubscribeMessages(); state.unsubscribeMessages = null; }

  closeConvSearch();

  state.currentChannel = id;
  state.unread[id]     = 0;
  state.unreadSenders[id] = new Set();
  state.lastSender[id]    = null;
  // Update DM sort order when opening a DM
  if (id.startsWith('dm-')) {
    state.dmLastActivity[id] = state.dmLastActivity[id] || Date.now();
    renderDMsFromCache();
  }
  // Clear unread message IDs for this channel — loading it counts as reading
  // We'll clear them after messages render so the bold shows briefly then fades
  updateTabTitle();
  updateFavicon(Object.values(state.unread).some(function(n){ return n > 0; }));

  const ch = channels.find(function(c) { return c.id === id; });
  document.getElementById('channelTitle').textContent = title || (ch ? ch.label : id);
  document.getElementById('channelDesc').textContent  = desc  || (ch ? ch.desc  || '' : '');

  renderChannels();
  renderDMsFromCache();

  // Don't restart notif listeners on every channel switch — they run in background
  // startNotifListeners is called once on load and handles all channels

  // Subscribe to typing indicators for this channel
  subscribeTyping(id);

  // ── EMAIL MODE: render from cache then start polling ──────
  // Stop polling previous channel
  if (state._prevEmailConv && state._prevEmailConv !== id) {
    stopEmailPoll(state._prevEmailConv);
  }
  state._prevEmailConv = id;

  // Render cached messages immediately
  var cached = OfflineStore.getCachedMessages(id);
  renderMessages(cached.length ? cached : []);
  renderOutboxPending(id);

  // Start polling for new messages from the email bridge
  startEmailPoll(id);
}

// Show pending outbox messages with a "pending" indicator
function renderOutboxPending(channelId) {
  const outbox = OfflineStore.getOutbox().filter(function(o) { return o.channelId === channelId; });
  if (!outbox.length) return;
  const area = document.getElementById('messagesArea');
  outbox.forEach(function(item) {
    const pendingMsg = Object.assign({}, item.msg, { pending: true });
    appendMessageEl(area, pendingMsg);
  });
  area.scrollTop = area.scrollHeight;
}

// RENDER MESSAGES
function msgDateLabel(msg) {
  // timestamp may be a Firestore Timestamp or null (pending write)
  var d = msg.timestamp && msg.timestamp.toDate ? msg.timestamp.toDate() : new Date();
  var today     = new Date();
  var yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  var toKey  = function(dt) { return dt.getFullYear() + '-' + dt.getMonth() + '-' + dt.getDate(); };
  if (toKey(d) === toKey(today))     return 'Today';
  if (toKey(d) === toKey(yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function renderMessages(msgs) {
  var area = document.getElementById('messagesArea');
  var wasAtBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 60;
  area.innerHTML = '';

  if (!msgs || msgs.length === 0) {
    area.innerHTML = '<div style="text-align:center;color:#aaa;margin-top:40px;font-size:14px;">No messages yet. Say hello!</div>';
    return;
  }

  // Pre-compute: for each user, find the ID of the LAST message they have seen
  // so we only show the seen avatar on that one message, not all previous ones
  var lastSeenMsgPerUser = {}; // { userName: msgId }
  msgs.forEach(function(msg) {
    if (!msg.seenBy) return;
    Object.keys(msg.seenBy).forEach(function(user) {
      if (user !== state.currentUser.name) {
        lastSeenMsgPerUser[user] = msg.id; // later messages overwrite earlier ones
      }
    });
  });

  var lastLabel = null;
  msgs.forEach(function(msg) {
    var label = msgDateLabel(msg);
    if (label !== lastLabel) {
      area.appendChild(makeDateDivider(label));
      lastLabel = label;
    }
    appendMessageEl(area, msg, lastSeenMsgPerUser);
  });
  if (wasAtBottom) area.scrollTop = area.scrollHeight;

  // Mark channel as seen by current user
  markChannelSeen(state.currentChannel, msgs);

  // After rendering, schedule clearing unread IDs
  setTimeout(function() {
    if (document.hasFocus()) {
      clearUnreadMsgIdsForChannel();
    }
  }, 3000);
}

// Clear unread msg IDs for messages currently visible in the channel
function clearUnreadMsgIdsForChannel() {
  var area = document.getElementById('messagesArea');
  if (!area) return;
  area.querySelectorAll('.sender-unread').forEach(function(el) {
    var msgId = el.id.replace('sender-', '');
    var senderName = el.textContent;
    state.unreadMsgIds.delete(msgId);
    var replacement = document.createElement('strong');
    replacement.textContent = senderName;
    if (el.parentNode) el.parentNode.replaceChild(replacement, el);
  });
}

function appendMessageEl(area, msg, lastSeenMsgPerUser) {
  const isMine   = msg.sender === state.currentUser.name;
  const isViaSms = !!msg.viaSms;
  const group    = document.createElement('div');
  group.className = 'msg-group' + (isMine ? ' mine' : '') + (isViaSms ? ' sms-msg' : '');
  if (msg.id) group.dataset.msgId = msg.id;

  // Only show avatar for OTHER users — own messages have no avatar/spacer
  const avatarInner = isViaSms ? '📱' : msg.sender[0].toUpperCase();
  const avatarHtml  = !isMine
    ? '<div class="msg-avatar' + (isViaSms ? ' sms-avatar' : '') + '" style="background:' + msg.color + '">' + avatarInner + '</div>'
    : ''; // no spacer — bubble aligns right via flex-direction:row-reverse

  // Quote block
  let quoteHtml = '';
  if (msg.quoteText) {
    quoteHtml = '<div class="msg-quote" onclick="scrollToMsg(\'' + (msg.quoteId || '') + '\')">' +
      '<strong>' + escapeHtml(msg.quoteSender || '') + '</strong>' +
      escapeHtml((msg.quoteText || '').slice(0, 120)) +
    '</div>';
  }

  let content = quoteHtml + (msg.text ? renderText(msg.text) : '');
  if (msg.fileUrl) {
    if (msg.fileType && msg.fileType.startsWith('image/')) {
      content += '<div class="msg-image"><img src="' + msg.fileUrl + '" alt="' + msg.file + '" onclick="window.open(\'' + msg.fileUrl + '\',\'_blank\')"></div>';
    } else {
      content += '<div class="msg-file"><a href="' + msg.fileUrl + '" target="_blank">Attachment: ' + msg.file + '</a></div>';
    }
  } else if (msg.file) {
    content += '<div class="msg-file">Attachment: ' + msg.file + '</div>';
  }

  const editedTag = msg.edited ? '<span class="msg-edited-tag">(edited)</span>' : '';

  const me = state.currentUser.name;
  const reactions = (msg.reactions || []).filter(function(r) { return r.count > 0; }).map(function(r) {
    var reacted = r.users && r.users.includes(me);
    return '<span class="reaction-chip' + (reacted ? ' reacted' : '') + '" onclick="addReaction(\'' + msg.id + '\',\'' + r.emoji + '\')" title="' + (reacted ? 'Remove reaction' : 'Add reaction') + '">' + r.emoji + ' ' + r.count + '</span>';
  }).join('');

  // SMS badge shown next to sender name
  const smsBadge = isViaSms
    ? '<span class="sms-badge">📱 SMS</span>'
    : '';

  // Pending badge for offline queued messages
  const pendingBadge = msg.pending
    ? '<span class="pending-badge">⏳ Pending</span>'
    : '';

  // Actions: SVG icons — elegant like Messenger
  var svgReply  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/></svg>';
  var svgLike   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14z"/><path d="M7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3"/></svg>';
  var svgHeart  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>';
  var svgLaugh  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';
  var svgEdit   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  var svgDelete = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>';

  const quoteAction  = msg.id && !msg.pending
    ? '<span class="ma-btn" onclick="quoteMessage(\'' + msg.id + '\')" title="Reply">' + svgReply + '</span>'
    : '';
  const editAction   = isMine && msg.id && !msg.pending
    ? '<span class="ma-btn" onclick="startEdit(\'' + msg.id + '\')" title="Edit">' + svgEdit + '</span>'
    : '';
  const deleteAction = isMine && msg.id
    ? '<span class="ma-btn ma-btn-danger" onclick="deleteMsg(\'' + msg.id + '\')" title="Delete">' + svgDelete + '</span>'
    : '';

  // Sender name — bold+orange if this message is unread, clickable to mark read
  var senderHtml = '';
  if (!isMine) {
    var isUnread = msg.id && state.unreadMsgIds.has(msg.id);
    if (isUnread) {
      senderHtml = '<strong class="sender-unread" id="sender-' + msg.id + '" onclick="markSenderRead(\'' + msg.id + '\',\'' + escapeHtml(msg.sender) + '\')" title="Click to mark as read">' + escapeHtml(msg.sender) + '</strong>' + smsBadge;
    } else {
      senderHtml = '<strong>' + escapeHtml(msg.sender) + '</strong>' + smsBadge;
    }
  }

  // Seen indicator — only show on the LAST message seen by each user
  var seenHtml = '';
  if (isMine && msg.id && lastSeenMsgPerUser) {
    // Collect users for whom THIS is their last-seen message
    var seenUsers = Object.keys(lastSeenMsgPerUser).filter(function(u) {
      return lastSeenMsgPerUser[u] === msg.id;
    });
    if (seenUsers.length > 0) {
      var seenAvatars = seenUsers.map(function(u) {
        var color = getUserColor(u);
        return '<span class="seen-avatar" style="background:' + color + '" title="Seen by ' + escapeHtml(u) + '">' + u[0].toUpperCase() + '</span>';
      }).join('');
      seenHtml = '<div class="seen-row">' + seenAvatars + '</div>';
    }
  }

  group.innerHTML =
    avatarHtml +
    '<div class="msg-content">' +
      '<div class="msg-meta">' +
        (isMine ? '' : senderHtml) +
        '<span>' + (msg.timestamp && msg.timestamp.toDate ? formatTime(msg.timestamp.toDate()) : msg.time) + '</span>' +
        editedTag +
        pendingBadge +
      '</div>' +
      '<div class="msg-bubble' + (isViaSms ? ' sms-bubble' : '') + (msg.pending ? ' pending-bubble' : '') + '" id="bubble-' + (msg.id || '') + '">' +
        content +
        '<div class="msg-actions">' +
          quoteAction +
          '<span class="ma-btn ma-btn-like" onclick="reactTo(\'' + msg.id + '\',\'👍\')" title="Like">' + svgLike + '</span>' +
          '<span class="ma-btn ma-btn-heart" onclick="reactTo(\'' + msg.id + '\',\'❤️\')" title="Love">' + svgHeart + '</span>' +
          '<span class="ma-btn ma-btn-laugh" onclick="reactTo(\'' + msg.id + '\',\'😂\')" title="Haha">' + svgLaugh + '</span>' +
          editAction +
          deleteAction +
        '</div>' +
      '</div>' +
      '<div class="reactions">' + reactions + '</div>' +
      seenHtml +
    '</div>';

  area.appendChild(group);

  // Mobile: tap bubble to toggle action buttons
  if ('ontouchstart' in window || window.innerWidth <= 640) {
    const bubble = group.querySelector('.msg-bubble');
    if (bubble) {
      bubble.addEventListener('click', function(e) {
        // Don't toggle if user tapped an action button or a link
        if (e.target.closest('.msg-actions') || e.target.tagName === 'A') return;
        const isMobile = window.innerWidth <= 640;
        if (!isMobile) return;
        // Close all other open bubbles first
        document.querySelectorAll('.msg-bubble.actions-open').forEach(function(b) {
          if (b !== bubble) b.classList.remove('actions-open');
        });
        bubble.classList.toggle('actions-open');
      });
    }
  }
}

function makeDateDivider(label) {
  const div = document.createElement('div');
  div.className   = 'date-divider';
  div.textContent = label;
  return div;
}

// SEND MESSAGE
async function sendMessage() {
  const input = document.getElementById('msgInput');
  const text  = input.value.trim();

  // If there's a pending file, upload it (with or without text)
  if (_pendingFile) {
    await uploadPendingFile();
  }

  if (!text) return;
  input.value = '';
  autoResize(input);

  const msg = {
    sender:    state.currentUser.name,
    color:     state.currentUser.color,
    text:      text,
    time:      formatTime(new Date()),
    reactions: [],
  };

  // Attach quote if set
  if (state.quoteMsg) {
    msg.quoteId     = state.quoteMsg.id || '';
    msg.quoteSender = state.quoteMsg.sender || '';
    msg.quoteText   = (state.quoteMsg.text || '').slice(0, 200);
    cancelQuote();
  }

  // ── EMAIL MODE: show optimistically, send via email bridge ──
  const optId = 'opt-' + Date.now();
  const optimisticMsg = Object.assign({}, msg, {
    id:        optId,
    timestamp: { toDate: function() { return new Date(); } },
    pending:   true,
  });
  const area = document.getElementById('messagesArea');
  appendMessageEl(area, optimisticMsg);
  area.scrollTop = area.scrollHeight;
  OfflineStore.appendCachedMessage(state.currentChannel, optimisticMsg);

  // Get recipients for this conversation
  var recipients = getRecipientsForConv(state.currentChannel);

  // Helper to clear pending style — searches by optId
  function clearPending(realId) {
    var el = document.querySelector('[data-msg-id="' + optId + '"]');
    if (!el) return;
    if (realId) el.dataset.msgId = realId;
    var bubble = el.querySelector('.msg-bubble');
    if (bubble) {
      bubble.classList.remove('pending-bubble');
      bubble.style.opacity = '1';
      bubble.style.borderStyle = '';
    }
    // Remove the pending badge span if present
    var badge = el.querySelector('.pending-badge');
    if (badge) badge.remove();
    el.style.opacity = '1';
    el.title = '✉️ Sent';
  }

  try {
    var result = await emailSendMessage(state.currentChannel, msg, recipients);
    clearPending(result && result.id);

    // Update cached message — remove pending flag
    var cached = OfflineStore.getCachedMessages(state.currentChannel);
    var idx = cached.findIndex(function(m) { return m.id === optId; });
    if (idx >= 0) {
      cached[idx].pending = false;
      if (result && result.id) cached[idx].id = result.id;
      OfflineStore.cacheMessages(state.currentChannel, cached);
    }

    // Update DM activity
    if (state.currentChannel.startsWith('dm-')) {
      state.dmLastActivity[state.currentChannel] = Date.now();
      renderDMsFromCache();
    }
  } catch (err) {
    var el = document.querySelector('[data-msg-id="' + optId + '"]');
    if (el) { el.style.opacity = '0.5'; el.title = 'Failed to send: ' + err.message; }
    OfflineStore.addToOutbox(state.currentChannel, msg);
    showSyncToast('⚠️ Send failed — queued for retry');
    console.error('[Email] Send failed:', err);
  }
}

function handleKey(e) {
  const isMobile = window.innerWidth <= 640 || ('ontouchstart' in window);
  if (e.key === 'Enter') {
    if (isMobile) {
      // On mobile: Enter always sends (use the ↵ button for new lines)
      e.preventDefault();
      sendMessage();
    } else {
      // On desktop: Enter sends, Shift+Enter = new line
      if (!e.shiftKey) { e.preventDefault(); sendMessage(); }
    }
  }
}

function insertNewline() {
  const input = document.getElementById('msgInput');
  const pos = input.selectionStart;
  input.value = input.value.slice(0, pos) + '\n' + input.value.slice(pos);
  input.selectionStart = input.selectionEnd = pos + 1;
  autoResize(input);
  input.focus();
}

function autoResize(el) {
  el.style.height = 'auto';
  const newHeight = Math.min(el.scrollHeight, 120);
  // If empty, let CSS/rows=1 handle the default height naturally
  el.style.height = (el.value === '' ? '' : newHeight + 'px');
}

// TYPING — debounced, local only in email mode (no server needed)
var _lastTypingText = '';
function showTyping() {
  // In email mode, typing indicators are local-only (no server broadcast)
  // Just update the local indicator for visual feedback
}

var _unsubscribeTyping = null;

function subscribeTyping(channelId) {
  // Email mode: no real-time typing broadcast — clear indicator
  if (_unsubscribeTyping) { _unsubscribeTyping(); _unsubscribeTyping = null; }
  var el = document.getElementById('typingIndicator');
  if (el) el.textContent = '';
}

// REACTIONS — per-user toggle (tap again to remove)
async function reactTo(msgId, emoji) {
  // Email mode: reactions are local-only (stored in cache)
  var me      = state.currentUser.name;
  var cached  = OfflineStore.getCachedMessages(state.currentChannel);
  var msg     = cached.find(function(m) { return m.id === msgId; });
  if (!msg) return;

  if (!msg.reactions) msg.reactions = [];
  var existing = msg.reactions.find(function(r) { return r.emoji === emoji; });
  if (existing) {
    if (!existing.users) existing.users = [];
    if (existing.users.includes(me)) {
      existing.users = existing.users.filter(function(u) { return u !== me; });
    } else {
      existing.users.push(me);
    }
    existing.count = existing.users.length;
    msg.reactions = msg.reactions.filter(function(r) { return r.count > 0; });
  } else {
    msg.reactions.push({ emoji: emoji, count: 1, users: [me] });
  }
  OfflineStore.cacheMessages(state.currentChannel, cached);

  // Re-render reactions chip on the bubble
  var bubble = document.getElementById('bubble-' + msgId);
  if (bubble) {
    var reactionsEl = bubble.parentNode.querySelector('.reactions');
    if (reactionsEl) {
      reactionsEl.innerHTML = msg.reactions.filter(function(r) { return r.count > 0; }).map(function(r) {
        var reacted = r.users && r.users.includes(me);
        return '<span class="reaction-chip' + (reacted ? ' reacted' : '') + '" onclick="addReaction(\'' + msgId + '\',\'' + r.emoji + '\')">' + r.emoji + ' ' + r.count + '</span>';
      }).join('');
    }
  }
}

function addReaction(msgId, emoji) { reactTo(msgId, emoji); }

// DELETE MESSAGE — with 5-second undo window
var _deleteTimers = {};

function deleteMsg(msgId) {
  var group = document.querySelector('[data-msg-id="' + msgId + '"]');
  if (group) group.style.opacity = '0.3';

  showUndoToast(msgId, function() {
    if (group) group.style.opacity = '';
    clearTimeout(_deleteTimers[msgId]);
    delete _deleteTimers[msgId];
  });

  _deleteTimers[msgId] = setTimeout(function() {
    delete _deleteTimers[msgId];
    if (group) group.remove();
    // Email mode: remove from local cache only
    var cached = OfflineStore.getCachedMessages(state.currentChannel);
    var updated = cached.filter(function(m) { return m.id !== msgId; });
    OfflineStore.cacheMessages(state.currentChannel, updated);
  }, 5000);
}

function showUndoToast(msgId, onUndo) {
  var toast = document.getElementById('undoToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'undoToast';
    toast.className = 'undo-toast';
    document.body.appendChild(toast);
  }

  // Clear any existing timer on the toast itself
  clearTimeout(toast._hideTimer);

  toast.innerHTML =
    '<span>Message deleted</span>' +
    '<button class="undo-btn" id="undoBtn">Undo</button>';

  document.getElementById('undoBtn').onclick = function() {
    onUndo();
    toast.classList.remove('show');
  };

  toast.classList.remove('show');
  void toast.offsetWidth; // reflow to restart animation
  toast.classList.add('show');

  toast._hideTimer = setTimeout(function() {
    toast.classList.remove('show');
  }, 5000);
}

// FILE ATTACH — preview before send
var _pendingFile = null;

function cancelFileAttach() {
  _pendingFile = null;
  document.getElementById('filePreviewBar').style.display = 'none';
  document.getElementById('filePreviewInner').innerHTML = '';
  document.getElementById('fileInput').value = '';
}

async function attachFile(input) {
  if (!input.files.length) return;
  const file = input.files[0];
  _pendingFile = file;

  // Show preview
  const bar   = document.getElementById('filePreviewBar');
  const inner = document.getElementById('filePreviewInner');
  bar.style.display = 'flex';

  if (file.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = function(e) {
      inner.innerHTML =
        '<img src="' + e.target.result + '" class="fp-img" alt="' + escapeHtml(file.name) + '">' +
        '<span class="fp-name">' + escapeHtml(file.name) + '</span>';
    };
    reader.readAsDataURL(file);
  } else {
    inner.innerHTML =
      '<span class="fp-icon">📎</span>' +
      '<span class="fp-name">' + escapeHtml(file.name) + '</span>' +
      '<span class="fp-size">(' + formatFileSize(file.size) + ')</span>';
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1048576)    return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

async function uploadPendingFile() {
  if (!_pendingFile) return;
  const file = _pendingFile;
  const isImage = file.type.startsWith('image/');
  cancelFileAttach();

  // ── Email mode: show file as data URL locally, send via email ──
  const area   = document.getElementById('messagesArea');
  const tempId = 'temp-' + Date.now();

  const reader = new FileReader();
  reader.onload = async function(e) {
    const dataUrl = e.target.result;
    const tempMsg = {
      id:        tempId,
      sender:    state.currentUser.name,
      color:     state.currentUser.color,
      text:      '',
      file:      file.name,
      fileUrl:   dataUrl,
      fileType:  file.type,
      time:      formatTime(new Date()),
      timestamp: { toDate: function() { return new Date(); } },
      reactions: [],
      pending:   true,
    };
    appendMessageEl(area, tempMsg);
    area.scrollTop = area.scrollHeight;

    // Send via email bridge with file data embedded
    try {
      var recipients = getRecipientsForConv(state.currentChannel);
      await emailSendMessage(state.currentChannel, {
        text:    '[File: ' + file.name + ']',
        sender:  state.currentUser.name,
        color:   state.currentUser.color,
      }, recipients);
      var tempEl = document.querySelector('[data-msg-id="' + tempId + '"]');
      if (tempEl) {
        var bubble = tempEl.querySelector('.msg-bubble');
        if (bubble) bubble.classList.remove('pending-bubble');
        tempEl.title = '✉️ Sent via email';
      }
      OfflineStore.appendCachedMessage(state.currentChannel, Object.assign({}, tempMsg, { id: 'sent-' + Date.now(), pending: false }));
    } catch (err) {
      var tempEl = document.querySelector('[data-msg-id="' + tempId + '"]');
      if (tempEl) { tempEl.style.opacity = '0.5'; tempEl.title = 'Send failed: ' + err.message; }
    }
    document.getElementById('typingIndicator').textContent = '';
  };
  reader.readAsDataURL(file);
}

// ── EMOJI PICKER ─────────────────────────────────────────────
var _emojiRecent = JSON.parse(localStorage.getItem('mhc_recent_emoji') || '[]');

var _emojiData = {
  recent:   [], // filled dynamically
  smileys:  ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🥰','😘','😗','😙','😚','🙂','🤗','🤩','🤔','🤨','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯','😪','😫','🥱','😴','😌','😛','😜','😝','🤤','😒','😓','😔','😕','🙃','🤑','😲','☹️','🙁','😖','😞','😟','😤','😢','😭','😦','😧','😨','😩','🤯','😬','😰','😱','🥵','🥶','😳','🤪','😵','🥴','😠','😡','🤬','😷','🤒','🤕','🤢','🤮','🤧','🥳','🥺','🤠','🤡','🤥','🤫','🤭','🧐','🤓'],
  gestures: ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🫀','🫁','🧠','🦷','🦴','👀','👁️','👅','👄'],
  hearts:   ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉️','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','🉑','☢️','☣️','📴','📳','🈶','🈚','🈸','🈺','🈷️','✴️','🆚','💮','🉐','㊙️','㊗️','🈴','🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘'],
  nature:   ['🌱','🌿','🍀','🌾','🌵','🌲','🌳','🌴','🌸','🌺','🌻','🌹','🥀','🌷','🌼','💐','🍄','🌰','🦔','🐾','🌍','🌎','🌏','🌑','🌒','🌓','🌔','🌕','🌖','🌗','🌘','🌙','🌚','🌛','🌜','🌝','🌞','⭐','🌟','💫','✨','⚡','🌈','☀️','🌤️','⛅','🌥️','☁️','🌦️','🌧️','⛈️','🌩️','🌨️','❄️','☃️','⛄','🌬️','💨','🌀','🌊','🌫️','🌁'],
  food:     ['🍎','🍊','🍋','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🫑','🧄','🧅','🥔','🍠','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔','🍟','🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘','🫕','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥮','🍢','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','🧃','🥤','🧋','☕','🍵','🫖','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🧉','🍾'],
  activity: ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🏓','🏸','🏒','🏑','🥍','🏏','🪃','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸️','🥌','🎿','⛷️','🏂','🪂','🏋️','🤼','🤸','⛹️','🤺','🏇','🧘','🏄','🏊','🤽','🚣','🧗','🚵','🚴','🏆','🥇','🥈','🥉','🏅','🎖️','🏵️','🎗️','🎫','🎟️','🎪','🤹','🎭','🩰','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🪘','🎷','🎺','🎸','🪕','🎻','🎲','♟️','🎯','🎳','🎮','🎰','🧩'],
  symbols:  ['💯','🔔','🔕','🎵','🎶','💤','🔇','🔈','🔉','🔊','📢','📣','📯','🔔','🔕','🎼','💹','📈','📉','📊','✅','❌','❎','🔱','📛','🔰','⭕','✳️','❇️','💠','🆗','🆙','🆒','🆕','🆓','0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','🔠','🔡','🔢','🔣','🔤','🅰️','🅱️','🆎','🆑','🅾️','🆘','⛔','🚫','🚳','🚭','🚯','🚱','🚷','📵','🔞','☢️','☣️','⬆️','↗️','➡️','↘️','⬇️','↙️','⬅️','↖️','↕️','↔️','↩️','↪️','⤴️','⤵️','🔃','🔄','🔙','🔚','🔛','🔜','🔝','🛐','⚛️','🕉️','✡️','☸️','☯️','✝️','☦️','☪️','☮️','🕎','🔯'],
};

var _currentEmojiCat = 'recent';

function toggleEmojiPicker() {
  var picker = document.getElementById('emojiPicker');
  var btn    = document.querySelector('.emoji-btn');
  var isOpen = picker.classList.contains('show');

  if (isOpen) {
    picker.classList.remove('show');
    return;
  }

  // Position picker above the emoji button
  if (btn) {
    var rect = btn.getBoundingClientRect();
    var pickerW = Math.min(320, window.innerWidth - 20);
    var left = Math.max(8, rect.right - pickerW);
    var bottom = window.innerHeight - rect.top + 8;
    picker.style.left   = left + 'px';
    picker.style.bottom = bottom + 'px';
    picker.style.right  = 'auto';
    picker.style.width  = pickerW + 'px';
  }

  picker.classList.add('show');
  // Populate on open
  _emojiData.recent = _emojiRecent.slice(0, 32);
  var cat = _emojiData.recent.length > 0 ? 'recent' : 'smileys';
  var tabs = document.querySelectorAll('.ep-tab');
  tabs.forEach(function(t) { t.classList.remove('active'); });
  tabs[_emojiData.recent.length > 0 ? 0 : 1].classList.add('active');
  _currentEmojiCat = cat;
  renderEmojiGrid(_emojiData[cat]);
  document.getElementById('epSearch').value = '';
  setTimeout(function() { document.getElementById('epSearch').focus(); }, 50);
}

function showEmojiCat(btn, cat) {
  document.querySelectorAll('.ep-tab').forEach(function(t) { t.classList.remove('active'); });
  btn.classList.add('active');
  _currentEmojiCat = cat;
  document.getElementById('epSearch').value = '';
  _emojiData.recent = _emojiRecent.slice(0, 32);
  renderEmojiGrid(_emojiData[cat]);
}

function renderEmojiGrid(list) {
  var grid = document.getElementById('epGrid');
  grid.innerHTML = '';
  if (!list || list.length === 0) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:20px;font-size:12px;">No emoji found</div>';
    return;
  }
  list.forEach(function(em) {
    var span = document.createElement('span');
    span.className = 'ep-emoji';
    span.textContent = em;
    span.title = em;
    span.onclick = function() { insertEmoji(em); };
    grid.appendChild(span);
  });
}

function filterEmoji(query) {
  if (!query.trim()) {
    _emojiData.recent = _emojiRecent.slice(0, 32);
    renderEmojiGrid(_emojiData[_currentEmojiCat]);
    return;
  }
  // Search across all categories
  var all = [];
  Object.keys(_emojiData).forEach(function(cat) {
    if (cat !== 'recent') all = all.concat(_emojiData[cat]);
  });
  // Simple filter: show emojis that match the query by unicode name lookup
  // Since we can't do name lookup easily, show all and let user scroll
  renderEmojiGrid(all.slice(0, 64));
}

function insertEmoji(emoji) {
  var input = document.getElementById('msgInput');
  var pos   = input.selectionStart || input.value.length;
  input.value = input.value.slice(0, pos) + emoji + input.value.slice(pos);
  input.selectionStart = input.selectionEnd = pos + emoji.length;
  autoResize(input);
  input.focus();
  // Track recent
  _emojiRecent = _emojiRecent.filter(function(e) { return e !== emoji; });
  _emojiRecent.unshift(emoji);
  if (_emojiRecent.length > 32) _emojiRecent.length = 32;
  localStorage.setItem('mhc_recent_emoji', JSON.stringify(_emojiRecent));
  document.getElementById('emojiPicker').classList.remove('show');
}

// SIDEBAR / MEMBERS
function toggleSidebar() {
  const isMobile = window.innerWidth <= 640;
  if (isMobile) {
    // On mobile: hamburger = back button — go back to conversation list
    closeSidebarMobile();
  } else {
    document.getElementById('sidebar').classList.toggle('collapsed');
  }
}

function closeSidebarMobile() {
  document.body.classList.remove('chat-open');
  // Update hamburger to show app icon / menu (not back arrow)
  updateHamburgerIcon(false);
}

// Mobile: handle browser back button to return to conversation list
window.addEventListener('popstate', function() {
  if (window.innerWidth <= 640 && document.body.classList.contains('chat-open')) {
    closeSidebarMobile();
  }
});

// Push a history state when opening a chat on mobile so back button works
function openChatMobile() {
  document.body.classList.add('chat-open');
  updateHamburgerIcon(true);
  // Push state so browser back button works
  if (window.innerWidth <= 640) {
    history.pushState({ chatOpen: true }, '');
  }
}

function updateHamburgerIcon(isChatOpen) {
  var btn = document.querySelector('.hamburger');
  if (!btn) return;
  if (window.innerWidth > 640) return;
  btn.textContent = isChatOpen ? '←' : '☰';
  btn.title = isChatOpen ? 'Back to chats' : 'Menu';
}

// Close sidebar when a channel is tapped on mobile
function loadChannelAndCloseSidebar(id, title, desc) {
  loadChannel(id, title, desc);
  if (window.innerWidth <= 640) {
    openChatMobile();
  }
}

function toggleMembers()  { document.getElementById('membersPanel').classList.toggle('open'); }

function filterChannels(val) {
  renderChannels(val);
  // Use cached users — no Firestore read on every keystroke
  var cached = OfflineStore.getCachedUsers();
  renderDMs(cached, val);
}

// ============================================================
//  CHANNEL MANAGEMENT
// ============================================================
var ctxChannelId     = null;
var channelModalMode = 'add';

// Open context menu
function openChannelCtxMenu(e, channelId) {
  e.stopPropagation();
  ctxChannelId = channelId;
  const menu = document.getElementById('channelCtxMenu');
  menu.classList.add('show');
  const x = Math.min(e.clientX, window.innerWidth  - 200);
  const y = Math.min(e.clientY, window.innerHeight - 130);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function closeCtxMenu() {
  document.getElementById('channelCtxMenu').classList.remove('show');
}

function ctxRename() {
  const id = ctxChannelId;
  closeCtxMenu();
  openChannelModal('rename', id);
}

function ctxManage() {
  const id = ctxChannelId;
  closeCtxMenu();
  openChannelModal('participants', id);
}

async function ctxDelete() {
  const id = ctxChannelId;
  closeCtxMenu();
  const ch = channels.find(function(c) { return c.id === id; });
  if (!ch) return;
  if (!confirm('Delete "' + ch.label + '"? This cannot be undone.')) return;
  channels.splice(channels.indexOf(ch), 1);
  // Email mode: save updated channel list locally
  OfflineStore.saveEmailChannels(channels.slice());
  var firstCh = channels[0];
  if (state.currentChannel === id) loadChannel(firstCh ? firstCh.id : 'ch-general');
  renderChannels();
}

// Add channel button
function openAddChannelModal() {
  openChannelModal('add', null);
}

// ── MEMBER CONTEXT MENU ──────────────────────────────────────
var _ctxMemberUser = null;

function openMemberCtxMenu(e, user) {
  _ctxMemberUser = user;
  const menu = document.getElementById('memberCtxMenu');
  menu.classList.add('show');
  const x = Math.min(e.clientX, window.innerWidth  - 220);
  const y = Math.min(e.clientY, window.innerHeight - 80);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function closeMemberCtxMenu() {
  document.getElementById('memberCtxMenu').classList.remove('show');
  _ctxMemberUser = null;
}

async function ctxRemoveMember() {
  const u = _ctxMemberUser;
  closeMemberCtxMenu();
  if (!u) return;

  const isSelf = u.name === state.currentUser.name;
  const confirmMsg = isSelf
    ? 'Remove your own account and clear all your chat history? This cannot be undone.'
    : 'Remove "' + u.name + '" and delete all their chat history across all channels? This cannot be undone.';

  if (!confirm(confirmMsg)) return;

  // Email mode: remove from local cache only
  const allChannelIds = channels.map(function(c) { return c.id; });
  allChannelIds.forEach(function(chId) {
    const cached  = OfflineStore.getCachedMessages(chId);
    const filtered = cached.filter(function(m) { return m.sender !== u.name; });
    OfflineStore.cacheMessages(chId, filtered);
  });

  OfflineStore.removeCachedUser(u.id || u.email);

  if (isSelf) {
    sessionStorage.removeItem('teamsUser');
    window.location.href = 'index.html';
    return;
  }

  loadChannel(state.currentChannel);
  showSyncToast('✓ ' + u.name + ' removed from local view.');
}

// Open modal
async function openChannelModal(mode, channelId) {
  channelModalMode = mode;
  ctxChannelId     = channelId || null;

  const nameInput = document.getElementById('channelNameInput');
  const descInput = document.getElementById('channelDescInput');
  const nameGroup = nameInput.closest('.form-group');
  const descGroup = descInput.closest('.form-group');
  document.getElementById('channelModalError').textContent = '';

  const ch = channelId ? channels.find(function(c) { return c.id === channelId; }) : null;

  if (mode === 'add') {
    document.getElementById('channelModalTitle').textContent   = 'Add Channel';
    document.getElementById('channelModalSaveBtn').textContent = 'Create';
    nameInput.value = '';
    descInput.value = '';
    nameGroup.style.display = '';
    descGroup.style.display = '';
  } else if (mode === 'rename') {
    document.getElementById('channelModalTitle').textContent   = 'Rename Channel';
    document.getElementById('channelModalSaveBtn').textContent = 'Save';
    nameInput.value = ch ? ch.label.replace(/^[#]\s*/, '') : '';
    descInput.value = ch ? ch.desc || '' : '';
    nameGroup.style.display = '';
    descGroup.style.display = '';
  } else {
    document.getElementById('channelModalTitle').textContent   = 'Manage Participants';
    document.getElementById('channelModalSaveBtn').textContent = 'Save';
    nameGroup.style.display = 'none';
    descGroup.style.display = 'none';
  }

  await buildParticipantsList(channelId);
  document.getElementById('channelModal').classList.add('show');
}

// Build participants checklist — uses locally cached users in email mode
async function buildParticipantsList(channelId) {
  const container = document.getElementById('participantsList');
  container.innerHTML = '';

  var allUsers = OfflineStore.getAllEmailUsers ? OfflineStore.getAllEmailUsers() : OfflineStore.getCachedUsers();
  var ch = channels.find(function(c) { return c.id === channelId; });
  var currentParticipants = (ch && ch.participants) ? ch.participants : [];

  if (!allUsers.length) {
    container.innerHTML = '<div style="padding:8px;color:#aaa;font-size:13px">No users found. Other users appear here after they log in.</div>';
    return;
  }

  allUsers.forEach(function(u, idx) {
    var checked = currentParticipants.length === 0 || currentParticipants.includes(u.email || u.name);
    var row = document.createElement('div');
    row.className = 'participant-row';
    row.innerHTML =
      '<input type="checkbox" id="pcheck_' + idx + '" value="' + (u.email || u.name) + '" ' + (checked ? 'checked' : '') + '>' +
      '<div class="p-avatar" style="background:' + (u.color || '#6264a7') + '">' + (u.name || u.email)[0].toUpperCase() + '</div>' +
      '<label for="pcheck_' + idx + '" style="cursor:pointer;flex:1">' + escapeHtml(u.name || u.email) + '</label>' +
      '<span style="font-size:11px;color:var(--text-muted)">' + (u.email || '') + '</span>';
    container.appendChild(row);
  });
}

function closeChannelModal() {
  document.getElementById('channelModal').classList.remove('show');
}

// Save channel
async function saveChannel() {
  const errEl        = document.getElementById('channelModalError');
  const nameVal      = document.getElementById('channelNameInput').value.trim();
  const descVal      = document.getElementById('channelDescInput').value.trim();
  const participants = Array.from(document.querySelectorAll('#participantsList input[type="checkbox"]:checked'))
    .map(function(cb) { return cb.value; });

  if (channelModalMode === 'add') {
    if (!nameVal) { errEl.textContent = 'Channel name is required.'; return; }
    const id = nameVal.toLowerCase().replace(/\s+/g, '-');
    if (channels.find(function(c) { return c.id === id; })) {
      errEl.textContent = 'A channel with that name already exists.';
      return;
    }
    const label = '# ' + nameVal;
    const desc  = descVal || nameVal;
    // Email mode: save channel locally only
    var newCh = { id: id, label: label, desc: desc, custom: true, participants: participants };
    channels.push(newCh);
    OfflineStore.upsertEmailChannel(newCh);
    closeChannelModal();
    renderChannels();
    loadChannel(id);

  } else if (channelModalMode === 'rename') {
    if (!nameVal) { errEl.textContent = 'Channel name is required.'; return; }
    const ch = channels.find(function(c) { return c.id === ctxChannelId; });
    if (ch) {
      ch.label = '# ' + nameVal;
      ch.desc  = descVal || nameVal;
      ch.participants = participants;
      OfflineStore.upsertEmailChannel(ch);
      if (state.currentChannel === ch.id) {
        document.getElementById('channelTitle').textContent = ch.label;
        document.getElementById('channelDesc').textContent  = ch.desc;
      }
      closeChannelModal();
      renderChannels();
    }

  } else if (channelModalMode === 'participants') {
    if (ctxChannelId) {
      var ch2 = channels.find(function(c) { return c.id === ctxChannelId; });
      if (ch2) { ch2.participants = participants; OfflineStore.upsertEmailChannel(ch2); }
    }
    closeChannelModal();
  }
}

// SETTINGS
function toggleSettings() {
  document.getElementById('settingName').value   = state.currentUser.name;
  document.getElementById('settingStatus').value = state.currentUser.status;
  // Populate mobile number field
  var mobileInput = document.getElementById('settingMobile');
  if (mobileInput) mobileInput.value = state.currentUser.mobile || '';

  // Restore current avatar into the preview inside the modal
  var previewImg     = document.getElementById('avatarPreviewImg');
  var previewInitial = document.getElementById('avatarPreviewInitial');
  if (state.currentUser.avatarUrl) {
    if (previewImg) { previewImg.src = state.currentUser.avatarUrl; previewImg.style.display = 'block'; }
    if (previewInitial) previewInitial.style.display = 'none';
  } else {
    if (previewImg) { previewImg.src = ''; previewImg.style.display = 'none'; }
    if (previewInitial) {
      previewInitial.textContent = state.currentUser.name[0].toUpperCase();
      previewInitial.style.display = '';
    }
  }

  document.getElementById('settingsModal').classList.add('show');

  // Show/hide remove button based on whether there's a current avatar
  var removeBtn = document.getElementById('removeAvatarBtn');
  if (removeBtn) removeBtn.style.display = state.currentUser.avatarUrl ? 'inline-block' : 'none';
}
function closeSettings() { document.getElementById('settingsModal').classList.remove('show'); }

async function saveSettings() {
  const newName  = document.getElementById('settingName').value.trim();
  const status   = document.getElementById('settingStatus').value;
  const mobileEl = document.getElementById('settingMobile');
  const mobile   = mobileEl ? normalizeMobile(mobileEl.value.trim()) : '';

  if (newName) state.currentUser.name = newName;
  state.currentUser.status = status;
  if (mobile) state.currentUser.mobile = mobile;
  else delete state.currentUser.mobile;

  updateStatusDisplay(status);
  document.getElementById('myName').textContent = state.currentUser.name;
  document.getElementById('myAvatarInitial').textContent = state.currentUser.name[0].toUpperCase();
  sessionStorage.setItem('teamsUser', JSON.stringify(state.currentUser));

  // Email mode: save locally only (no Firestore)
  OfflineStore.upsertCachedUser(Object.assign({}, state.currentUser));
  if (OfflineStore.upsertCachedEmailUser) {
    OfflineStore.upsertCachedEmailUser({ email: state.currentUser.email || state.currentUser.id, name: state.currentUser.name, color: state.currentUser.color });
  }

  // Push updated user list to SMS bridge
  syncUsersToBridge();

  // Mark mobile as linked so prompt doesn't show again
  if (mobile) localStorage.setItem('pc_mobile_linked', '1');

  document.getElementById('settingsSaveMsg').textContent = 'Saved ✓';
  setTimeout(function() {
    document.getElementById('settingsSaveMsg').textContent = '';
    closeSettings();
  }, 1000);
}

function updateStatusDisplay(status) {
  const el     = document.querySelector('.user-status');
  const labels = { online: '● Online', away: '● Away', busy: '● Busy', offline: '● Offline' };
  el.textContent = labels[status] || '● Online';
  el.className   = 'user-status ' + status;
}

// ── MOBILE NUMBER HELPERS ─────────────────────────────────────
function normalizeMobile(raw) {
  if (!raw) return '';
  var p = raw.replace(/[\s\-().]/g, '');
  // Auto-prefix +63 for Philippine numbers
  if (p.startsWith('09') && p.length === 11) p = '+63' + p.slice(1);
  if (/^9\d{9}$/.test(p))                    p = '+63' + p;
  return p;
}

function updateMobileLinkedBadge() {
  var nameEl = document.getElementById('myName');
  if (!nameEl) return;
  var existing = document.getElementById('mobileBadge');
  if (state.currentUser.mobile) {
    if (!existing) {
      var badge = document.createElement('div');
      badge.id = 'mobileBadge';
      badge.className = 'mobile-linked-badge';
      badge.title = 'SMS: ' + state.currentUser.mobile;
      badge.textContent = '📱 ' + state.currentUser.mobile;
      nameEl.parentNode.insertBefore(badge, nameEl.nextSibling);
    } else {
      existing.textContent = '📱 ' + state.currentUser.mobile;
      existing.title = 'SMS: ' + state.currentUser.mobile;
    }
  } else {
    if (existing) existing.remove();
  }
}

// Show the one-time mobile number prompt on mobile devices
function checkMobilePrompt() {
  // Only show on mobile browsers
  var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (!isMobile) return;

  // Don't show if already linked or dismissed permanently
  if (localStorage.getItem('pc_mobile_linked')) return;
  if (localStorage.getItem('pc_mobile_skip_count') >= 3) return;

  // Don't show if user already has a mobile number saved
  if (state.currentUser.mobile) {
    localStorage.setItem('pc_mobile_linked', '1');
    return;
  }

  // Show after a short delay so the app loads first
  setTimeout(function() {
    var modal = document.getElementById('mobilePromptModal');
    if (modal) modal.classList.add('show');
    var input = document.getElementById('mobilePromptInput');
    if (input) setTimeout(function() { input.focus(); }, 300);
  }, 2000);
}

function formatMobilePromptInput(input) {
  // Strip non-numeric except leading +
  var val = input.value;
  var hasPlus = val.startsWith('+');
  var digits = val.replace(/\D/g, '');
  input.value = (hasPlus ? '+' : '') + digits;
}

function dismissMobilePrompt() {
  var modal = document.getElementById('mobilePromptModal');
  if (modal) modal.classList.remove('show');
  // Track skip count — after 3 skips, stop showing
  var skips = parseInt(localStorage.getItem('pc_mobile_skip_count') || '0') + 1;
  localStorage.setItem('pc_mobile_skip_count', String(skips));
}

async function saveMobileFromPrompt() {
  var input  = document.getElementById('mobilePromptInput');
  var errEl  = document.getElementById('mobilePromptError');
  var btn    = document.getElementById('mobilePromptSaveBtn');
  var raw    = input ? input.value.trim() : '';
  var mobile = normalizeMobile(raw);

  errEl.textContent = '';

  if (!mobile || mobile.length < 8) {
    errEl.textContent = 'Enter a valid mobile number with country code.';
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Saving…';

  // Save to state and storage
  state.currentUser.mobile = mobile;
  sessionStorage.setItem('teamsUser', JSON.stringify(state.currentUser));
  OfflineStore.upsertCachedUser(Object.assign({}, state.currentUser));
  localStorage.setItem('pc_mobile_linked', '1');

  // Email mode: save mobile locally only
  if (mobile) {
    localStorage.setItem('pc_mobile_linked', '1');
  }

  // Push to SMS bridge immediately
  syncUsersToBridge();

  // Close modal
  var modal = document.getElementById('mobilePromptModal');
  if (modal) modal.classList.remove('show');

  // Show confirmation toast
  showSyncToast('📱 Mobile number linked: ' + mobile);

  btn.disabled    = false;
  btn.textContent = '💾 Save & Link';
}

// ── AVATAR PREVIEW & UPLOAD ──────────────────────────────────
function previewAvatar(input) {
  if (!input.files || !input.files[0]) return;
  const file   = input.files[0];
  const reader = new FileReader();
  reader.onload = function(e) {
    const previewImg     = document.getElementById('avatarPreviewImg');
    const previewInitial = document.getElementById('avatarPreviewInitial');
    if (previewImg) { previewImg.src = e.target.result; previewImg.style.display = 'block'; }
    if (previewInitial) previewInitial.style.display = 'none';
    const myAvatarImg     = document.getElementById('myAvatarImg');
    const myAvatarInitial = document.getElementById('myAvatarInitial');
    if (myAvatarImg) { myAvatarImg.src = e.target.result; myAvatarImg.style.display = 'block'; }
    if (myAvatarInitial) myAvatarInitial.style.display = 'none';
    var removeBtn = document.getElementById('removeAvatarBtn');
    if (removeBtn) removeBtn.style.display = 'inline-block';

    // Email mode: store avatar as data URL locally (no Firebase Storage)
    state.currentUser.avatarUrl = e.target.result;
    sessionStorage.setItem('teamsUser', JSON.stringify(state.currentUser));
    OfflineStore.upsertCachedUser(Object.assign({}, state.currentUser));
    if (OfflineStore.upsertCachedEmailUser) {
      OfflineStore.upsertCachedEmailUser({ email: state.currentUser.email || state.currentUser.id, avatarUrl: e.target.result });
    }
  };
  reader.readAsDataURL(file);
}

// Remove profile photo
function removeAvatar() {
  if (!confirm('Remove your profile photo?')) return;

  var previewImg     = document.getElementById('avatarPreviewImg');
  var previewInitial = document.getElementById('avatarPreviewInitial');
  if (previewImg) { previewImg.src = ''; previewImg.style.display = 'none'; }
  if (previewInitial) { previewInitial.textContent = state.currentUser.name[0].toUpperCase(); previewInitial.style.display = ''; }

  var myAvatarImg     = document.getElementById('myAvatarImg');
  var myAvatarInitial = document.getElementById('myAvatarInitial');
  if (myAvatarImg) { myAvatarImg.src = ''; myAvatarImg.style.display = 'none'; }
  if (myAvatarInitial) myAvatarInitial.style.display = '';

  var removeBtn = document.getElementById('removeAvatarBtn');
  if (removeBtn) removeBtn.style.display = 'none';

  // Email mode: clear locally only
  delete state.currentUser.avatarUrl;
  sessionStorage.setItem('teamsUser', JSON.stringify(state.currentUser));
  OfflineStore.upsertCachedUser(Object.assign({}, state.currentUser));

  var avatarInput = document.getElementById('avatarInput');
  if (avatarInput) avatarInput.value = '';
}

// LOGOUT
async function logout() {
  // Email mode: notify bridge of logout (best-effort)
  try {
    await fetch(EMAIL_BRIDGE_URL + '/auth/logout', {
      method:  'POST',
      headers: emailHeaders(),
      signal:  AbortSignal.timeout(2000),
    });
  } catch (e) {}

  stopSmsPoll();
  stopChatPoll();
  stopAllEmailPolls();
  if (_unsubscribeTyping) { _unsubscribeTyping(); _unsubscribeTyping = null; }
  state.unsubscribeNotifs.forEach(function(u) { u(); });
  state.unsubscribeNotifs = [];
  sessionStorage.removeItem('teamsUser');
  window.location.href = 'index.html';
}

async function markOffline() {
  // Email mode: no Firestore status update needed
}

// VIDEO CALL
function openVideoCall() {
  document.getElementById('callModal').classList.add('show');
  setTimeout(function() {
    document.getElementById('callStatus').textContent  = 'Connected';
    document.getElementById('remoteLabel').textContent = 'Waiting for others to join...';
  }, 2000);
}
function closeCall() { document.getElementById('callModal').classList.remove('show'); }
function toggleMic(btn) {
  btn.classList.toggle('muted');
  btn.textContent = btn.classList.contains('muted') ? '🔇' : '🎤';
}
function toggleCam(btn) {
  btn.classList.toggle('cam-off');
  btn.textContent = btn.classList.contains('cam-off') ? '🚫' : '📷';
}

// UTILS
function formatTime(d) { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Convert URLs in already-escaped text to clickable links
function linkify(escapedText) {
  // Match http/https URLs (already HTML-escaped so & is &amp; etc.)
  var urlPattern = /(https?:\/\/[^\s<>"']+)/g;
  return escapedText.replace(urlPattern, function(url) {
    // Decode &amp; back for the href attribute
    var href = url.replace(/&amp;/g, '&');
    return '<a href="' + href + '" target="_blank" rel="noopener noreferrer" class="msg-link">' + url + '</a>';
  });
}

// Escape HTML then convert newlines and linkify
function renderText(str) {
  if (!str) return '';
  // Detect if text is already HTML-escaped (legacy messages stored with escapeHtml)
  // by checking for common escape sequences — if found, don't double-escape
  var alreadyEscaped = /&amp;|&lt;|&gt;/.test(str);
  var escaped = alreadyEscaped ? str : escapeHtml(str);
  // Convert newlines to <br>
  escaped = escaped.replace(/\n/g, '<br>');
  // Make URLs clickable
  return linkify(escaped);
}

// Get a user's color from cache (for seen avatars)
function getUserColor(name) {
  var users = OfflineStore.getCachedUsers();
  var u = users.find(function(u) { return u.name === name; });
  return u ? u.color : '#6264a7';
}

// Mark this channel as seen by current user — debounced, max 1 write per 30s per channel
var _seenWriteTimers = {};
function markChannelSeen(channelId, msgs) {
  // Email mode: mark seen locally only
  state.unread[channelId] = 0;
}

function updateTabTitle() {
  var total = Object.values(state.unread).reduce(function(sum, n) { return sum + n; }, 0);
  document.title = total > 0 ? '(' + total + ') MyHome Connect' : 'MyHome Connect';
  updateFavicon(total > 0);
  updateTaskbarBadge(total);
}

// ── TASKBAR BADGE (PWA Badging API) ──────────────────────────
function updateTaskbarBadge(count) {
  if (!('setAppBadge' in navigator)) return;
  if (count > 0) {
    navigator.setAppBadge(count).catch(function() {});
  } else {
    navigator.clearAppBadge().catch(function() {});
  }
}

// ── FAVICON ──────────────────────────────────────────────────
function updateFavicon(hasUnread) {
  var canvas = document.createElement('canvas');
  canvas.width  = 32;
  canvas.height = 32;
  var ctx = canvas.getContext('2d');

  // Background circle
  ctx.beginPath();
  ctx.arc(16, 16, 16, 0, Math.PI * 2);
  ctx.fillStyle = hasUnread ? '#f07800' : '#6264a7';
  ctx.fill();

  // Letter P
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 18px Segoe UI, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('P', 16, 17);

  // Red dot badge when unread
  if (hasUnread) {
    ctx.beginPath();
    ctx.arc(26, 6, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#ff3b30';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9px Segoe UI, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', 26, 6);
  }

  // Apply to favicon — remove old, create new (forces browser refresh)
  var existing = document.getElementById('favicon');
  if (existing) existing.remove();
  var link = document.createElement('link');
  link.id   = 'favicon';
  link.rel  = 'icon';
  link.type = 'image/png';
  link.href = canvas.toDataURL('image/png');
  document.head.appendChild(link);
}

// Clear tab title when window regains focus
window.addEventListener('focus', function() {
  state.unread[state.currentChannel] = 0;
  state.unreadSenders[state.currentChannel] = new Set();
  state.lastSender[state.currentChannel] = null;
  renderChannels();
  renderDMsFromCache();
  updateTabTitle();
  updateFavicon(false);
  setTimeout(clearUnreadMsgIdsForChannel, 500);
});

// ── CONVERSATION SEARCH ──
function toggleConvSearch() {
  var bar = document.getElementById('convSearchBar');
  bar.classList.toggle('show');
  if (bar.classList.contains('show')) {
    document.getElementById('convSearchInput').focus();
  } else {
    closeConvSearch();
  }
}

function closeConvSearch() {
  var bar = document.getElementById('convSearchBar');
  bar.classList.remove('show');
  document.getElementById('convSearchInput').value = '';
  document.getElementById('convSearchCount').textContent = '';
  clearSearchHighlights();
}

function clearSearchHighlights() {
  var area = document.getElementById('messagesArea');
  // restore hidden groups
  area.querySelectorAll('.msg-group.search-hidden').forEach(function(el) {
    el.classList.remove('search-hidden');
  });
  // remove highlights
  area.querySelectorAll('.search-highlight').forEach(function(el) {
    var parent = el.parentNode;
    parent.replaceChild(document.createTextNode(el.textContent), el);
    parent.normalize();
  });
  // restore date dividers
  area.querySelectorAll('.date-divider').forEach(function(el) {
    el.style.display = '';
  });
}

function searchConversation(query) {
  clearSearchHighlights();
  var count = document.getElementById('convSearchCount');
  if (!query.trim()) { count.textContent = ''; return; }

  var area   = document.getElementById('messagesArea');
  var groups = area.querySelectorAll('.msg-group');
  var q      = query.toLowerCase();
  var found  = 0;

  groups.forEach(function(group) {
    // check bubble text and file names
    var bubble   = group.querySelector('.msg-bubble');
    var textNode = bubble ? bubble.childNodes : [];
    var fullText = bubble ? bubble.innerText.toLowerCase() : '';
    var fileEl   = group.querySelector('.msg-file');
    var fileText = fileEl ? fileEl.innerText.toLowerCase() : '';

    if (fullText.indexOf(q) === -1 && fileText.indexOf(q) === -1) {
      group.classList.add('search-hidden');
    } else {
      found++;
      // highlight in bubble text nodes
      if (bubble) highlightInElement(bubble, query);
    }
  });

  // hide date dividers that have no visible messages after them
  area.querySelectorAll('.date-divider').forEach(function(divider) {
    var next = divider.nextElementSibling;
    var hasVisible = false;
    while (next && !next.classList.contains('date-divider')) {
      if (!next.classList.contains('search-hidden')) { hasVisible = true; break; }
      next = next.nextElementSibling;
    }
    divider.style.display = hasVisible ? '' : 'none';
  });

  count.textContent = found + ' result' + (found !== 1 ? 's' : '');
}

function highlightInElement(el, query) {
  var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
  var nodes  = [];
  var node;
  while ((node = walker.nextNode())) { nodes.push(node); }

  var q = query.toLowerCase();
  nodes.forEach(function(textNode) {
    var val = textNode.nodeValue;
    var idx = val.toLowerCase().indexOf(q);
    if (idx === -1) return;
    var before  = document.createTextNode(val.slice(0, idx));
    var mark    = document.createElement('mark');
    mark.className = 'search-highlight';
    mark.textContent = val.slice(idx, idx + query.length);
    var after   = document.createTextNode(val.slice(idx + query.length));
    var parent  = textNode.parentNode;
    parent.insertBefore(before, textNode);
    parent.insertBefore(mark, textNode);
    parent.insertBefore(after, textNode);
    parent.removeChild(textNode);
  });
}
function statusColor(s) {
  return { online: '#2ecc71', away: '#f1c40f', busy: '#e74c3c', offline: '#95a5a6' }[s] || '#95a5a6';
}

// ── SMS INBOX PANEL ──────────────────────────────────────────
function toggleSmsInbox() {
  const panel = document.getElementById('smsInboxPanel');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) renderSmsInboxPanel();
}

function renderSmsInboxPanel() {
  const list   = document.getElementById('smsInboxList');
  const inbox  = OfflineStore.getSmsInbox();
  const count  = document.getElementById('smsInboxCount');

  if (!inbox.length) {
    list.innerHTML = '<div style="text-align:center;color:#aaa;padding:30px;font-size:13px;">No SMS messages yet.<br>Start the SMS bridge server<br>and send a text to your phone.</div>';
    if (count) { count.style.display = 'none'; }
    return;
  }

  if (count) {
    count.textContent = inbox.length;
    count.style.display = 'inline-block';
  }

  list.innerHTML = '';
  // Show newest first
  inbox.slice().reverse().forEach(function(item) {
    const div = document.createElement('div');
    div.className = 'sms-inbox-item';
    const time = new Date(item.receivedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    div.innerHTML =
      '<div class="sms-inbox-from">📱 ' + escapeHtml(item.msg.smsFrom || 'Unknown') + '</div>' +
      '<div class="sms-inbox-text">' + escapeHtml(item.msg.text || '') + '</div>' +
      '<div class="sms-inbox-meta">' + time + ' → #' + escapeHtml(item.channelId) + '</div>';
    div.onclick = function() {
      loadChannel(item.channelId);
      toggleSmsInbox();
    };
    list.appendChild(div);
  });
}

function clearSmsInboxPanel() {
  if (!confirm('Clear all SMS inbox messages?')) return;
  OfflineStore.clearSmsInbox();
  localStorage.setItem('pc_seen_sms', '[]');
  renderSmsInboxPanel();
  const count = document.getElementById('smsInboxCount');
  if (count) count.style.display = 'none';
}

// Update SMS inbox badge count
function updateSmsInboxBadge() {
  const inbox = OfflineStore.getSmsInbox();
  const count = document.getElementById('smsInboxCount');
  if (!count) return;
  if (inbox.length > 0) {
    count.textContent    = inbox.length;
    count.style.display  = 'inline-block';
  } else {
    count.style.display  = 'none';
  }
}

// Call on load
document.addEventListener('DOMContentLoaded', function() {
  setTimeout(updateSmsInboxBadge, 500);
  checkNotificationPermission();
  updateFavicon(false);

  // Mobile: start on the conversation list (sidebar), not the chat
  if (window.innerWidth <= 640) {
    document.body.classList.remove('chat-open');
    updateHamburgerIcon(false);
  }

  // ── Mobile keyboard fix ──────────────────────────────────
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function() {
      var inputBar = document.getElementById('msgInput');
      if (!inputBar) return;
      setTimeout(function() {
        inputBar.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 100);
    });
  }
});

// ── QUOTE MESSAGE ──────────────────────────────────────────
function quoteMessage(msgId) {
  const group = document.querySelector('[data-msg-id="' + msgId + '"]');
  if (!group) return;
  const bubble = group.querySelector('.msg-bubble');
  const meta   = group.querySelector('.msg-meta strong');
  const sender = meta ? meta.textContent : 'Unknown';
  
  // Get text but exclude emoji reactions and action buttons
  let text = '';
  if (bubble) {
    // Clone the bubble to manipulate it
    const clone = bubble.cloneNode(true);
    // Remove action buttons and reactions
    const actions = clone.querySelector('.msg-actions');
    if (actions) actions.remove();
    // Get text and clean up
    text = clone.innerText
      .replace(/👍|❤️|😂|🗑️|↩️|✏️/g, '') // Remove any remaining emoji icons
      .replace(/[\n\r]+/g, ' ')           // Replace newlines with spaces
      .trim()
      .slice(0, 200);
  }

  state.quoteMsg = { id: msgId, sender: sender, text: text };
  const preview = document.getElementById('quotePreview');
  const previewText = document.getElementById('quotePreviewText');
  previewText.innerHTML = '<strong>' + escapeHtml(sender) + ':</strong> ' + escapeHtml(text.slice(0, 100));
  preview.classList.add('show');
  document.getElementById('msgInput').focus();
}

function cancelQuote() {
  state.quoteMsg = null;
  document.getElementById('quotePreview').classList.remove('show');
}

// Mark a specific sender's message as read (removes bold)
function markSenderRead(msgId, senderName) {
  state.unreadMsgIds.delete(msgId);
  // Also remove all unread msg IDs from this sender in current channel
  // Re-render just that sender element without full re-render
  var el = document.getElementById('sender-' + msgId);
  if (el) {
    var replacement = document.createElement('strong');
    replacement.textContent = senderName;
    el.parentNode.replaceChild(replacement, el);
  }
}

function scrollToMsg(msgId) {
  if (!msgId) return;
  const group = document.querySelector('[data-msg-id="' + msgId + '"]');
  if (group) {
    group.scrollIntoView({ behavior: 'smooth', block: 'center' });
    group.style.background = 'rgba(98,100,167,0.3)';
    setTimeout(function() { group.style.background = ''; }, 1500);
  }
}

// ── EDIT MESSAGE ──────────────────────────────────────────
function startEdit(msgId) {
  const group = document.querySelector('[data-msg-id="' + msgId + '"]');
  if (!group) return;

  // Get the plain text from the bubble (strip HTML tags and <br> back to newlines)
  const bubble = document.getElementById('bubble-' + msgId);
  let currentText = '';
  if (bubble) {
    // Clone and remove action buttons AND quote block before reading text
    const clone = bubble.cloneNode(true);
    const actions = clone.querySelector('.msg-actions');
    if (actions) actions.remove();
    const quote = clone.querySelector('.msg-quote');
    if (quote) quote.remove();
    // Convert <br> back to newlines, then strip remaining tags
    currentText = clone.innerHTML
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .trim();
  }

  // Build a full-width edit row and insert it after the group
  const editRow = document.createElement('div');
  editRow.className = 'msg-editing';
  editRow.id = 'editrow-' + msgId;
  editRow.innerHTML =
    '<div class="msg-edit-label">✏️ Editing message</div>' +
    '<textarea class="msg-edit-area" id="edit-' + msgId + '">' + currentText + '</textarea>' +
    '<div class="msg-edit-actions">' +
      '<button class="msg-edit-save" onclick="saveEdit(\'' + msgId + '\')">Save</button>' +
      '<button class="msg-edit-cancel" onclick="cancelEdit(\'' + msgId + '\')">Cancel</button>' +
      '<span style="font-size:11px;color:var(--text-muted);margin-left:6px;">Enter to save · Esc to cancel</span>' +
    '</div>';

  // Hide the original group and insert edit row after it
  group.style.display = 'none';
  group.parentNode.insertBefore(editRow, group.nextSibling);

  const ta = document.getElementById('edit-' + msgId);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  // Auto-resize the textarea
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  ta.addEventListener('input', function() {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  });

  // Keyboard shortcuts
  ta.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(msgId); }
    if (e.key === 'Escape') { cancelEdit(msgId); }
  });

  editRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function saveEdit(msgId) {
  const textarea = document.getElementById('edit-' + msgId);
  if (!textarea) return;
  const newText = textarea.value.trim();
  if (!newText) { alert('Message cannot be empty.'); return; }

  // Email mode: update local cache and re-render
  var cached = OfflineStore.getCachedMessages(state.currentChannel);
  var msg = cached.find(function(m) { return m.id === msgId; });
  if (msg) {
    msg.text   = newText;
    msg.edited = true;
    OfflineStore.cacheMessages(state.currentChannel, cached);
  }
  cancelEdit(msgId);
  // Re-render the bubble text
  var bubble = document.getElementById('bubble-' + msgId);
  if (bubble) {
    // Find the text node (not actions/reactions) and update it
    var clone = bubble.cloneNode(true);
    var actions = clone.querySelector('.msg-actions');
    if (actions) actions.remove();
    // Replace bubble content
    var textNode = document.createElement('span');
    textNode.innerHTML = renderText(newText) + '<span class="msg-edited-tag">(edited)</span>';
    // Clear old text content and replace
    while (bubble.firstChild) bubble.removeChild(bubble.firstChild);
    bubble.appendChild(textNode);
    // Re-add actions
    var actionsEl = document.createElement('div');
    actionsEl.className = 'msg-actions';
    bubble.appendChild(actionsEl);
  }
}

function cancelEdit(msgId) {
  // Remove edit row and restore original group
  const editRow = document.getElementById('editrow-' + msgId);
  if (editRow) editRow.remove();
  const group = document.querySelector('[data-msg-id="' + msgId + '"]');
  if (group) group.style.display = '';
}

// ── NOTIFICATIONS ──────────────────────────────────────────

// Subscribe lightweight listeners on all channels for cross-channel notifications
// Guard: only start once — not restarted on every channel switch
var _notifListenersStarted = false;
function startNotifListeners() {
  // Email mode: notifications come through fetchEmailMessages polling
  // Start background polling for all known channels
  _notifListenersStarted = true;
  state.unsubscribeNotifs = [];

  var allChannelIds = channels.map(function(ch) { return ch.id; });
  var cachedUsers = OfflineStore.getAllEmailUsers ? OfflineStore.getAllEmailUsers() : OfflineStore.getCachedUsers();
  var me = state.currentUser.email || state.currentUser.id;
  cachedUsers.forEach(function(u) {
    if (!u.email || u.email === me) return;
    allChannelIds.push(emailDmConvId(me, u.email));
  });

  allChannelIds.forEach(function(convId) {
    if (convId !== state.currentChannel) {
      startEmailPoll(convId);
    }
  });
}

function checkNotificationPermission() {
  if (!('Notification' in window)) return;
  const btn = document.getElementById('notifBtn');
  if (Notification.permission === 'default') {
    btn.style.display = 'inline-block';
  } else if (Notification.permission === 'granted') {
    btn.style.display = 'none';
  }
}

function requestNotificationPermission() {
  if (!('Notification' in window)) {
    alert('Notifications not supported in this browser.');
    return;
  }
  Notification.requestPermission().then(function(perm) {
    if (perm === 'granted') {
      document.getElementById('notifBtn').style.display = 'none';
    }
  });
}

function showBrowserNotification(title, body, channelId) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.hasFocus() && channelId === state.currentChannel) return;
  try {
    var notif = new Notification(title, {
      body: body,
      icon: 'M-LOGO.png',
      tag: channelId || 'general',
      renotify: true,
    });
    notif.onclick = function() {
      window.focus();
      if (channelId) loadChannel(channelId);
      notif.close();
    };
    // Auto-close after 6s
    setTimeout(function() { notif.close(); }, 6000);
  } catch(e) {
    // ServiceWorker notifications not available — silent fail
  }
}

// CLOSE PICKERS ON OUTSIDE CLICK
document.addEventListener('click', function(e) {
  const picker = document.getElementById('emojiPicker');
  if (picker && !picker.contains(e.target) && !e.target.closest('.emoji-btn')) {
    picker.classList.remove('show');
  }
  const ctxMenu = document.getElementById('channelCtxMenu');
  if (ctxMenu && !ctxMenu.contains(e.target) && !e.target.classList.contains('ch-menu-btn')) {
    closeCtxMenu();
  }
  const memberCtx = document.getElementById('memberCtxMenu');
  if (memberCtx && !memberCtx.contains(e.target) && !e.target.classList.contains('member-menu-btn')) {
    closeMemberCtxMenu();
  }
  // Mobile: close message action menus when tapping outside
  if (window.innerWidth <= 640) {
    if (!e.target.closest('.msg-bubble')) {
      document.querySelectorAll('.msg-bubble.actions-open').forEach(function(b) {
        b.classList.remove('actions-open');
      });
    }
  }
});
