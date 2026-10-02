// Shared reverb impulse: decaying noise, low-passed in the tail (plate-ish).
function impulse(c, dur, decay) {
  const n = Math.floor(c.sampleRate * dur), b = c.createBuffer(2, n, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch), lp = [0, 0];
    for (let i = 0; i < n; i++) {
      lp[ch] += (Math.random() * 2 - 1 - lp[ch]) * 0.14;   // one-pole LP keeps it smooth, not hissy
      d[i] = lp[ch] * Math.pow(1 - i / n, decay);
    }
  }
  return b;
}

// Audio engine: global transport + look-ahead scheduler + bar-quantized clip launching.
const STEPS = 16, SCENES = 5, PADS = 16;
const SCENE_NAMES = ['INTRO', 'VERSE', 'PRECHO', 'CHORUS', 'BRIDGE'];   // song sections; renameable in the UI
const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 6300, 8000, 12500, 16000];
const mk = (...on) => ({ type: 'seq', steps: Array.from({ length: STEPS }, (_, i) => on.includes(i)) });

class Engine {
  constructor() {
    const c = (this.ctx = new AudioContext({ latencyHint: 'interactive' }));
    this.master = c.createGain(); this.master.gain.value = 0.8;
    this.analyser = c.createAnalyser(); this.analyser.fftSize = 512;
    this.eq = EQ_FREQS.map((f, i) => {   // low shelf, 10 peaking bands, high shelf
      const b = c.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f; b.Q.value = 1.4; b.gain.value = 0;
      return b;
    });
    this.eqVals = Array(EQ_FREQS.length).fill(0);   // requested dB per band (the AudioParam lags behind)
    [this.master, ...this.eq, this.analyser].reduce((a, b) => a.connect(b));
    this.analyser.connect(c.destination);
    this._buf = new Float32Array(this.analyser.fftSize);
    this.bpm = 120; this.playing = false; this.step = 0; this.nextTime = 0;
    this.sceneNames = [...SCENE_NAMES];
    this.fadeSec = 2; this.glide = null;   // scene changes glide over this many seconds
    this.sceneMix = Array.from({ length: SCENES }, () => null);   // per-scene mixer/FX snapshots (captured from the UI)
    this.visual = []; this.playhead = -1; this.error = '';
    this.live = []; this.held = new Set(); this.sus = false;   // live MIDI voices + held keys + pedal

    // shared send FX buses: plate-style reverb + tempo-synced echo (dotted 8th)
    this.verb = c.createConvolver(); this.verb.buffer = impulse(c, 1.8, 2.5);
    const verbOut = c.createGain(); verbOut.gain.value = 0.45; this.verb.connect(verbOut).connect(this.master);
    this.dly = c.createDelay(2); this.dly.delayTime.value = 60 / this.bpm * 0.75;
    const fb = c.createGain(); fb.gain.value = 0.42;
    const damp = c.createBiquadFilter(); damp.type = 'lowpass'; damp.frequency.value = 2400;
    const dlyOut = c.createGain(); dlyOut.gain.value = 0.5;
    this.dly.connect(damp); damp.connect(fb); fb.connect(this.dly); damp.connect(dlyOut); dlyOut.connect(this.master);

    const track = (name, ...clips) => {
      const out = c.createGain(); out.gain.value = 0.8;   // volume
      const pan = c.createStereoPanner();                 // stereo position
      const filt = c.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 20000; filt.Q.value = 0.707;
      const pre = c.createGain();   // FX taps run before volume, pan and mute, so tails stay smooth
      out.connect(pan); pan.connect(pre); pre.connect(filt); filt.connect(this.master);
      const sends = [this.verb, this.dly].map(bus => {   // per-layer send levels into the two buses
        const g = c.createGain(); g.gain.value = 0; pre.connect(g).connect(bus); return g;
      });
      return { name, out, panNode: pan, filt, sends, clips: [...clips, ...Array(SCENES - clips.length).fill(null)],
               active: -1, queued: null, src: null, sf: null, preset: 0, key: 60,
               vol: 0.8, pan: 0, sustain: 1, cutHz: 20000, send: 0, echo: 0,
               mute: false, solo: false, midi: false };
    };
    const P = [[[0, 4, 8, 12], [0, 3, 8, 11]], [[4, 12], [4, 10, 12, 15]], [[2, 6, 10, 14], [0, 2, 4, 6, 8, 10, 12, 14]],
               [[0, 3, 6, 10], [0, 6, 8, 14]], [[0, 8], [0, 4, 8, 12]], [[6, 14], [2, 6, 10, 14]]];
    this.tracks = P.map((pats, i) => track(`Layer ${i + 1}`, ...pats.map(p => mk(...p))));

    // pads: a bank of clickable pads, each with its own note and SoundFont. They go straight to the master
    // (so they pass through the EQ and are heard in "Session output" recordings). A pad has the same fields
    // voiceOn() reads from a layer (sf, preset, sustain, out), so it sounds exactly like a layer does.
    this.padBus = c.createGain(); this.padBus.gain.value = 0.9; this.padBus.connect(this.master);
    this.pads = Array.from({ length: PADS }, (_, i) => ({ out: this.padBus, sf: null, sfName: null, sfPath: null, preset: 0, key: 60 + i, sustain: 1 }));
  }

