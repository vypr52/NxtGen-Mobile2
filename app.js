const e = new Engine();
const $ = s => document.querySelector(s);
const COLORS = ['#ef476f', '#ffd166', '#06d6a0', '#8d99ff', '#f78c6b', '#5ec8ff'];
let sel = { t: 0, s: 0 };

// ---- clip grid: tracks are columns, scenes are rows ----
const grid = $('#grid'), layers = $('#layers'), cells = [];
const uiLayers = [];                       // per-layer UI refs for rig save/load
const samplePaths = e.tracks.map(() => Array(SCENES).fill(null));   // where dropped samples live on disk
const realPath = f => (window.rig?.pathOf ? window.rig.pathOf(f) : null);   // null outside Electron / virtual files
e.tracks.forEach((tr, t) => {
  const $c = tag => document.createElement(tag);
  const h = $c('div'), nm = $c('div'), load = $c('button'), pre = $c('select'), kl = $c('label'), key = $c('input'), file = $c('input');
  const ms = $c('div'), mb = $c('button'), sb = $c('button'), nb = $c('button');
  const mkRange = (min, max, step, val, prop, label, title) => {
    const wrap = $c('div'), cap = $c('span'), r = $c('input');
    cap.textContent = label; wrap.className = 'fx';
    r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = val; r.title = title;
    r.oninput = () => {
      const v = prop === 'cut' ? 10 ** +r.value : +r.value;   // cutoff slider is log10(Hz)
      e.setTrack(t, prop, v);
      r.title = `${title.split(' (')[0]} (${prop === 'cut' ? Math.round(v) + ' Hz' : prop === 'sustain' ? Math.round(v * 100) + '%' : r.value})`;
    };
    wrap.append(cap, r); wrap.input = r;   // the knob itself, for rig loading
    return wrap;
  };
  const vol = mkRange(0, 1, 0.01, tr.vol, 'vol', 'Vol', 'Layer volume'),
        pan = mkRange(-1, 1, 0.02, 0, 'pan', 'Pan', 'Pan (L … R)'),
        sust = mkRange(0, 1, 0.01, 1, 'sustain', 'Sust', 'Sustain level (100%)'),
        cut = mkRange(1.6, 4.3, 0.01, Math.log10(20000), 'cut', 'Cut', 'Filter cutoff (20000 Hz)'),
        rev = mkRange(0, 1, 0.01, 0, 'send', 'Verb', 'Reverb send'),
        dly = mkRange(0, 1, 0.01, 0, 'dly', 'Echo', 'Echo send (dotted 8th, follows tempo)');
  const fxSliders = { vol, pan, sust, cut, rev, dly };   // refs so rig loading can move the knobs
  mb.textContent = 'M'; mb.title = 'Mute'; sb.textContent = 'S'; sb.title = 'Solo';
  nb.textContent = '♪'; nb.className = 'midi'; nb.title = 'Play this layer live from the MIDI keyboard';
  ms.className = 'ms';
  const msUp = () => { mb.classList.toggle('on', tr.mute); sb.classList.toggle('on', tr.solo); nb.classList.toggle('on', tr.midi); };
  mb.onclick = () => { e.setTrack(t, 'mute', !tr.mute); msUp(); };
  sb.onclick = () => { e.setTrack(t, 'solo', !tr.solo); msUp(); };
  nb.onclick = () => { e.setTrack(t, 'midi', !tr.midi); msUp(); };
  ms.append(mb, sb, nb);
  uiLayers.push({ pre, key, load, msUp, fx: fxSliders });   // after the consts exist: rig save/load touches these
  h.className = 'head'; h.style.setProperty('--c', COLORS[t]); nm.className = 'nm'; nm.textContent = tr.name;
  load.textContent = 'Load SF2'; load.title = 'Load a SoundFont (.sf2), or drop one on this layer';
  file.type = 'file'; file.accept = '.sf2'; file.hidden = true; pre.disabled = true;
  key.type = 'number'; key.min = 0; key.max = 127; key.value = tr.key; key.title = 'MIDI note this layer plays (60 is middle C)';
  const use = async f => {
    if (!f) return;
    try {
      e.loadSF2(t, await f.arrayBuffer(), f.name);
      tr.sfPath = realPath(f);   // remembered so rigs can reload this sound from disk
      pre.innerHTML = ''; tr.sf.presets.forEach((p, i) => pre.add(new Option(`${p.bank}:${p.num} ${p.name}`, i)));
      pre.disabled = false; load.textContent = load.title = f.name;
      if (!e.tracks.some(x => x.midi)) { e.setTrack(t, 'midi', true); msUp(); }   // nothing routed yet: play this layer from the keyboard
    } catch (err) { alert(err.message); }
  };
  load.onclick = () => file.click();
  file.onchange = () => use(file.files[0]);
  h.ondragover = ev => ev.preventDefault();
  h.ondrop = ev => { ev.preventDefault(); use(ev.dataTransfer.files[0]); };
  pre.onchange = () => { tr.preset = +pre.value; };
  key.oninput = () => { tr.key = Math.min(127, Math.max(0, +key.value || 0)); };
  kl.append('Note ', key); h.append(nm, load, pre, kl, ms, vol, pan, sust, cut, rev, dly, file); layers.append(h);
});

