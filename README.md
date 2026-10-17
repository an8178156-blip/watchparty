# 🎬 WatchTogether

A watch-party website: create a room, send the invite link to friends, and watch together with voice and text chat.

## Features

- **Rooms with invite links** (up to 12 people; voice works best with 2–6)
- **YouTube**: paste a link, everyone watches in sync (play, pause and seeking are shared)
- **Web link**: any direct video link (`.mp4`, `.webm`) played in sync
- **Same file**: everyone opens their own copy of a video on their device; the site keeps it in sync (best quality)
- **Stream**: send a video from your device, or share a screen/tab, so friends don't need the file
- **Voice chat** (microphone, peer to peer) and **text chat**
- Works on phones and computers (streaming a file needs Chrome or Edge on a computer)

## 1. Run it on your computer (for testing)

1. Install **Node.js** (version 18 or newer) from https://nodejs.org
2. Open a terminal in this folder and run:
   ```
   npm install
   npm start
   ```
3. Open **http://localhost:3000** in your browser.
   To test with "friends", open the invite link in a second browser window.

## 2. Put it online for free (so friends anywhere can join)

Voice and screen sharing only work on a secure `https://` address, which these hosts give you automatically.

**Render (free):**
1. Create a free account on https://github.com and upload this folder as a new repository.
2. Create a free account on https://render.com → **New** → **Web Service** → choose your repository.
3. Settings: Build command `npm install`, Start command `npm start`, Instance type **Free**.
4. Click **Create**. After a few minutes you get a link like `https://your-app.onrender.com` — share it!

Note: free Render services fall asleep after a while without visitors, so the first visit can take up to about a minute to wake up. Railway, Fly.io or Koyeb work the same way.

## 3. If voice or streaming doesn't connect for some friends

Some home, mobile or work networks block direct connections. A **TURN server** relays the connection for them.
Get one (for example from Metered, Twilio or Cloudflare, which have free tiers, or run your own with `coturn`),
then add these environment variables on your host:

```
TURN_URL=turn:your.turn.server:3478,turns:your.turn.server:443
TURN_USERNAME=your-username
TURN_CREDENTIAL=your-password
```

## Files

```
server.js          the server: rooms, sync, chat and connection signaling
public/index.html  the page layout
public/style.css   the design
public/app.js      everything in the browser: players, sync, chat, voice, streaming
```

## Tips

- Use **headphones** with voice chat to avoid echo.
- **Same file** gives the best quality; **Stream** is easiest but depends on the host's upload speed.
- If someone gets out of sync, they can press **⟳ Re-sync**.
- YouTube videos that disable embedding can't be played inside the site.
- Only share videos you have the right to share.