  // ---- pads ----
  loadPadSF2(i, data, name) { Object.assign(this.pads[i], { sf: parseSF2(data), sfName: name, preset: 0 }); }
  shareSF2(i, from) { Object.assign(this.pads[i], { sf: from.sf, sfName: from.sfName, sfPath: from.sfPath, preset: 0 }); }   // same parsed SoundFont on many pads: parsed once, one copy in memory
  clearPad(i) { Object.assign(this.pads[i], { sf: null, sfName: null, sfPath: null, preset: 0 }); }
  padOn(i, vel = 100) {   // returns the voice handle to release later, or null when there is nothing to play
    const p = this.pads[i];
    if (!p?.sf) return null;
    this.ctx.resume();
    return this.voiceOn(p, p.key, vel, this.ctx.currentTime + 0.003);
  }
  padOff(parts) { if (parts) this._rel(parts, this.ctx.currentTime); }
  padFade(parts, sec = 1.5) {   // glide a held pad to silence over `sec` seconds, then stop it (never a click)
    if (!parts) return;
    const now = this.ctx.currentTime;
    for (const s of parts) {
      if (s.relDone) continue; s.relDone = true;
      (s.p.cancelAndHoldAtTime ? s.p.cancelAndHoldAtTime : s.p.cancelScheduledValues).call(s.p, now);
      s.p.setTargetAtTime(0, now, Math.max(0.02, sec) / 4);
      s.src.stop(now + Math.max(0.05, sec) + 0.15);
    }
  }
  setPadVol(v) { this.padBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }

  // ---- transport ----
  async play() {
    if (this.playing) return;
    this.playing = true; this.error = '';
    if (this.tracks.every(t => t.active === -1 && t.queued === null))   // nothing launched: start scene 1
      this.tracks.forEach(t => { if (t.clips[0]) t.queued = 0; });
    await Promise.race([this.ctx.resume(), new Promise(r => setTimeout(r, 2000))]);
    if (this.ctx.state !== 'running') this.error = 'No audio output is running. Check your system output device.';
    this.step = 0; this.nextTime = this.ctx.currentTime + 0.06;
    this.timer = setInterval(() => this._pump(), 25);
  }
  stop() {
    clearInterval(this.timer);
    this.playing = false; this.visual = []; this.playhead = -1;
    for (const tr of this.tracks) { tr.src?.stop(); tr.src = null; tr.active = -1; tr.queued = null; }
  }
  _pump() {
    while (this.nextTime < this.ctx.currentTime + 0.12) {   // schedule 120 ms ahead
      this._at(this.step, this.nextTime);
      this.nextTime += 60 / this.bpm / 4;                   // 16th note
      this.step = (this.step + 1) % STEPS;
    }
  }
  tick() {   // UI side: move the playhead as audio time passes
    while (this.visual.length && this.visual[0].time <= this.ctx.currentTime) this.playhead = this.visual.shift().step;
    this._glideStep();
  }

  // ---- clips ----
  newClip(t, s) { this.tracks[t].clips[s] = mk(); }
  toggle(t, s) {   // launch or stop at the next bar
    const tr = this.tracks[t];
    if (!tr.clips[s]) return;
    tr.queued = tr.queued === s ? null : (tr.active === s ? -1 : s);
    this.play();
  }
  launchScene(s) { this.tracks.forEach(tr => { if (tr.clips[s]) tr.queued = s; }); this.play(); }