// ---- MIDI: route a controller to layers and play them live ----
const midiSel = $('#midi'), midiNote = $('#midiNote');
let midiPort = null;
const noteName = n => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][n % 12] + (Math.floor(n / 12) - 1);
function setMidiStatus(txt) { midiNote.textContent = txt; }
async function initMidi() {
  if (!navigator.requestMIDIAccess) return setMidiStatus('Web MIDI unavailable in this browser.');
  try {
    const acc = await navigator.requestMIDIAccess({ sysex: false });
    const fill = () => {
      midiSel.innerHTML = '';
      const ports = [...acc.inputs.values()];
      if (!ports.length) { midiSel.append(new Option('No MIDI inputs', '')); midiSel.disabled = true; }
      else {
        midiSel.disabled = false;
        midiSel.append(new Option('MIDI input…', ''));
        ports.forEach(p => midiSel.add(new Option(p.name || 'MIDI input', p.id)));
        midiSel.value = '';
      }
    };
    acc.onstatechange = () => { fill(); if (midiPort && !acc.inputs.has(midiPort.id)) { midiPort = null; setMidiStatus('MIDI device unplugged.'); } };
    midiSel.onchange = () => {
      if (midiPort) midiPort.onmidimessage = null;
      midiPort = [...acc.inputs.values()].find(p => p.id === midiSel.value) || null;
      if (midiPort) { midiPort.onmidimessage = onMidi; setMidiStatus(`Listening: ${midiPort.name}`); }
      else setMidiStatus('');
    };
    fill();
    setMidiStatus(ports.length ? 'Pick your MIDI input above.' : 'Connect a MIDI keyboard and press ↻.');
  } catch (err) { setMidiStatus('MIDI access denied: ' + err.message); }
}
function onMidi(ev) {
  const [st, d1, d2] = ev.data, cmd = st & 0xf0, ch = (st & 0x0f) + 1;
  const outs = liveTargets();
  if (!outs.length) return;
  if (cmd === 0x90 && d2 > 0) pianoKey(d1, true, 'midi', d2 / 127);   // pianoKey voices the note and lights the key, once
  else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) pianoKey(d1, false, 'midi');
  else if (cmd === 0xb0 && d1 === 64) e.sustain(d2 >= 64);
  else if (cmd === 0xe0) e.bend(((d2 << 7 | d1) - 8192) / 8192);
}
const liveTargets = () => e.tracks.map((tr, t) => tr.midi ? t : -1).filter(t => t >= 0);
$('#midiScan').onclick = initMidi;
initMidi();

