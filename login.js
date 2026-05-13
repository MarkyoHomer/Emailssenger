// ── EMAIL BRIDGE URL ─────────────────────────────────────────
const EMAIL_BRIDGE = (function() {
  var stored = localStorage.getItem('mhc_bridge_url');
  if (stored) return stored.replace(/\/$/, '');
  return 'http://localhost:3001';
})();

// ── COLOR GENERATOR ──────────────────────────────────────────
function getColor(name) {
  const palette = ['#0e7c63','#8e44ad','#e67e22','#2980b9','#c0392b','#16a085','#d35400'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
}

function isOnline() { return navigator.onLine; }

// ── PROVIDER PRESETS ─────────────────────────────────────────
var PROVIDERS = {
  gmail:   { imapHost: 'imap.gmail.com',        imapPort: 993, smtpHost: 'smtp.gmail.com',        smtpPort: 587, passwordLabel: 'App Password' },
  outlook: { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com',    smtpPort: 587, passwordLabel: 'Password' },
  yahoo:   { imapHost: 'imap.mail.yahoo.com',   imapPort: 993, smtpHost: 'smtp.mail.yahoo.com',   smtpPort: 587, passwordLabel: 'App Password' },
  custom:  { imapHost: '',                       imapPort: 993, smtpHost: '',                      smtpPort: 587, passwordLabel: 'Password' },
};

var _selectedProvider = 'gmail';

function selectProvider(name) {
  _selectedProvider = name;
  ['gmail','outlook','yahoo','custom'].forEach(function(p) {
    var btn = document.getElementById('prov' + p.charAt(0).toUpperCase() + p.slice(1));
    if (btn) btn.classList.toggle('active', p === name);
    var hint = document.getElementById('hint' + p.charAt(0).toUpperCase() + p.slice(1));
    if (hint) hint.style.display = p === name ? 'block' : 'none';
  });
  var adv = document.getElementById('advancedSettings');
  if (adv) adv.style.display = name === 'custom' ? 'block' : 'none';
  var lbl = document.getElementById('passwordLabel');
  if (lbl) lbl.textContent = PROVIDERS[name].passwordLabel;
}

// ── LOGIN ─────────────────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  var email    = (document.getElementById('loginEmail').value    || '').trim().toLowerCase();
  var password = document.getElementById('loginPassword').value;
  var errEl    = document.getElementById('loginError');
  var btn      = document.getElementById('loginBtn');

  if (!email || !password) { errEl.textContent = 'Email and password are required.'; return; }

  var preset   = PROVIDERS[_selectedProvider] || PROVIDERS.gmail;
  var imapHost = _selectedProvider === 'custom' ? (document.getElementById('imapHost').value.trim()) : preset.imapHost;
  var imapPort = _selectedProvider === 'custom' ? (parseInt(document.getElementById('imapPort').value) || 993) : preset.imapPort;
  var smtpHost = _selectedProvider === 'custom' ? (document.getElementById('smtpHost').value.trim()) : preset.smtpHost;
  var smtpPort = _selectedProvider === 'custom' ? (parseInt(document.getElementById('smtpPort').value) || 587) : preset.smtpPort;

  btn.disabled    = true;
  btn.textContent = 'Connecting…';
  errEl.textContent = '';

  // ── Try cached session first (instant) ──
  var cached = OfflineStore.getCachedEmailUser(email);
  if (cached && cached.token) {
    try {
      var check = await Promise.race([
        fetch(EMAIL_BRIDGE + '/status', { signal: AbortSignal.timeout(2000) }),
        new Promise(function(_, r) { setTimeout(function() { r(new Error('t')); }, 2000); }),
      ]);
      if (check && check.ok) {
        sessionStorage.setItem('teamsUser', JSON.stringify({ id: email, name: cached.name, color: cached.color, email: email, token: cached.token, status: 'online' }));
        window.location.href = 'teams.html';
        return;
      }
    } catch (e) {
      sessionStorage.setItem('teamsUser', JSON.stringify({ id: email, name: cached.name, color: cached.color, email: email, token: cached.token || '', status: 'offline', localOnly: true }));
      window.location.href = 'teams.html';
      return;
    }
  }

  if (!isOnline()) {
    btn.disabled = false; btn.textContent = 'Sign In';
    errEl.textContent = '📡 No internet. Connect and try again.';
    return;
  }

  try {
    var res  = await fetch(EMAIL_BRIDGE + '/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password, imapHost, imapPort, smtpHost, smtpPort }),
      signal:  AbortSignal.timeout(25000),
    });
    var data = await res.json();

    if (!data.ok) {
      btn.disabled = false; btn.textContent = 'Sign In';
      var msg = data.error || 'Login failed.';
      if (_selectedProvider === 'gmail' && (msg.includes('Invalid') || msg.includes('credentials') || msg.includes('AUTHENTICATIONFAILED'))) {
        msg = 'Gmail: Use an App Password, not your regular password. Click the link in the hint below.';
      }
      errEl.textContent = msg;
      return;
    }

    OfflineStore.upsertCachedEmailUser({ email, name: data.user.name, color: data.user.color, token: data.token, imapHost, imapPort, smtpHost, smtpPort });
    OfflineStore.saveEmailSession({ email, name: data.user.name, imapHost, imapPort, smtpHost, smtpPort, provider: _selectedProvider });

    sessionStorage.setItem('teamsUser', JSON.stringify({ id: email, name: data.user.name, color: data.user.color, email: email, token: data.token, status: 'online' }));
    window.location.href = 'teams.html';

  } catch (err) {
    btn.disabled = false; btn.textContent = 'Sign In';
    if (err.message === 'Failed to fetch' || err.name === 'AbortError' || err.message === 't') {
      errEl.textContent = '⚠️ Cannot reach email bridge. Make sure START-EMAIL-SERVER.bat is running on this PC.';
    } else {
      errEl.textContent = 'Error: ' + err.message;
    }
  }
}

