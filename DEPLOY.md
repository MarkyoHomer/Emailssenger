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

## Step 2 — Deploy the Email Bridge to a Free Server

You need to deploy `sms-bridge/` to a free Node.js host. Two options:

---

### Option A — Railway (recommended)

1. Go to **https://railway.app** → Sign up with GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your repository
4. Railway auto-detects the project. You'll see a service box appear.
5. Click the service box → **"Settings"** tab
6. Scroll to **"Build"** → set **Root Directory** to `sms-bridge`
7. Click **"Deploy"**
8. After deploy succeeds → still in **"Settings"** → scroll to **"Networking"**
9. Click **"Generate Domain"** → copy the URL shown (e.g. `https://xxx.up.railway.app`)

---

### Option B — Render (easier UI)

1. Go to **https://render.com** → Sign up with GitHub (free)
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repo
4. Fill in:
   - **Name**: `myhomeconnect-email`
   - **Root Directory**: `sms-bridge`
   - **Build Command**: `npm install`
   - **Start Command**: `node email-server.js`
   - **Instance Type**: Free
5. Click **"Create Web Service"**
6. Wait ~3 minutes for the build
7. Your URL appears at the top of the page:
   `https://myhomeconnect-email.onrender.com`
   Copy it.

> **Note:** Render free tier sleeps after 15 min of inactivity (first request takes ~30s to wake up). Railway free tier is faster.

---

## Step 2.5 — Add Persistent Storage (Upstash Redis — free)

Without this, messages are lost every time Railway restarts. Upstash gives you a free Redis database.

1. Go to **https://upstash.com** → Sign up free
2. Click **"Create Database"** → choose a region close to your Railway region
3. After creation, click the database → **"REST API"** tab
4. Copy the **UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN**
5. In Railway → your service → **"Variables"** tab → add:
   - `REDIS_URL` = your Upstash REST URL (e.g. `https://xxx.upstash.io`)
   - `REDIS_TOKEN` = your Upstash REST token
6. Railway will redeploy automatically

After this, messages survive server restarts permanently.

---

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