// ---- 88-key virtual piano: mouse (with glissando drags), typing row, and a mirror for the MIDI keyboard ----
const LOW = 21, HIGH = 108;   // A0 .. C8
const pianoEl = $('#piano'), wKeys = {}, bKeys = {}, keyOwners = {};
const BLACK = [1, 3, 6, 8, 10];
const isBlack = n => BLACK.includes(n % 12);
const pcName = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
(function buildPiano() {
  const nW = 52, wPc = 100 / nW;
  let wIdx = 0;
  for (let n = LOW; n <= HIGH; n++) {
    const k = document.createElement('div');
    if (!isBlack(n)) {
      k.className = 'wk'; k.style.left = `calc(${wIdx} * ${wPc}% )`; k.style.width = `${wPc}%`;
      if (n % 12 === 0) k.append(Object.assign(document.createElement('span'), { textContent: noteName(n) }));   // label the Cs
      wKeys[n] = k; wIdx++;
    } else {
      k.className = 'bk'; k.style.left = `calc(${wIdx - 0.32} * ${wPc}%)`; k.style.width = `${wPc * 0.64}%`;
      bKeys[n] = k;
    }
    k.style.setProperty('--pc', COLORS[(n - 21) % 6]); k.dataset.n = n;
    pianoEl.append(k);
  }
})();
function pianoKey(n, on, owner, vel = 0.9) {   // one truth for pressed keys: lights the key and voices it
  const k = isBlack(n) ? bKeys[n] : wKeys[n];
  if (on) {   // k is undefined for notes outside the drawn 88 keys; they still sound
    if (keyOwners[n]?.includes(owner)) return;   // key already down from this source (auto-repeat)
    if (keyOwners[n]) keyOwners[n].push(owner);
    else {
      keyOwners[n] = [owner];
      liveTargets().forEach(t => e.midi(t, n, vel));
    }
    k?.classList.add('on');
  } else {
    const list = keyOwners[n] || [];
    const i = list.indexOf(owner);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) {
      delete keyOwners[n];
      liveTargets().forEach(t => e.midiOff(t, n));
      k?.classList.remove('on');
    }
  }
}
let gliss = null;
pianoEl.addEventListener('pointerdown', ev => {
  const k = ev.target.closest('.wk,.bk');
  if (!k || ev.button !== 0) return;
  gliss = +k.dataset.n; pianoEl.setPointerCapture(ev.pointerId);
  pianoKey(gliss, true, 'mouse');
});
pianoEl.addEventListener('pointermove', ev => {
  if (gliss === null) return;
  const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.wk,.bk');
  if (!el) return;
  const n = +el.dataset.n;
  if (n !== gliss) { pianoKey(gliss, false, 'mouse'); gliss = n; pianoKey(n, true, 'mouse'); }
});
const endGliss = ev => { if (gliss !== null) { pianoKey(gliss, false, 'mouse'); gliss = null; } };
pianoEl.addEventListener('pointerup', endGliss);
pianoEl.addEventListener('pointercancel', endGliss);

// typing row plays notes too: bottom row = lower octave, top row = upper octave; left/right arrows shift the octave
let oct = 0;
const KEYMAP = { KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
                 KeyQ: 12, Key2: 13, KeyW: 14, Key3: 15, KeyE: 16, KeyR: 17, Key5: 18, KeyT: 19, Key6: 20, KeyY: 21, Key7: 22, KeyU: 23, KeyI: 24 };
