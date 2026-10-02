// Pad bank: 16 clickable pads in a floating panel (header button "Pads"). Each pad has its own note
// (C, C#, D ... with an octave) and its own SoundFont.
//   hold          = plays while the mouse / finger is down, then releases through the SoundFont's envelope
//   double-click  = LATCH: the pad keeps sounding after you let go
//   double-click again (on a latched pad) = fades out over the Fade time
// Sound comes from the engine (padOn / padOff / padFade), the same voice code the layers use.
(function () {
  const pn = $('#padPanel'), grid = $('#padGrid'), hint = $('#padHint'), vol = $('#padVol'), fadeIn = $('#padFade'), DEF = hint.textContent;
  const DBL = 350;   // ms between the two clicks of a double-click
  const clampKey = n => Math.max(0, Math.min(127, n | 0));
  const fileName = p => String(p).split(/[\\/]/).pop();
  const stripErr = m => String(m).replace(/^Error invoking remote method '[^']*': /, '');
  const fadeSec = () => Math.max(0.1, Math.min(20, +fadeIn.value || 1.5));
  const say = t => { hint.textContent = t; clearTimeout(say.t); say.t = setTimeout(() => { hint.textContent = DEF; }, 3500); };
  const cards = [];   // per-pad UI + state refs

  // ---- open / close / move the panel ----
  $('#padsBtn').onclick = () => { pn.hidden = !pn.hidden; };
  $('#padClose').onclick = () => { pn.hidden = true; };
  const head = $('#padHead');
  head.onpointerdown = ev => {
    if (ev.target.closest('button')) return;
    const r = pn.getBoundingClientRect(), dx = ev.clientX - r.left, dy = ev.clientY - r.top;
    Object.assign(pn.style, { transform: 'none', bottom: 'auto', left: r.left + 'px', top: r.top + 'px' });
    head.setPointerCapture(ev.pointerId);
    head.onpointermove = m => {
      pn.style.left = Math.max(0, Math.min(innerWidth - 120, m.clientX - dx)) + 'px';
      pn.style.top = Math.max(0, Math.min(innerHeight - 40, m.clientY - dy)) + 'px';
    };
    head.onpointerup = () => { head.onpointermove = null; };
  };

  // ---- latch helpers ----
  function unlatch(i, sec) {   // fade a latched pad out (sec defaults to the Fade box)
    const u = cards[i];
    if (!u.latched) return;
    u.latched = false; u.btn.classList.remove('latched');
    e.padFade(u.voice, sec ?? fadeSec()); u.voice = null;
  }
  setInterval(() => {   // keep latched pads going: a sample that ends (no loop in the SoundFont) is struck again
    const now = e.ctx.currentTime;
    let any = false;
    cards.forEach((u, i) => {
      if (!u.latched) return;
      any = true;
      if (!u.voice || u.voice.every(s => !s.loop && now >= s.end - 0.03)) {
        u.voice = e.padOn(i, 100);
        if (!u.voice) unlatch(i, 0.05);   // nothing to play any more (SoundFont or note changed)
      }
    });
    $('#padsBtn').classList.toggle('on', any);
  }, 60);

  function showKey(i) {   // note name, selects, colour (naturals green, sharps blue)
    const u = cards[i], k = e.pads[i].key;
    u.pc.value = k % 12; u.oc.value = Math.floor(k / 12) - 1;
    u.nm.textContent = noteName(k);
    u.btn.title = `Pad ${i + 1}: ${noteName(k)} (MIDI ${k}). Hold to play, double-click to latch, double-click again to fade out.`;
    u.card.style.setProperty('--c', isBlack(k) ? '#8d99ff' : '#06d6a0');
  }
  function showSF(i) {   // SoundFont button + preset list
    const u = cards[i], p = e.pads[i];
    u.pre.innerHTML = '';
    if (p.sf) {
      p.sf.presets.forEach((x, k) => u.pre.add(new Option(`${x.bank}:${x.num} ${x.name}`, k)));
      u.pre.value = p.preset; u.pre.disabled = false; u.load.textContent = u.load.title = p.sfName;
    } else {
      u.pre.disabled = true; u.load.textContent = 'Load SF2'; u.load.title = 'Load a SoundFont (.sf2) on this pad, or drop one on it';
    }
    u.btn.classList.toggle('empty', !p.sf);
  }
  async function useFile(i, f) {
    if (!f) return;
    try {
      const data = await f.arrayBuffer();
      unlatch(i, 0.1);   // a latched pad is replaced cleanly
      e.loadPadSF2(i, data, f.name);
      e.pads[i].sfPath = realPath(f);   // remembered so rigs can reload this sound from disk
      showSF(i);
    } catch (err) { alert(err.message); }
  }

  e.pads.forEach((p, i) => {
    const $c = tag => document.createElement(tag);
    const card = $c('div'), btn = $c('button'), num = $c('small'), nm = $c('span'), row = $c('div'),
          pc = $c('select'), oc = $c('select'), load = $c('button'), pre = $c('select'), file = $c('input');
    card.className = 'padCard'; btn.className = 'pad'; num.textContent = i + 1; row.className = 'row2';
    btn.append(num, nm);
    pcName.forEach((n, k) => pc.add(new Option(n, k)));
    for (let o = -1; o <= 9; o++) oc.add(new Option(o, o));
    pc.title = 'Note this pad plays'; oc.title = 'Octave (4 = the octave of middle C)';
    load.className = 'pl'; file.type = 'file'; file.accept = '.sf2'; file.hidden = true;
    row.append(pc, oc); card.append(btn, row, load, pre, file); grid.append(card);
    const u = { card, btn, nm, pc, oc, load, pre, voice: null, down: false, latched: false, last: 0, willLatch: false };
    cards.push(u);

    const setKey = () => { p.key = clampKey((+oc.value + 1) * 12 + +pc.value); showKey(i); };
    pc.onchange = oc.onchange = setKey;
    pre.onchange = () => { p.preset = +pre.value; };
    load.onclick = () => file.click();
    file.onchange = () => { useFile(i, file.files[0]); file.value = ''; };
    card.ondragover = ev => { ev.preventDefault(); card.classList.add('drag'); };
    card.ondragleave = () => card.classList.remove('drag');
    card.ondrop = ev => { ev.preventDefault(); card.classList.remove('drag'); useFile(i, ev.dataTransfer.files[0]); };

    // press and hold; pointer capture keeps the release with this pad even if the pointer slides off it
    const press = ev => {
      if (ev.button > 0) return;
      const now = performance.now(), dbl = now - u.last < DBL;
      u.last = dbl ? 0 : now;   // a third quick click starts a fresh count
      if (u.latched) { if (dbl) unlatch(i); return; }   // latched: single clicks do nothing, a double-click fades it out
      if (u.down) return;
      u.down = true; u.willLatch = dbl; btn.classList.add('on');
      try { btn.setPointerCapture(ev.pointerId); } catch {}
      u.voice = e.padOn(i, 100);
      if (!p.sf) say(`Pad ${i + 1} has no SoundFont yet. Press "Load SF2" under it.`);
      else if (!u.voice) say(`Pad ${i + 1}: this SoundFont has no sound for ${noteName(p.key)}. Try another note or preset.`);
    };
    const release = () => {
      if (!u.down) return;
      u.down = false; btn.classList.remove('on');
      if (u.willLatch && u.voice) { u.latched = true; btn.classList.add('latched'); say(`Pad ${i + 1} latched. Double-click it again to fade out.`); }   // keep the voice: the second click of a double-click latches
      else { e.padOff(u.voice); u.voice = null; }
      u.willLatch = false;
    };
    btn.addEventListener('pointerdown', press);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => btn.addEventListener(t, release));
    btn.addEventListener('mousedown', ev => ev.preventDefault());   // no keyboard focus on the pad, so Space still starts the transport
    btn.addEventListener('contextmenu', ev => ev.preventDefault());
    showKey(i); showSF(i);
  });
  addEventListener('blur', () => cards.forEach(u => u.btn.dispatchEvent(new Event('pointercancel'))));   // window lost focus: held pads release (latched ones keep going)

  // ---- bank controls ----
  vol.oninput = () => e.setPadVol(+vol.value);
  $('#padStopAll').onclick = () => cards.forEach((_, i) => unlatch(i));
  $('#padAll').onclick = () => $('#padAllFile').click();
  $('#padAllFile').onchange = async ev => {   // one file, parsed once, shared by all 16 pads (each pad can still pick its own preset)
    const f = ev.target.files[0]; ev.target.value = '';
    if (!f) return;
    try {
      const data = await f.arrayBuffer();
      cards.forEach((_, i) => unlatch(i, 0.1));
      e.loadPadSF2(0, data, f.name); e.pads[0].sfPath = realPath(f);
      for (let i = 1; i < e.pads.length; i++) e.shareSF2(i, e.pads[0]);
      e.pads.forEach((_, i) => showSF(i));
    } catch (err) { alert(err.message); }
  };
  const shift = d => {
    if (e.pads.some(p => p.key + d < 0 || p.key + d > 127)) return say('That would push a pad outside the keyboard range.');
    e.pads.forEach((p, i) => { p.key += d; showKey(i); });
  };
  $('#padOctDn').onclick = () => shift(-12);
  $('#padOctUp').onclick = () => shift(12);
  $('#padChrom').onclick = () => e.pads.forEach((p, i) => { p.key = 60 + i; showKey(i); });

  // ---- rigs: app.js calls these when saving and loading ----
  window.nxtPads = {
    save: () => ({ vol: +vol.value, fade: fadeSec(), pads: e.pads.map(p => ({ sfPath: p.sfPath || null, preset: p.preset, key: p.key })) }),
    paths: () => e.pads.map(p => p.sfPath).filter(Boolean),
    noPath: () => e.pads.map((p, i) => (p.sf && !p.sfPath ? `Pad ${i + 1}` : null)).filter(Boolean),
    async load(spec, readAsset, missing) {   // spec is undefined for rigs saved before pads existed: pads reset
      const first = new Map(), failed = new Set();   // one parse per file; a missing file is reported once
      cards.forEach((_, i) => unlatch(i, 0.1));
      vol.value = spec?.vol ?? 0.9; e.setPadVol(+vol.value); fadeIn.value = spec?.fade ?? 1.5;
      for (let i = 0; i < e.pads.length; i++) {
        const s = spec?.pads?.[i], p = e.pads[i];
        e.clearPad(i); p.key = clampKey(s?.key ?? 60 + i);
        if (s?.sfPath && !failed.has(s.sfPath)) {
          try {
            const src = first.get(s.sfPath);
            if (src) e.shareSF2(i, src);
            else { e.loadPadSF2(i, await readAsset(s.sfPath), fileName(s.sfPath)); p.sfPath = s.sfPath; first.set(s.sfPath, p); }
            p.preset = Math.max(0, Math.min(s.preset | 0, p.sf.presets.length - 1));
          } catch (err) { e.clearPad(i); failed.add(s.sfPath); missing.push(`Pad ${i + 1}: ${fileName(s.sfPath)} — ${stripErr(err.message)}`); }
        }
        showKey(i); showSF(i);
      }
    },
  };
})();
