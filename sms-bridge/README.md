# Palawan Connect — SMS Bridge

Receives SMS from your Android phone and injects them into Palawan Connect channels — **no internet required**, works entirely on your local WiFi.

---

## How It Works

```
Someone sends SMS → Your Android phone receives it
  → SMS Gateway app on phone POSTs to your PC (local WiFi)
    → This Node.js server receives it
      → Injects message into Firestore
        → Appears in Palawan Connect in real-time
```

---

## Quick Start

### 1. Install dependencies
```bash
cd sms-bridge
npm install
```

### 2. Add Firebase service account key
- Go to [Firebase Console](https://console.firebase.google.com)
- Select your project → Project Settings → Service Accounts
- Click **Generate new private key** → download the JSON file
- Rename it to `serviceAccountKey.json` and place it in this `sms-bridge/` folder

### 3. Start the server
```bash
npm start
```

You'll see:
```
╔══════════════════════════════════════════╗
║   Palawan Connect — SMS Bridge Server    ║
╠══════════════════════════════════════════╣
║  Listening on  http://0.0.0.0:3000       ║
║  Dashboard     http://localhost:3000      ║
║  Webhook URL   http://<YOUR-IP>:3000/sms ║
╚══════════════════════════════════════════╝
```

### 4. Find your PC's local IP
Open Command Prompt and run:
```
ipconfig
```
Look for **IPv4 Address** under your WiFi adapter (e.g. `192.168.1.5`)

### 5. Install Android SMS Gateway app
- Install **"SMS Gateway for Android"** from Google Play (by capcom — it's free)
- Open the app → Settings → Webhooks → Add webhook:
  - URL: `http://192.168.1.5:3000/sms` (use your actual IP)
  - Method: `POST`
  - Format: `JSON`

### 6. Connect both devices to the same WiFi
Phone and PC must be on the same local network. No internet needed after this.

### 7. Open the dashboard
Visit `http://localhost:3000` in your browser to:
- Check server status
- View incoming SMS log
- Send test messages

---

## Channel Routing

Edit the `routingRules` array in `server.js` to route SMS to different channels based on keywords or phone numbers:

```js
const routingRules = [
  { match: /urgent|emergency/i, channel: 'general',  label: 'General' },
  { match: '+63917123456',      channel: 'dm-mark',  label: 'Mark DM' },
];
```

The `DEFAULT_CHANNEL` in `.env` is used when no rule matches (default: `general`).

---

## SMS Appearance in Palawan Connect

Incoming SMS messages appear with:
- 📱 orange avatar
- **📱 SMS** badge next to the sender name
- Sender shown as `📱 SMS (+63917...)`
- Orange left border on the message bubble

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Phone can't reach server | Make sure both are on same WiFi. Check Windows Firewall — allow port 3000 |
| Firebase not connected | Check `serviceAccountKey.json` is in `sms-bridge/` folder |
| Messages not appearing | Check the SMS log at `http://localhost:3000` |
| Port 3000 in use | Change `PORT=3001` in `.env` |

### Allow port 3000 through Windows Firewall
Run in PowerShell as Administrator:
```powershell
New-NetFirewallRule -DisplayName "SMS Bridge" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```