const octLbl = () => { $('#pianoOct').textContent = `Typing octave ${oct >= 0 ? '+' : ''}${oct}  (\u2190 \u2192)`; };
const inField = ev => ev.target.closest?.('select,textarea,input:not([type=range])');   // real text fields keep their keys
const down = {};   // physical key -> note it started, so a release always matches its press even after an octave change
addEventListener('keydown', ev => {
  if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey || inField(ev)) return;   // shortcuts like Ctrl+I stay shortcuts
  if (ev.code === 'ArrowLeft' || ev.code === 'ArrowRight') {
    ev.preventDefault(); oct = Math.max(-2, Math.min(6, oct + (ev.code === 'ArrowLeft' ? -1 : 1))); octLbl(); return;
  }
  const off = KEYMAP[ev.code], n = 60 + oct * 12 + off;   // typing home is middle C, like every DAW
  if (off === undefined || down[ev.code] !== undefined || n < LOW || n > HIGH) return;
  down[ev.code] = n; ev.preventDefault();
  pianoKey(n, true, 'key' + ev.code, 0.8);
});
addEventListener('keyup', ev => {
  if (down[ev.code] === undefined) return;
  pianoKey(down[ev.code], false, 'key' + ev.code); delete down[ev.code];
});
// keep focus on the page rather than the last control clicked, so typed notes and Space keep working
document.addEventListener('click', ev => ev.target.closest('button')?.blur());
document.addEventListener('change', ev => { if (ev.target.matches('select,input[type=range]')) ev.target.blur(); });
octLbl();
e.tracks.forEach((tr, t) => {   // layer names above the clip columns, each with a live arm button
  const h = document.createElement('div'), nm = document.createElement('div');
  h.className = 'head'; nm.className = 'nm'; nm.textContent = tr.name; h.style.setProperty('--c', COLORS[t]);
  h.append(nm); grid.append(h);
});
grid.append(document.createElement('div'));

// ---- scene settings: push a scene's saved values back onto the sliders / buttons ----
let curScene = 0;   // the scene "Save Scene" writes to: whichever one you last clicked
function syncMixUI() {
  e.tracks.forEach((tr, t) => {
    const F = uiLayers[t].fx;
    F.vol.input.value = tr.vol; F.pan.input.value = tr.pan; F.sust.input.value = tr.sustain;
    F.cut.input.value = Math.log10(tr.cutHz ?? 20000); F.rev.input.value = tr.send ?? 0; F.dly.input.value = tr.echo ?? 0;
    uiLayers[t].msUp();
  });
  e.eqVals.forEach((db, i) => { if (sliders[i]) sliders[i].value = db; });
}
function markSaved(s) {
  const b = sceneBtns[s];
  if (!b || b.querySelector('.saved')) return;
  b.append(Object.assign(document.createElement('i'), { className: 'saved', title: 'Mixer/FX settings saved' }));
}
function saveScene(s) {
  e.captureScene(s); markSaved(s);
  e.error = `${e.sceneNames[s]}: saved the layers' mixer/FX settings and master EQ.`;
  setTimeout(() => { if (e.error.startsWith(e.sceneNames[s] + ':')) e.error = ''; }, 2500);
}

// ---- scene launcher: five song-section buttons, renameable, launch everything in their row ----
const sceneBar = $('#sceneBar'), sceneBtns = [];
e.sceneNames.forEach((name, s) => {
  const b = document.createElement('button');
  b.className = 'sceneBtn'; b.style.setProperty('--c', COLORS[s % COLORS.length]);
  b.textContent = name; b.title = `Launch ${name} — every layer's clip in that row starts at the next bar. Double-click to rename.`;
  b.onclick = () => {   // click: select the scene and glide the mix to its saved settings. Nothing starts playing.
    curScene = s;
    e.fadeSec = Math.max(0, +$('#fadeSec').value || 0);
    const had = e.applyScene(s);
    if ($('#sceneLaunch').checked) e.launchScene(s);   // only when you tick "also launch clips"
    e.error = had ? '' : `${e.sceneNames[s]}: no saved settings yet — set up your layers, then press Save Scene (or Load Scene to use a file).`;
  };
  b.oncontextmenu = ev => { ev.preventDefault(); curScene = s; saveScene(s); };   // right-click = quick save
  b.ondblclick = () => {   // rename: swaps itself for an input, Enter commits, Escape cancels
    if (!b.isConnected) return;
    const inp = document.createElement('input');
    inp.className = 'sceneRename'; inp.maxLength = 12; inp.value = e.sceneNames[s]; inp.title = 'Type a new name and press Enter';
    b.replaceWith(inp); inp.focus(); inp.select();
    const commit = () => {
      if (!inp.isConnected) return;   // already committed (double Enter / blur after replace): never crash
      e.sceneNames[s] = inp.value.trim().toUpperCase() || e.sceneNames[s];
      b.textContent = e.sceneNames[s]; b.title = `Launch ${e.sceneNames[s]} — every layer's clip in that row starts at the next bar. Double-click to rename.`;
      gridSceneBtns[s].title = `Launch ${e.sceneNames[s]}`;
      inp.replaceWith(b);
    };
    inp.onkeydown = ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') inp.blur();
      else if (ev.key === 'Escape') { inp.onblur = null; inp.replaceWith(b); }   // cancel: put the button back untouched
    };
    inp.onblur = commit;
  };
  sceneBar.append(b); sceneBtns.push(b);
});

