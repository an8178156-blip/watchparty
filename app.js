// WatchTogether client: rooms, synced playback, chat, voice and streaming.
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  // ---------- Small helpers ----------
  const toastEl = $('#toast');
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3500);
  }
  function show(sel, on) { $(sel).classList.toggle('hidden', !on); }
  function colorFor(id) {
    let h = 0;
    for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `hsl(${h} 55% 50%)`;
  }
  function randomId() {
    const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
    return Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => chars[x % chars.length]).join('');
  }
  function parseCode(v) {
    v = v.trim();
    const m = v.match(/\/room\/([\w-]+)/);
    return (m ? m[1] : v).replace(/[^\w-]/g, '').slice(0, 40);
  }
  function youtubeId(url) {
    url = url.trim();
    if (/^[\w-]{11}$/.test(url)) return url;
    const m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
  }

  // ---------- Landing ----------
  const nameInput = $('#nameInput');
  nameInput.value = store.get('wt-name') || '';
  const invited = location.pathname.match(/^\/room\/([\w-]+)/);

  if (invited) {
    $('#landingText').textContent = `You're invited to room "${invited[1]}". Enter your name to join.`;
    $('#createBtn').textContent = 'Join room';
    show('#orRow', false);
    show('#joinRow', false);
  }

  function getName() {
    const n = nameInput.value.trim();
    if (!n) { nameInput.focus(); toast('Please enter your name first'); return null; }
    store.set('wt-name', n);
    return n;
  }

  $('#createBtn').onclick = () => {
    const n = getName();
    if (!n) return;
    if (invited) return enterRoom(invited[1], n);
    const id = randomId();
    history.pushState(null, '', '/room/' + id);
    enterRoom(id, n);
  };
  $('#joinBtn').onclick = () => {
    const n = getName();
    if (!n) return;
    const id = parseCode($('#codeInput').value);
    if (!id) return toast('Enter a room code or invite link');
    history.pushState(null, '', '/room/' + id);
    enterRoom(id, n);
  };
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#createBtn').click(); });
  $('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinBtn').click(); });

  // ---------- Room state ----------
  let socket = null;
  let myId = null;
  let myName = '';
  let roomId = null;
  let clockOffset = 0;               // serverTime - localTime
  let iceServers = [];
  const users = new Map();

  let state = null;                  // shared playback state (server clock)
  let mode = 'none';                 // what my player shows: none | youtube | url | local | stream
  let localFile = null;              // { name, url, accepted }
  let currentStream = null;          // { by, name, streamId }

  const video = $('#video');
  const streamVideo = $('#streamVideo');

  const serverNow = () => Date.now() + clockOffset;
  const expectedTime = (s) => (s.playing ? s.time + (serverNow() - s.updatedAt) / 1000 : s.time);

  async function enterRoom(id, name) {
    $('#createBtn').disabled = true;
    $('#joinBtn').disabled = true;
    myName = name;
    try {
      iceServers = (await (await fetch('/config')).json()).iceServers;
    } catch {
      iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    }

    socket = io();
    let joined = false;

    socket.on('connect', () => {
      if (joined) { location.reload(); return; } // reconnected with a new id
      const t0 = Date.now();
      socket.emit('join', { room: id, name }, (res) => {
        if (res.error) {
          toast(res.error);
          $('#createBtn').disabled = false;
          $('#joinBtn').disabled = false;
          socket.disconnect();
          return;
        }
        joined = true;
        clockOffset = res.serverNow - (t0 + Date.now()) / 2;
        myId = res.id;
        roomId = id;

        show('#landing', false);
        show('#room', true);
        $('#roomName').textContent = id;
        document.title = `WatchTogether · ${id}`;

        res.users.forEach((u) => users.set(u.id, u));
        res.messages.forEach(addMessage);
        for (const u of res.users) if (u.id !== myId) getPeer(u.id);
        currentStream = res.stream;
        renderPeople();
        if (res.state) applyState(res.state);
        render();
      });
    });

    socket.on('disconnect', () => { if (joined) toast('Connection lost — reconnecting…'); });
    socket.on('user-joined', (u) => { users.set(u.id, u); getPeer(u.id); renderPeople(); });
    socket.on('user-left', (id) => { users.delete(id); closePeer(id); renderPeople(); });
    socket.on('user-update', (u) => { users.set(u.id, u); renderPeople(); });
    socket.on('chat', addMessage);
    socket.on('sync', (s) => applyState(s));
    socket.on('signal', handleSignal);
    socket.on('stream-start', (s) => {
      if (outStream && s.by !== myId) stopStreaming();
      currentStream = s;
      renderPeople();
      render();
    });
    socket.on('stream-stop', () => {
      if (currentStream?.by !== myId) currentStream = null;
      renderPeople();
      render();
    });
  }

  // ---------- Rendering ----------
  function needLocalFile() {
    return mode === 'local' && state?.mode === 'local' && !(localFile && localFile.accepted === state.source);
  }

  function render() {
    const watchingStream = !!currentStream && currentStream.by !== myId;
    const needFile = needLocalFile();

    show('#streamVideo', watchingStream);
    show('#placeholder', !watchingStream && mode === 'none');
    show('#ytWrap', !watchingStream && mode === 'youtube');
    show('#video', !watchingStream && !needFile && ['url', 'local', 'stream'].includes(mode));
    show('#localPrompt', !watchingStream && needFile);
    show('#stopStreamBtn', !!outStream);

    if (needFile) {
      $('#localPromptText').textContent =
        `${state.by || 'Someone'} is playing "${state.source}". Choose your own copy of this file to watch together.`;
    }

    if (watchingStream) {
      const ms = remoteStreams.get(currentStream.streamId);
      const el = audioEls.get(currentStream.streamId); // not a mic: stop the duplicate audio
      if (el) { el.el.remove(); audioEls.delete(currentStream.streamId); }
      if (ms && streamVideo.srcObject !== ms) {
        streamVideo.srcObject = ms;
        streamVideo.muted = false;
        streamVideo.play().catch(() => {
          streamVideo.muted = true;
          streamVideo.play().catch(() => {});
          toast('Tap the video to unmute the stream');
        });
      }
    } else if (streamVideo.srcObject) {
      streamVideo.srcObject = null;
    }
    updateNow();
  }

  function updateNow() {
    let t = 'Nothing playing';
    if (currentStream) {
      if (currentStream.by === myId) t = '📡 You are streaming to the room';
      else t = remoteStreams.has(currentStream.streamId)
        ? `📡 Watching ${currentStream.name}'s stream`
        : `📡 Connecting to ${currentStream.name}'s stream…`;
    } else if (state && state.mode !== 'none') {
      const what = { youtube: 'YouTube video', url: 'Web video', local: `"${state.source}"` }[state.mode];
      t = `${state.playing ? '▶' : '⏸'} ${what}${state.by ? ` · last action by ${state.by}` : ''}`;
    }
    $('#nowText').textContent = t;
  }

  function renderPeople() {
    const ul = $('#people');
    ul.textContent = '';
    for (const u of users.values()) {
      const li = document.createElement('li');
      const av = document.createElement('span');
      av.className = 'avatar';
      av.textContent = (u.name[0] || '?').toUpperCase();
      av.style.background = colorFor(u.id);
      const nm = document.createElement('span');
      nm.className = 'pname';
      nm.textContent = u.name + (u.id === myId ? ' (you)' : '');
      li.append(av, nm);
      if (currentStream?.by === u.id) li.append(Object.assign(document.createElement('span'), { textContent: '📡', title: 'Streaming' }));
      if (u.mic) li.append(Object.assign(document.createElement('span'), { textContent: '🎤', title: 'Mic on' }));
      ul.append(li);
    }
    $('#count').textContent = users.size;
  }

  function addMessage(m) {
    const box = $('#messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const d = document.createElement('div');
    if (m.system) {
      d.className = 'msg system';
      d.textContent = m.text;
    } else {
      d.className = 'msg' + (m.from === myId ? ' mine' : '');
      const n = document.createElement('b');
      n.textContent = m.name;
      n.style.color = colorFor(m.from);
      const t = document.createElement('span');
      t.textContent = m.text;
      d.append(n, t);
    }
    box.append(d);
    if (atBottom || m.from === myId) box.scrollTop = box.scrollHeight;
  }

  // ---------- Playback sync ----------
  function setMode(m) {
    if (m !== 'youtube' && ytPlayer?.pauseVideo) ytPlayer.pauseVideo();
    if (!['url', 'local', 'stream'].includes(m) && !video.paused) video.pause();
    mode = m;
    render();
  }

  function applyState(s) {
    state = s;
    if (!s) { updateNow(); return; }
    if (s.mode !== 'none' && outStream) stopStreaming();

    if (s.mode === 'youtube') applyYouTube(s);
    else if (s.mode === 'url') applyVideo(s, s.source);
    else if (s.mode === 'local') {
      if (localFile && localFile.accepted === s.source) applyVideo(s, localFile.url);
      else setMode('local');
    } else if (mode !== 'stream') setMode('none');
    updateNow();
  }

  function playBlocked() { toast('Press ▶ on the video to start watching'); }

  function applyVideo(s, src) {
    setMode(s.mode);
    if (video.dataset.src !== src) {
      video.srcObject = null;
      video.muted = false;
      video.dataset.src = src;
      video.src = src;
    }
    const go = () => {
      if (state !== s) return;
      const target = expectedTime(s);
      if (Math.abs(video.currentTime - target) > 1.5) video.currentTime = target;
      if (s.playing && video.paused) video.play().catch(playBlocked);
      if (!s.playing && !video.paused) video.pause();
    };
    if (video.readyState >= 1) go();
    else video.addEventListener('loadedmetadata', go, { once: true });
  }

  // Is my player showing the same thing as the shared state?
  function playerMatches() {
    if (!state || state.mode !== mode) return false;
    if (mode === 'youtube') return ytCurrentId === state.source;
    if (mode === 'url') return video.dataset.src === state.source;
    if (mode === 'local') return !!localFile && localFile.accepted === state.source && video.dataset.src === localFile.url;
    return false;
  }

  // The user did something on their player: tell everyone, unless it already matches.
  function localChanged(playing, time) {
    if (!playerMatches()) return;
    if (state.playing === playing && Math.abs(expectedTime(state) - time) < 1.5) return;
    state = { ...state, playing, time, updatedAt: serverNow(), by: myName };
    socket.emit('sync', state);
    updateNow();
  }

  function startSource(m, source, playing) {
    if (outStream) stopStreaming();
    const s = { mode: m, source, playing, time: 0, updatedAt: serverNow(), by: myName };
    socket.emit('sync', s);
    applyState(s);
  }

  video.addEventListener('play', () => { if (mode === 'url' || mode === 'local') localChanged(true, video.currentTime); });
  video.addEventListener('pause', () => { if (mode === 'url' || mode === 'local') localChanged(false, video.currentTime); });
  video.addEventListener('seeked', () => { if (mode === 'url' || mode === 'local') localChanged(!video.paused, video.currentTime); });
  video.addEventListener('error', () => {
    if (mode === 'url') toast("This link can't be played. It must be a direct link to a video file.");
  });

  // ---------- YouTube ----------
  let ytPlayer = null;
  let ytReady = null;
  let ytCurrentId = null;
  let ytSuppressUntil = 0;
  let ytLast = null;

  function loadYT() {
    if (ytReady) return ytReady;
    ytReady = new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = () => {
        ytPlayer = new YT.Player('yt', {
          width: '100%',
          height: '100%',
          playerVars: { playsinline: 1, rel: 0 },
          events: { onReady: () => resolve(ytPlayer), onStateChange: onYTState },
        });
      };
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    });
    return ytReady;
  }

  async function applyYouTube(s) {
    setMode('youtube');
    const p = await loadYT();
    if (state !== s) return;
    const t = expectedTime(s);
    ytSuppressUntil = Date.now() + 1500;
    ytLast = null;
    if (ytCurrentId !== s.source) {
      ytCurrentId = s.source;
      if (s.playing) p.loadVideoById({ videoId: s.source, startSeconds: t });
      else p.cueVideoById({ videoId: s.source, startSeconds: t });
      return;
    }
    const ps = p.getPlayerState();
    if (ps !== 5 && Math.abs(p.getCurrentTime() - t) > 1.5) p.seekTo(t, true);
    if (s.playing && ps !== 1 && ps !== 3) p.playVideo();
    if (!s.playing && (ps === 1 || ps === 3)) p.pauseVideo();
  }

  function onYTState(e) {
    if (mode !== 'youtube' || Date.now() < ytSuppressUntil) return;
    if (e.data === 1) localChanged(true, ytPlayer.getCurrentTime());
    else if (e.data === 2 || e.data === 0) localChanged(false, ytPlayer.getCurrentTime());
  }

  // YouTube has no "seeked" event, so watch for jumps in the position.
  setInterval(() => {
    if (mode !== 'youtube' || !ytPlayer?.getPlayerState) return;
    const ps = ytPlayer.getPlayerState();
    if (ps !== 1 && ps !== 2) { ytLast = null; return; }
    const t = ytPlayer.getCurrentTime();
    const now = Date.now();
    const playing = ps === 1;
    if (ytLast && now > ytSuppressUntil) {
      const predicted = ytLast.t + (ytLast.playing ? (now - ytLast.at) / 1000 : 0);
      if (Math.abs(t - predicted) > 2) localChanged(playing, t);
    }
    ytLast = { t, at: now, playing };
  }, 1000);

  // Gently pull everyone back together if they drift apart.
  setInterval(() => {
    if (!state || !state.playing || !playerMatches()) return;
    const target = expectedTime(state);
    if (mode === 'youtube') {
      if (ytPlayer?.getPlayerState?.() !== 1) return;
      if (Math.abs(ytPlayer.getCurrentTime() - target) > 2) {
        ytSuppressUntil = Date.now() + 1500;
        ytLast = null;
        ytPlayer.seekTo(target, true);
      }
    } else if (!video.paused && video.readyState >= 3 && Math.abs(video.currentTime - target) > 2) {
      video.currentTime = target;
    }
  }, 4000);

  // ---------- Source controls ----------
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('.tab').forEach((t) => show('#' + t.id, t.id === 'tab-' + b.dataset.tab));
    };
  });

  $('#ytBtn').onclick = () => {
    const id = youtubeId($('#ytInput').value);
    if (!id) return toast("That doesn't look like a YouTube link");
    $('#ytInput').value = '';
    startSource('youtube', id, true);
  };
  $('#ytInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#ytBtn').click(); });

  $('#urlBtn').onclick = () => {
    const raw = $('#urlInput').value.trim();
    let url;
    try { url = new URL(raw); } catch { return toast('Enter a full link starting with https://'); }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && location.protocol === 'http:')) {
      return toast('The link must start with https://');
    }
    if (youtubeId(raw)) return toast('That is a YouTube link — use the YouTube tab');
    $('#urlInput').value = '';
    startSource('url', url.href, true);
  };
  $('#urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#urlBtn').click(); });

  function loadLocal(file, accepted) {
    if (localFile) URL.revokeObjectURL(localFile.url);
    localFile = { name: file.name, url: URL.createObjectURL(file), accepted };
  }

  $('#localFile').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    loadLocal(f, f.name);
    startSource('local', f.name, false);
    toast('Ask your friends to choose the same file, then press ▶');
  };

  $('#localPromptFile').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f || !state) return;
    loadLocal(f, state.source);
    if (f.name !== state.source) toast(`Your file is named "${f.name}" — make sure it's the same video.`);
    applyState(state);
  };

  $('#resyncBtn').onclick = () => {
    if (!socket) return;
    socket.emit('get-state', (s) => { if (s) applyState(s); toast('Re-synced with the room'); });
  };

  // ---------- Chat ----------
  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#chatInput').value.trim();
    if (!text) return;
    socket.emit('chat', text);
    $('#chatInput').value = '';
  };

  // ---------- WebRTC (voice + streaming) ----------
  const peers = new Map();          // peerId -> { pc, polite, makingOffer, ignoreOffer, micSenders, streamSenders, queue }
  const remoteStreams = new Map();  // streamId -> MediaStream
  const audioEls = new Map();       // streamId -> { el, peerId }
  let micStream = null;
  let outStream = null;
  let outStreamKind = null;
  let outStreamUrl = null;

  function getPeer(id) {
    if (peers.has(id)) return peers.get(id);
    const pc = new RTCPeerConnection({ iceServers });
    const peer = { pc, polite: myId < id, makingOffer: false, ignoreOffer: false, micSenders: [], streamSenders: [], queue: Promise.resolve() };
    peers.set(id, peer);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        socket.emit('signal', { to: id, data: { description: pc.localDescription } });
      } catch (err) {
        console.warn('negotiation', err);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('signal', { to: id, data: { candidate } });
    };
    pc.ontrack = ({ track, streams }) => onRemoteTrack(id, track, streams[0]);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && pc.restartIce) pc.restartIce();
    };

    if (micStream) micStream.getTracks().forEach((t) => peer.micSenders.push(pc.addTrack(t, micStream)));
    if (outStream) outStream.getTracks().forEach((t) => peer.streamSenders.push(pc.addTrack(t, outStream)));
    return peer;
  }

  function closePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    p.pc.close();
    peers.delete(id);
    for (const [sid, a] of audioEls) {
      if (a.peerId === id) { a.el.remove(); audioEls.delete(sid); }
    }
  }

  // "Perfect negotiation": both sides may start offers without clashing.
  function handleSignal({ from, data }) {
    const peer = getPeer(from);
    peer.queue = peer.queue.then(async () => {
      const pc = peer.pc;
      try {
        if (data.description) {
          const d = data.description;
          const collision = d.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
          peer.ignoreOffer = !peer.polite && collision;
          if (peer.ignoreOffer) return;
          await pc.setRemoteDescription(d);
          if (d.type === 'offer') {
            await pc.setLocalDescription();
            socket.emit('signal', { to: from, data: { description: pc.localDescription } });
          }
        } else if (data.candidate) {
          try { await pc.addIceCandidate(data.candidate); } catch (err) { if (!peer.ignoreOffer) console.warn(err); }
        }
      } catch (err) {
        console.warn('signal', err);
      }
    });
  }

  function onRemoteTrack(peerId, track, stream) {
    if (!stream) return;
    remoteStreams.set(stream.id, stream);
    stream.onremovetrack = () => {
      if (stream.getTracks().length) return;
      remoteStreams.delete(stream.id);
      const a = audioEls.get(stream.id);
      if (a) { a.el.remove(); audioEls.delete(stream.id); }
    };

    const isStream = currentStream && stream.id === currentStream.streamId;
    if (!isStream && track.kind === 'audio' && !stream.getVideoTracks().length && !audioEls.has(stream.id)) {
      // A friend's microphone
      const el = document.createElement('audio');
      el.autoplay = true;
      el.srcObject = stream;
      $('#audios').append(el);
      el.play().catch(() => toast('Click anywhere to hear voice chat'));
      audioEls.set(stream.id, { el, peerId });
    }
    render();
  }

  // Browsers may block audio until the page is clicked; retry on first click.
  document.addEventListener('click', () => {
    audioEls.forEach((a) => { if (a.el.paused) a.el.play().catch(() => {}); });
    if (streamVideo.srcObject && streamVideo.muted) { streamVideo.muted = false; }
  });

  function updateMicBtn() {
    const b = $('#micBtn');
    b.textContent = micStream ? '🎤 Mic on' : '🎤 Turn mic on';
    b.classList.toggle('on', !!micStream);
  }

  $('#micBtn').onclick = async () => {
    if (micStream) {
      for (const p of peers.values()) {
        p.micSenders.forEach((s) => { try { p.pc.removeTrack(s); } catch { /* closed */ } });
        p.micSenders = [];
      }
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
      socket.emit('mic', false);
      updateMicBtn();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) return toast('Voice needs a secure (https) address.');
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      return toast('Microphone permission was denied.');
    }
    for (const p of peers.values()) {
      micStream.getTracks().forEach((t) => p.micSenders.push(p.pc.addTrack(t, micStream)));
    }
    socket.emit('mic', true);
    updateMicBtn();
    toast('Mic on — headphones help avoid echo');
  };

  function addStreamTrack(track) {
    for (const p of peers.values()) p.streamSenders.push(p.pc.addTrack(track, outStream));
  }

  function startStream(stream, kind) {
    outStream = stream;
    outStreamKind = kind;
    stream.getVideoTracks().forEach((t) => { t.contentHint = 'motion'; });
    for (const p of peers.values()) stream.getTracks().forEach((t) => p.streamSenders.push(p.pc.addTrack(t, stream)));
    stream.addEventListener('addtrack', (e) => { if (outStream === stream) addStreamTrack(e.track); });
    if (kind === 'screen') {
      stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (outStream === stream) stopStreaming(); });
    }

    // Stop everyone's player, then announce the stream.
    state = { mode: 'none', source: '', playing: false, time: 0, updatedAt: serverNow(), by: myName };
    socket.emit('sync', state);
    socket.emit('stream-start', { streamId: stream.id });
    currentStream = { by: myId, name: myName, streamId: stream.id };
    renderPeople();
    render();
  }

  function stopStreaming() {
    if (!outStream) return;
    for (const p of peers.values()) {
      p.streamSenders.forEach((s) => { try { p.pc.removeTrack(s); } catch { /* closed */ } });
      p.streamSenders = [];
    }
    if (outStreamKind === 'screen') outStream.getTracks().forEach((t) => t.stop());
    outStream = null;
    outStreamKind = null;
    socket.emit('stream-stop');
    if (currentStream?.by === myId) currentStream = null;
    if (mode === 'stream') {
      video.pause();
      video.srcObject = null;
      video.removeAttribute('src');
      video.dataset.src = '';
      video.muted = false;
      video.load();
      mode = 'none';
    }
    if (outStreamUrl) { URL.revokeObjectURL(outStreamUrl); outStreamUrl = null; }
    renderPeople();
    render();
  }

  const canCapture = !!(HTMLMediaElement.prototype.captureStream || HTMLMediaElement.prototype.mozCaptureStream);
  if (!canCapture) show('#streamFileLabel', false);
  if (!navigator.mediaDevices?.getDisplayMedia) show('#screenBtn', false);

  $('#streamFile').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    stopStreaming();
    setMode('stream');
    outStreamUrl = URL.createObjectURL(f);
    video.srcObject = null;
    video.muted = false;
    video.dataset.src = outStreamUrl;
    video.src = outStreamUrl;
    render();
    await new Promise((r) => (video.readyState >= 1 ? r() : video.addEventListener('loadedmetadata', r, { once: true })));
    try { await video.play(); } catch { toast('Press ▶ to start the stream'); }
    const captured = video.captureStream ? video.captureStream() : video.mozCaptureStream();
    startStream(captured, 'file');
    toast(`Streaming "${f.name}" — use the player controls to pause or seek`);
  };

  $('#screenBtn').onclick = async () => {
    let s;
    try {
      s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    } catch {
      return;
    }
    stopStreaming();
    setMode('stream');
    video.removeAttribute('src');
    video.dataset.src = '';
    video.srcObject = s;
    video.muted = true; // local preview only
    video.play().catch(() => {});
    startStream(s, 'screen');
    if (!s.getAudioTracks().length) toast('No sound is shared. In Chrome, share a tab and tick "Share tab audio".');
  };

  $('#stopStreamBtn').onclick = () => stopStreaming();

  // ---------- Top bar ----------
  $('#copyBtn').onclick = async () => {
    const link = `${location.origin}/room/${roomId}`;
    if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
      navigator.share({ title: 'Watch with me', url: link }).catch(() => {});
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied — send it to your friends!');
    } catch {
      prompt('Copy this invite link:', link);
    }
  };
  $('#leaveBtn').onclick = () => { location.href = '/'; };
})();
