// ─────────────────────────────────────────────────────────────
//  FIREBASE CONFIGURATION
// ─────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyC6fdObfqq8r8hoIwYXsqfvMyxg9vNuwXM",
  authDomain: "pconnect-9e7db.firebaseapp.com",
  projectId: "pconnect-9e7db",
  storageBucket: "pconnect-9e7db.firebasestorage.app",
  messagingSenderId: "335047317723",
  appId: "1:335047317723:web:d5d4e773dbf094617794fe",
  measurementId: "G-3C8NJ07RY9"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Enable offline persistence on the main app page only (not login)
// Persistence adds IndexedDB startup overhead — skip it on the login page
const db = firebase.firestore();
var _isLoginPage = window.location.pathname.indexOf('index') !== -1 ||
                   window.location.pathname === '/' ||
                   window.location.pathname.endsWith('/');
if (!_isLoginPage) {
  db.enablePersistence({ synchronizeTabs: true }).catch(function(err) {
    if (err.code === 'failed-precondition') {
      console.warn('Offline persistence unavailable: multiple tabs open.');
    } else if (err.code === 'unimplemented') {
      console.warn('Offline persistence not supported in this browser.');
    }
  });
}

const storage = firebase.storage();

// ── FIREBASE AVAILABILITY PROBE ──────────────────────────────
// Checks if Firestore is reachable. Sets window._firebaseAvailable.
// Other code can check this before making Firestore calls.
window._firebaseAvailable = true; // optimistic default

(function probeFirebase() {
  if (window.location.pathname.indexOf('teams') === -1) return; // only on main app
  db.collection('_probe').limit(1).get()
    .then(function() {
      window._firebaseAvailable = true;
    })
    .catch(function(err) {
      // quota-exhausted, permission-denied, unavailable — all mean Firebase is down
      console.warn('[Firebase] Unavailable:', err.code);
      window._firebaseAvailable = false;
      // Show local-only banner if not already shown
      var banner = document.getElementById('offlineBanner');
      if (banner && banner.style.display === 'none') {
        banner.style.display  = 'block';
        banner.style.background = '#2980b9';
        banner.innerHTML = '📡 Firebase unavailable (' + err.code + ') — running in local mode. SMS bridge still works.';
      }
    });
})();