const gridSceneBtns = [];
for (let s = 0; s < SCENES; s++) {
  e.tracks.forEach((tr, t) => {
    const el = document.createElement('button');
    el.style.setProperty('--c', COLORS[t]);
    el.onclick = () => { sel = { t, s }; if (tr.clips[s]) e.toggle(t, s); else e.newClip(t, s); };
    el.ondragover = ev => ev.preventDefault();
    el.ondrop = async ev => {
      ev.preventDefault();
      const f = ev.dataTransfer.files[0];
      if (f) { try { await e.addSample(t, s, await f.arrayBuffer(), f.name); samplePaths[t][s] = realPath(f); sel = { t, s }; } catch { alert('Could not decode that audio file.'); } }
    };
    grid.append(el); cells.push({ el, t, s });
  });
  const sc = document.createElement('button');
  sc.className = 'scene'; sc.textContent = '▶'; sc.title = `Launch ${e.sceneNames[s]}`; sc.onclick = () => e.launchScene(s);
  grid.append(sc); gridSceneBtns.push(sc);
}

// ---- step editor ----
const stepsEl = $('#steps'), stepBtns = [];
for (let i = 0; i < STEPS; i++) {
  const b = document.createElement('button');
  b.onclick = () => { const cl = e.tracks[sel.t].clips[sel.s]; if (cl?.type === 'seq') cl.steps[i] = !cl.steps[i]; };
  stepsEl.append(b); stepBtns.push(b);
}

// ---- master EQ: 12 bands, +/-12 dB, double-click a band to reset it ----
const sliders = EQ_FREQS.map((f, i) => {
  const col = document.createElement('label'), sl = document.createElement('input'), name = f >= 1000 ? f / 1000 + 'k' : f;
  sl.type = 'range'; sl.min = -12; sl.max = 12; sl.step = 0.5; sl.value = 0;
  const tip = () => { sl.title = `${name} Hz: ${sl.value > 0 ? '+' : ''}${sl.value} dB`; };
  sl.oninput = () => { e.setEq(i, +sl.value); tip(); };
  sl.ondblclick = () => { sl.value = 0; sl.oninput(); };
  tip(); col.append(sl, name); $('#bands').append(col);
  return sl;
});
$('#eqReset').onclick = () => sliders.forEach(sl => { sl.value = 0; sl.oninput(); });

// ---- controls ----
$('#play').onclick = () => (e.playing ? e.stop() : e.play());
$('#test').onclick = () => e.beep();

$('#bpm').oninput = ev => { const v = +ev.target.value; if (v >= 40 && v <= 220) e.setBpm(v); };
addEventListener('keydown', ev => { if (ev.code === 'Space' && ev.target === document.body) { ev.preventDefault(); $('#play').click(); } });
addEventListener('blur', () => {   // window lost focus: release typing keys so nothing hangs
  for (const n of Object.keys(keyOwners)) [...keyOwners[n]].filter(o => String(o).startsWith('key')).forEach(o => pianoKey(+n, false, o));
});