  // ---- scene snapshots: each scene remembers the layers' mixer + FX settings and the master EQ.
  //      Never the SoundFont / preset (the voice), the clips, MIDI routing or record-arm. ----
  captureScene(s) {
    this.sceneMix[s] = {
      eq: [...this.eqVals],
      layers: this.tracks.map(tr => ({ vol: tr.vol, pan: tr.pan, sustain: tr.sustain, cut: tr.cutHz ?? 20000,
                                       send: tr.send ?? 0, dly: tr.echo ?? 0, mute: tr.mute, solo: tr.solo })),
    };
  }
  applyScene(s, sec = this.fadeSec) {   // glide every layer (and the EQ) to the scene's saved settings; false if none saved yet
    const snap = this.sceneMix[s];
    if (!snap) return false;
    const layers = Array.isArray(snap) ? snap : snap.layers || [], now = this.ctx.currentTime;
    const flags = this.tracks.map((tr, t) => layers[t] ? { mute: !!layers[t].mute, solo: !!layers[t].solo } : { mute: tr.mute, solo: tr.solo });
    const anySolo = flags.some(f => f.solo);
    const items = [];
    layers.forEach((m, t) => {
      const tr = this.tracks[t];
      if (!m || !tr) return;
      const to = { vol: m.vol ?? tr.vol, pan: m.pan ?? tr.pan, sustain: m.sustain ?? tr.sustain, cut: m.cut ?? tr.cutHz ?? 20000,
                   send: m.send ?? tr.send ?? 0, dly: m.dly ?? tr.echo ?? 0, ...flags[t] };
      items.push({ t, to,
        from: { vol: tr.vol, pan: tr.pan, sustain: tr.sustain, cut: tr.cutHz ?? 20000, send: tr.send ?? 0, dly: tr.echo ?? 0 },
        g0: tr.effGain ?? this._gain(tr),                                   // what you hear now
        g1: to.mute || (anySolo && !to.solo) ? 0 : to.vol });               // what you will hear at the end
    });
    this.glide = { t0: now, dur: Math.max(0, +sec || 0), items, eq0: [...this.eqVals], eq1: snap.eq || null };
    this._glideStep();
    return true;
  }
  _glideStep() {   // runs every UI frame: moves faders, pan, filter, sends and EQ a little at a time
    const g = this.glide;
    if (!g) return;
    const now = this.ctx.currentTime, k = g.dur ? Math.min(1, (now - g.t0) / g.dur) : 1, e = k * k * (3 - 2 * k);   // smoothstep
    const L = (a, b) => a + (b - a) * e;
    for (const it of g.items) {
      const tr = this.tracks[it.t], f = it.from, o = it.to;
      if (k >= 1) {   // land exactly on the saved values, then flip mute/solo (gain is already there, so no jump)
        ['vol', 'pan', 'sustain', 'cut', 'send', 'dly'].forEach(p => this.setTrack(it.t, p, o[p]));
        this.setTrack(it.t, 'mute', o.mute); this.setTrack(it.t, 'solo', o.solo);
        tr.effGain = undefined;
        continue;
      }
      tr.vol = L(f.vol, o.vol); tr.sustain = L(f.sustain, o.sustain);
      tr.pan = L(f.pan, o.pan); tr.panNode.pan.setTargetAtTime(tr.pan, now, 0.03);
      tr.cutHz = 10 ** L(Math.log10(f.cut), Math.log10(o.cut)); tr.filt.frequency.setTargetAtTime(Math.max(40, tr.cutHz), now, 0.03);
      tr.send = L(f.send, o.send); tr.sends[0].gain.setTargetAtTime(tr.send, now, 0.03);
      tr.echo = L(f.dly, o.dly); tr.sends[1].gain.setTargetAtTime(tr.echo, now, 0.03);
      tr.effGain = L(it.g0, it.g1); tr.out.gain.setTargetAtTime(tr.effGain, now, 0.03);
    }
    if (g.eq1) g.eq1.forEach((db, i) => { if (this.eq[i]) this.setEq(i, g.eq0[i] + (db - g.eq0[i]) * e); });
    if (k >= 1) this.glide = null;
  }
  async addSample(t, s, data, name) {
    this.tracks[t].clips[s] = { type: 'sample', name, buffer: await this.ctx.decodeAudioData(data) };
  }

  _at(step, time) {
    this.visual.push({ step, time });
    for (const tr of this.tracks) {
      if (step === 0 && tr.queued !== null) this._apply(tr, time);   // launches land on the bar line
      const cl = tr.clips[tr.active];
      if (cl?.type === 'seq' && cl.steps[step]) this._hit(tr, time);
    }
  }
  _apply(tr, time) {
    tr.src?.stop(time); tr.src = null;
    tr.active = tr.queued; tr.queued = null;
    const cl = tr.clips[tr.active];
    if (cl?.type === 'sample') {
      const s = this.ctx.createBufferSource();
      s.buffer = cl.buffer; s.loop = true; s.connect(tr.out); s.start(time); tr.src = s;
    }
  }

