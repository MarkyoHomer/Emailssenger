# MyHome Connect — Deployment Guide

## Architecture

```
GitHub Pages (free)          Railway (free)
─────────────────────        ──────────────────────
index.html   ──────────────► /auth/login  (IMAP test)
teams.html   ◄── polling ─── /messages   (IMAP read)
login.js                     /messages/send (SMTP)
teams.js                     email-server.js
```

---

## Step 1 — Push to GitHub

1. Create a new GitHub repository (e.g. `myhomeconnect`)
2. Push this project:
   ```
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR-USERNAME/myhomeconnect.git
   git push -u origin main
   ```

---

## Step 2 — Deploy the Email Bridge to Railway

Railway runs the Node.js server that handles IMAP/SMTP.

1. Go to **https://railway.app** → Sign up free (GitHub login)
2. Click **New Project → Deploy from GitHub repo**
3. Select your repository
4. Railway will detect `sms-bridge/package.json` — set the **Root Directory** to `sms-bridge`
5. Click **Deploy**
6. Wait ~2 minutes for the build to finish
7. Go to **Settings → Networking → Generate Domain**
8. Copy your Railway URL — it looks like:
   `https://myhomeconnect-email.up.railway.app`

---

## Step 3 — Enable GitHub Pages

1. In your GitHub repo → **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: `main` / `(root)`
4. Click **Save**
5. Your app URL will be:
   `https://YOUR-USERNAME.github.io/myhomeconnect/`

---

## Step 4 — Connect the Frontend to Railway

When you first open the GitHub Pages URL:
1. The login page will show a yellow **"Server not configured"** banner
2. Paste your Railway URL into the input field
3. Click **Save**
4. The URL is stored in your browser — you only do this once per device

---

## Step 5 — Sign In

**Gmail:**
- You need an **App Password** (not your regular password)
- Go to: https://myaccount.google.com/apppasswords
- Create one, use it as your password in the app

**Outlook / Hotmail / Live:**
- Use your regular password
- If it fails, enable IMAP in Outlook settings

**Yahoo:**
- You need an **App Password**
- Go to: https://login.yahoo.com/account/security

**Company email (e.g. @palawanpawnshop.com):**
- Select "Custom" provider
- Enter your mail server (e.g. `mail.palawanpawnshop.com`)
- Use your regular email password

---

## How it works

- **Sending a message** → the app POSTs to Railway → Railway sends an email via SMTP
- **Receiving messages** → Railway polls your IMAP inbox every 5 seconds for emails with `[DM:]` or `[CH:]` in the subject
- **DMs** → emails between two addresses, subject: `[DM:conv-id]`
- **Channels** → emails to all members, subject: `[CH:channel-name]`
- **Offline** → messages cached in browser localStorage, sent when back online

---

## Railway Free Tier Limits

- 500 hours/month (enough for ~16 hours/day)
- 512 MB RAM
- Sleeps after 30 min inactivity (wakes on first request, ~5s delay)

To keep it always awake, add a free uptime monitor at https://uptimerobot.com
pointing to `https://your-app.up.railway.app/status`