// ---- render loop ----
let wasGliding = false;
function frame() {
  requestAnimationFrame(frame);
  e.tick();
  { const gl = !!e.glide; if (gl || wasGliding) syncMixUI(); wasGliding = gl; }   // faders visibly glide with the scene change
  for (const { el, t, s } of cells) {
    const tr = e.tracks[t], cl = tr.clips[s], on = tr.active === s;
    el.className = 'clip' + (cl ? ' full' : '') + (on ? ' on' : '') +
      ((tr.queued === s || (on && tr.queued === -1)) ? ' q' : '') + (sel.t === t && sel.s === s ? ' sel' : '');
    const txt = cl ? (cl.type === 'sample' ? cl.name : on ? '■' : '▶') : '';
    if (el.textContent !== txt) el.textContent = txt;
  }
  const tr = e.tracks[sel.t], cl = tr.clips[sel.s];
  $('#title').textContent = !cl ? `${tr.name}, ${e.sceneNames[sel.s]}: empty. Click the slot to make a pattern, or drop an audio file on it.`
    : cl.type === 'sample' ? `${cl.name}: audio clip, loops until stopped`
    : `${tr.name}, ${e.sceneNames[sel.s]}: click steps to edit`;
  sceneBtns.forEach((b, s) => {   // launcher bar mirrors what is playing / queued
    const on = e.tracks.some(tr => tr.active === s), q = e.tracks.some(tr => tr.queued === s);
    b.classList.toggle('on', on); b.classList.toggle('q', !on && q); b.classList.toggle('cur', s === curScene);
  });
  const ss = $('#sceneSel'), stxt = `Saves to: ${e.sceneNames[curScene]}${e.sceneMix[curScene] ? ' (has saved settings)' : ' (empty)'}`;
  if (ss.textContent !== stxt) ss.textContent = stxt;
  stepsEl.style.visibility = cl?.type === 'seq' ? 'visible' : 'hidden';
  stepsEl.style.setProperty('--c', COLORS[sel.t]);
  stepBtns.forEach((b, i) => {
    b.className = 'step' + (cl?.steps?.[i] ? ' on' : '') + (i % 4 === 0 ? ' beat' : '') + (e.playing && e.playhead === i ? ' now' : '');
  });
  $('#play').textContent = e.playing ? 'Stop' : 'Play';
  $('#play').classList.toggle('on', e.playing);
  $('.meter i').style.width = Math.min(100, e.level() * 100) + '%';
  $('#status').textContent = e.error || (!e.tracks.some(t => t.sf) ? 'Load a .sf2 file into a layer to hear sound.'
    : '');
}
addEventListener('error', ev => { e.error = 'Error: ' + ev.message; });
frame();

// ---- mobile: explicit Save Scene button, audio unlock on first touch, offline install ----
$('#saveSceneBtn').onclick = () => saveScene(curScene);
['pointerdown', 'touchend'].forEach(t => addEventListener(t, () => e.ctx.state !== 'running' && e.ctx.resume(), { passive: true }));

// ---- pop-up keyboard: Keys button shows/hides it, arrows scroll it, it opens around middle C ----
{
  const kp = $('#keyPanel'), ks = $('#pianoScroll'), kb = $('#keysBtn'), hint = $('#keysHint');
  kb.onclick = () => {
    kp.hidden = !kp.hidden; kb.classList.toggle('on', !kp.hidden);
    if (!kp.hidden && !kp.dataset.init) { kp.dataset.init = 1; ks.scrollLeft = wKeys[60].offsetLeft - ks.clientWidth / 2; }
  };
  $('#keysClose').onclick = () => kb.click();
  $('#keysL').onclick = () => ks.scrollBy({ left: -ks.clientWidth * 0.7, behavior: 'smooth' });
  $('#keysR').onclick = () => ks.scrollBy({ left: ks.clientWidth * 0.7, behavior: 'smooth' });
  setInterval(() => { if (!kp.hidden) hint.textContent = liveTargets().length ? 'Plays layers with \u266a on' : 'Turn \u266a on for a layer in the mixer'; }, 400);
}
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));

// landscape: lock it where the browser allows (installed app / fullscreen); otherwise the rotate prompt covers portrait
addEventListener('pointerdown', () => { try { screen.orientation?.lock?.('landscape').catch(() => {}); } catch {} }, { once: true });