  // ---- sound: each layer plays its own SoundFont ----
  loadSF2(t, data, name) { Object.assign(this.tracks[t], { sf: parseSF2(data), sfName: name, preset: 0 }); }
  _hit(tr, t) {   // sequencer note: spawn now, release after its step length
    if (!tr.sf) return;
    const parts = this.voiceOn(tr, tr.key, 100, t);
    if (!parts) return;
    const until = t + 60 / this.bpm / 4 * 0.9, voice = { parts, kind: 'seq', until };
    this.live.push(voice);
    setTimeout(() => {
      this._rel(parts, Math.max(until, this.ctx.currentTime));
      this.live = this.live.filter(v => v !== voice);   // forget it, or the list grows all session
    }, (until - this.ctx.currentTime) * 1000 + 30);
  }
  voiceOn(tr, key, vel, t) {   // spawn all sounding zones for a note; returns release handles
    const c = this.ctx, tc = v => 2 ** (v / 1200), parts = [];
    for (const { sample, g } of zonesFor(tr.sf, tr.preset, key, vel)) {
      const sh = tr.sf.shdr[sample], buf = sfBuffer(c, tr.sf, sample);
      if (!buf) continue;
      const v = (op, d = 0) => g[op]?.val ?? d;
      const root = g[58] && g[58].val >= 0 ? g[58].val : (sh.pitch === 255 ? 60 : sh.pitch);
      const src = c.createBufferSource(); src.buffer = buf;
      src.playbackRate.value = 2 ** (((key - root) * v(56, 100) + v(51) * 100 + v(52) + sh.corr) / 1200);
      const loop = v(54) === 1 || v(54) === 3;
      if (loop) { src.loop = true; src.loopStart = (sh.sLoop - sh.start) / buf.sampleRate; src.loopEnd = (sh.eLoop - sh.start) / buf.sampleRate; }
      const amp = 10 ** (-v(48) / 200) * (vel / 127), a = tc(v(34, -12000)) + 0.001, h = tc(v(35, -12000)),
            dec = Math.max(tc(v(36, -12000)), tr.sustain < 1 ? 0.35 : 0),   // a lowered sustain needs a real decay, not a click
            sus = 10 ** (-Math.max(0, v(37)) / 200) * tr.sustain, rel = Math.max(tc(v(38, -12000)), 0.03);
      const gn = c.createGain(), p = gn.gain;
      p.setValueAtTime(0, t); p.linearRampToValueAtTime(amp, t + a);
      p.setValueAtTime(amp, t + a + h); p.setTargetAtTime(amp * sus, t + a + h, dec / 3 + 0.001);
      src.connect(gn).connect(tr.out); src.start(t);
      parts.push({ src, p, amp, sus, rel, loop, end: t + buf.duration / src.playbackRate.value, rate0: src.playbackRate.value });
    }
    return parts.length ? parts : null;
  }
  _rel(parts, tOff) {   // release a voice: fade through its own envelope, never a click
    tOff = Math.max(tOff, this.ctx.currentTime);
    for (const s of parts) {
      if (s.relDone) continue; s.relDone = true;
      if (s.loop || tOff < s.end - 0.001) {
        (s.p.cancelAndHoldAtTime ? s.p.cancelAndHoldAtTime : s.p.cancelScheduledValues).call(s.p, tOff);
        s.p.setTargetAtTime(0, tOff, s.rel / 3);
      }
      s.src.stop(tOff + s.rel + 0.05);
    }
  }

  // ---- live MIDI: held notes, sustain pedal, pitch bend ----
  midi(t, key, vel) {   // note on from a controller
    const tr = this.tracks[t];
    if (!tr?.sf) return;   // nothing loaded on this layer yet: ignore the key
    this.ctx.resume();
    this.held.add(t + ':' + key);
    const parts = this.voiceOn(tr, key, Math.max(1, Math.round(vel * 127)), this.ctx.currentTime + 0.005);   // vel is 0..1 here, voiceOn wants 1..127
    if (parts) this.live.push({ t, key, parts, kind: 'midi' });
  }
  midiOff(t, key) {
    this.held.delete(t + ':' + key);
    if (!this.sus) this.noteStop(t, key);   // pedal down: let it ring until the pedal lifts
  }
  noteStop(t, key) {
    const now = this.ctx.currentTime;
    this.live = this.live.filter(v => {
      if (v.kind !== 'midi' || v.t !== t || v.key !== key) return true;
      this._rel(v.parts, now); return false;
    });
  }
  sustain(on) {   // damper pedal (CC64): release only notes whose keys are physically up
    this.sus = on;
    if (!on) for (const v of [...this.live]) if (v.kind === 'midi' && !this.held.has(v.t + ':' + v.key)) this.noteStop(v.t, v.key);
  }
  bend(v) {   // -1..1 -> ±2 semitones on every sounding voice
    const r = 2 ** (v * 2 / 12), now = this.ctx.currentTime;
    for (const { parts } of this.live) for (const s of parts) s.src.playbackRate.setTargetAtTime(s.rate0 * r, now, 0.01);
  }