// ── BRIDGE URL CONFIG ─────────────────────────────────────────
function saveBridgeUrl() {
  var input = document.getElementById('bridgeUrlInput');
  if (!input) return;
  var url = input.value.trim().replace(/\/$/, '');
  if (!url.startsWith('http')) { alert('Enter a valid URL starting with https://'); return; }
  localStorage.setItem('mhc_bridge_url', url);
  document.getElementById('bridgeSetup').style.display = 'none';
  window.location.reload();
}

async function testBridgeUrl() {
  var input  = document.getElementById('bridgeUrlInput');
  var result = document.getElementById('bridgeTestResult');
  if (!input || !result) return;
  var url = input.value.trim().replace(/\/$/, '');
  if (!url) { result.textContent = 'Enter a URL first.'; result.style.color = '#ff6b6b'; return; }
  result.textContent = 'Testing…'; result.style.color = 'var(--text-muted)';
  try {
    var res = await fetch(url + '/status', { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      var data = await res.json();
      result.textContent = '✅ Connected! Server uptime: ' + data.uptime + 's';
      result.style.color = '#92c353';
    } else {
      result.textContent = '✗ Server returned HTTP ' + res.status;
      result.style.color = '#ff6b6b';
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      result.textContent = '✗ Timeout — server took too long (may be sleeping, try again in 30s)';
    } else {
      result.textContent = '✗ ' + e.message + ' — check Railway deployment logs';
    }
    result.style.color = '#ff6b6b';
  }
}

async function checkBridgeServer() {
  var statusEl = document.getElementById('serverStatus');
  var setupEl  = document.getElementById('bridgeSetup');
  var urlInput = document.getElementById('bridgeUrlInput');

  // Pre-fill input with current URL if set
  var current = localStorage.getItem('mhc_bridge_url');
  if (urlInput && current) urlInput.value = current;

  // Always show setup panel if using localhost (means not configured for web)
  var isLocalhost = EMAIL_BRIDGE.includes('localhost');
  if (isLocalhost && setupEl) {
    setupEl.style.display = 'block';
    if (statusEl) { statusEl.textContent = '⚠️ Server URL not configured for web'; statusEl.style.color = '#f8d22a'; }
    return;
  }

  try {
    var res = await fetch(EMAIL_BRIDGE + '/status', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      if (statusEl) { statusEl.textContent = '✅ Server connected — ' + EMAIL_BRIDGE; statusEl.style.color = '#92c353'; }
      if (setupEl)  setupEl.style.display = 'none';
    } else {
      throw new Error('HTTP ' + res.status);
    }
  } catch (e) {
    if (statusEl) { statusEl.textContent = '⚠️ Server not reachable: ' + EMAIL_BRIDGE; statusEl.style.color = '#ff6b6b'; }
    if (setupEl)  setupEl.style.display = 'block';
  }
}
function updateNetworkBadge() {
  var badge = document.getElementById('networkBadge');
  if (!badge) return;
  badge.textContent = isOnline() ? '🟢 Online' : '🔴 Offline';
  badge.className   = 'network-badge ' + (isOnline() ? 'online' : 'offline');
}

// ── INIT ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  updateNetworkBadge();
  window.addEventListener('online',  updateNetworkBadge);
  window.addEventListener('offline', updateNetworkBadge);

  // Check if bridge server is reachable
  checkBridgeServer();

  var saved = OfflineStore.getEmailSession();
  if (saved) {
    if (document.getElementById('loginEmail')) document.getElementById('loginEmail').value = saved.email || '';
    selectProvider(saved.provider || 'gmail');
  } else {
    selectProvider('gmail');
  }

  // Auto-detect provider from email as user types
  var emailInput = document.getElementById('loginEmail');
  if (emailInput) {
    emailInput.addEventListener('input', function() {
      var v = this.value.toLowerCase();
      if      (v.includes('@gmail.com'))                                                          selectProvider('gmail');
      else if (v.includes('@outlook.') || v.includes('@hotmail.') || v.includes('@live.'))       selectProvider('outlook');
      else if (v.includes('@yahoo.'))                                                             selectProvider('yahoo');
      else if (v.includes('@') && v.split('@')[1] && v.split('@')[1].includes('.')) {
        selectProvider('custom');
        var domain = v.split('@')[1];
        var ih = document.getElementById('imapHost');
        var sh = document.getElementById('smtpHost');
        if (ih && !ih.value) { ih.value = 'mail.' + domain; }
        if (sh && !sh.value) { sh.value = 'mail.' + domain; }
      }
    });
  }
});