  setEq(i, db) { this.eqVals[i] = db; this.eq[i].gain.setTargetAtTime(db, this.ctx.currentTime, 0.02); }   // smoothed, no zipper noise
  beep() {   // test tone: proves speakers, master, EQ and meter work with nothing loaded
    this.ctx.resume();
    const c = this.ctx, t = c.currentTime + 0.02, o = c.createOscillator(), g = c.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(440, t); o.frequency.exponentialRampToValueAtTime(220, t + 0.4);
    g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(0.4, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.55);
  }

  // ---- per-layer mixer & FX: volume, pan, mute/solo, filter cutoff, send levels ----
  _gain(tr) { return tr.mute || (this.tracks.some(x => x.solo) && !tr.solo) ? 0 : tr.vol; }
  setTrack(t, prop, v) {
    const tr = this.tracks[t], now = this.ctx.currentTime;
    tr[prop] = v;
    if (prop === 'cut') tr.cutHz = v; else if (prop === 'send') tr.send = v; else if (prop === 'dly') tr.echo = v;   // state mirrors for rig save
    if (prop === 'vol') tr.out.gain.setTargetAtTime(this._gain(tr), now, 0.02);
    else if (prop === 'pan') tr.panNode.pan.setTargetAtTime(v, now, 0.02);
    else if (prop === 'mute' || prop === 'solo') this.tracks.forEach(x => x.out.gain.setTargetAtTime(this._gain(x), now, 0.02));
    else if (prop === 'midi') {
      tr.midi = v;
      if (!v) {   // unrouting: release the layer's held notes and forget its keys
        for (const vo of [...this.live]) if (vo.kind === 'midi' && vo.t === t) this.noteStop(t, vo.key);
        this.held = new Set([...this.held].filter(h => !h.startsWith(t + ':')));
      }
    }
    else if (prop === 'cut') tr.filt.frequency.setTargetAtTime(Math.max(40, v), now, 0.03);
    else if (prop === 'send') tr.sends[0].gain.setTargetAtTime(v, now, 0.02);
    else if (prop === 'dly') tr.sends[1].gain.setTargetAtTime(v, now, 0.02);
  }
  setBpm(v) { this.bpm = v; this.dly.delayTime.setTargetAtTime(60 / v * 0.75, this.ctx.currentTime, 0.05); }   // keep the echo in tempo

  // ---- audio interface: choose the input device, meter it, optionally hear it through the master chain ----
  _inConstraints() {
    return { deviceId: this.inputId ? { exact: this.inputId } : undefined, channelCount: { ideal: 2 },
             echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  }
  async openInput(on) {
    if (this.inp) { this.inp.stream.getTracks().forEach(t => t.stop()); this.inp.src.disconnect(); this.inp.gain.disconnect(); this.inp.mon.disconnect(); this.inp = null; }
    if (!on) return;
    await this.ctx.resume();
    const c = this.ctx, stream = await navigator.mediaDevices.getUserMedia({ audio: this._inConstraints() });
    const src = c.createMediaStreamSource(stream), gain = c.createGain(), an = c.createAnalyser(), mon = c.createGain();
    gain.gain.value = this.inGain ?? 1; an.fftSize = 512; mon.gain.value = this.monitorOn ? 1 : 0;
    src.connect(gain); gain.connect(an); gain.connect(mon); mon.connect(this.master);
    this.inp = { stream, src, gain, an, mon, buf: new Float32Array(an.fftSize) };
  }
  setMonitor(on) { this.monitorOn = on; if (this.inp) this.inp.mon.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02); }
  setInputGain(v) { this.inGain = v; if (this.inp) this.inp.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
  inputLevel() {
    if (!this.inp) return 0;
    this.inp.an.getFloatTimeDomainData(this.inp.buf);
    let p = 0; for (const v of this.inp.buf) p = Math.max(p, Math.abs(v));
    return p;
  }
  setSink(id) { return this.ctx.setSinkId ? this.ctx.setSinkId(id || '') : Promise.reject(new Error('this phone picks the output itself')); }
  level() {
    this.analyser.getFloatTimeDomainData(this._buf);
    let p = 0; for (const v of this._buf) p = Math.max(p, Math.abs(v));
    return p;
  }
}
