// AI assistant panel. Offline: NxtBrain (rules, no network). Online: Anthropic API via the main process.
// Both answer with { reply, actions }; runActions() is the only code that touches the session.
(function () {
  const pn = $('#aiPanel'), log = $('#aiLog'), input = $('#aiIn'), chips = $('#aiChips'), badge = $('#aiMode');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, +v));
  const hist = [];                       // conversation memory sent to the online model
  let mode = 'auto', info = { hasKey: false, model: '' }, busy = false;

  // ---------- what the assistant may know about the session ----------
  const state = () => ({
    bpm: e.bpm, playing: e.playing, saved: e.sceneMix.map(Boolean), scenes: [...e.sceneNames], sel: { ...sel },
    layers: e.tracks.map((tr, i) => ({ n: i + 1, sf: !!tr.sf, sfName: tr.sfName || null, vol: +tr.vol.toFixed(2), pan: +tr.pan.toFixed(2),
      sustain: +tr.sustain.toFixed(2), cutHz: Math.round(tr.cutHz ?? 20000), send: +(tr.send ?? 0).toFixed(2), echo: +(tr.echo ?? 0).toFixed(2),
      mute: tr.mute, solo: tr.solo,
      clips: tr.clips.map(c => !c ? null : c.type === 'seq' ? c.steps.map((on, k) => on ? k : -1).filter(k => k >= 0) : 'audio:' + c.name) })),
  });

  // ---------- the one place actions are carried out (everything validated) ----------
  function runActions(list) {
    const done = [], layersOf = t => t === 'all' ? e.tracks.map((_, i) => i) : (Number.isInteger(+t) && +t >= 1 && +t <= e.tracks.length ? [+t - 1] : []);
    for (const x of (list || []).slice(0, 24)) {
      try {
        switch (x.a) {
          case 'play': if (!e.playing) e.play(); done.push('Play'); break;
          case 'stop': e.stop(); done.push('Stop'); break;
          case 'tempo': { const v = Math.round(clamp(x.v, 40, 220)); e.setBpm(v); $('#bpm').value = v; done.push(`Tempo ${v}`); break; }
          case 'layer': {
            const ts = layersOf(x.t); if (!ts.length) break;
            for (const t of ts) {
              const p = x.prop;
              if (['mute', 'solo'].includes(p)) e.setTrack(t, p, !!x.v);
              else if (p === 'cut') e.setTrack(t, 'cut', clamp(x.v, 40, 20000));
              else if (p === 'pan') e.setTrack(t, 'pan', clamp(x.v, -1, 1));
              else if (['vol', 'send', 'dly', 'sustain'].includes(p)) e.setTrack(t, p, clamp(x.v, 0, 1));
              else continue;
              uiLayers[t].msUp();
            }
            syncMixUI(); done.push(`Layer ${x.t}: ${x.prop}`); break;
          }
          case 'pattern': case 'clear': {
            const t = +x.t - 1, s = +x.s - 1;
            if (!e.tracks[t] || s < 0 || s >= SCENES) break;
            if (e.tracks[t].clips[s]?.type === 'sample') { done.push(`Layer ${x.t} ${e.sceneNames[s]} holds an audio clip, left alone`); break; }
            const on = new Set(x.a === 'clear' ? [] : (x.steps || []).map(Number));
            e.tracks[t].clips[s] = { type: 'seq', steps: Array.from({ length: STEPS }, (_, i) => on.has(i)) };
            sel = { t, s }; done.push(`${x.a === 'clear' ? 'Cleared' : 'Pattern on'} layer ${x.t}, ${e.sceneNames[s]}`); break;
          }
          case 'launch': { const s = +x.s - 1; if (s >= 0 && s < SCENES) { e.launchScene(s); done.push('Launch ' + e.sceneNames[s]); } break; }
          case 'scene': { const s = +x.s - 1; if (s >= 0 && s < SCENES) { sceneBtns[s].click(); done.push('Scene ' + e.sceneNames[s]); } break; }
          case 'eq': {
            const b = +x.band; if (!(b >= 0 && b < e.eq.length)) break;
            const db = x.rel !== undefined ? e.eqVals[b] + clamp(x.rel, -12, 12) : x.db;
            e.setEq(b, clamp(db, -12, 12)); sliders[b].value = e.eqVals[b]; done.push('EQ'); break;
          }
          case 'eqflat': $('#eqReset').click(); done.push('EQ flat'); break;
        }
      } catch (err) { done.push('(one action failed: ' + err.message + ')'); }
    }
    return [...new Set(done)];
  }

  // ---------- chat UI ----------
  function add(cls, text) { const d = document.createElement('div'); d.className = 'msg ' + cls; d.textContent = text; log.append(d); log.scrollTop = log.scrollHeight; return d; }   // textContent only: model output is never HTML
  function setChips(list) { chips.innerHTML = ''; (list || NxtBrain.CHIPS).slice(0, 5).forEach(t => { const b = document.createElement('button'); b.textContent = t; b.onclick = () => ask(t); chips.append(b); }); }
  function refreshBadge() {
    const online = navigator.onLine && info.hasKey && mode !== 'offline';
    badge.textContent = online ? 'Online' : mode === 'online' ? 'Online (unavailable)' : 'Offline';
    badge.className = online ? 'on' : 'off';
    badge.title = online ? 'Using the online AI' : !navigator.onLine ? 'No internet: using the built-in offline assistant' : !info.hasKey ? 'Add an API key in ⚙ for online mode. Offline assistant is active.' : 'Offline mode selected';
  }
  async function loadInfo() { try { const r = await window.ai.status(); if (r.ok) { info = r; $('#aiModel').value = r.model; } } catch {} refreshBadge(); }

  function parse(t) {
    t = String(t).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    for (const cand of [t, (t.match(/\{[\s\S]*\}/) || [''])[0]]) {
      try { const j = JSON.parse(cand); return { reply: String(j.reply ?? ''), actions: Array.isArray(j.actions) ? j.actions : [] }; } catch {}
    }
    return { reply: t, actions: [] };
  }
  async function askOnline(text) {
    hist.push({ role: 'user', content: text });
    const r = await window.ai.ask(hist, state());
    if (!r.ok) { hist.pop(); throw new Error(r.error); }
    const out = parse(r.text); hist.push({ role: 'assistant', content: out.reply || '(done)' });
    return out;
  }
  async function ask(text) {
    text = String(text || '').trim(); if (!text || busy) return;
    busy = true; input.value = ''; add('me', text);
    const wait = add('ai', '…'); let out = null, note = '';
    const canOnline = navigator.onLine && info.hasKey;
    if (mode !== 'offline' && canOnline) {
      try { out = await askOnline(text); }
      catch (err) { if (mode === 'online') out = { reply: 'The online AI could not answer: ' + err.message, actions: [] }; else note = 'Online AI unreachable, so I answered offline. '; }
    } else if (mode === 'online') {
      out = { reply: !navigator.onLine ? 'You are offline right now. Switch to Auto or Offline in ⚙ and I can still run the session.' : 'Online mode needs an API key. Open ⚙ to add one.', actions: [] };
    }
    if (!out) out = NxtBrain.brain(text, state());
    const did = runActions(out.actions);
    wait.textContent = (note + (out.reply || (did.length ? 'Done.' : "I'm not sure what to do with that."))).trim();
    if (did.length) add('did', '✓ ' + did.join(' · '));
    setChips(out.chips); log.scrollTop = log.scrollHeight; busy = false; refreshBadge(); input.focus();
  }

  // ---------- wiring ----------
  $('#aiSend').onclick = () => ask(input.value);
  input.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Enter') ask(input.value); };   // typing here never plays piano notes
  $('#aiBtn').onclick = () => { pn.hidden = !pn.hidden; if (!pn.hidden) { if (!log.children.length) greet(); input.focus(); } };
  $('#aiClose').onclick = () => { pn.hidden = true; };
  $('#aiGear').onclick = () => $('#aiSet').classList.toggle('open');
  $('#aiSel').onchange = ev => { mode = ev.target.value; refreshBadge(); };
  const gather = extra => ({ model: $('#aiModel').value, aiKey: $('#aiKey').value, sttKey: $('#sttKey').value, ...extra });
  $('#aiSave').onclick = async () => {
    const r = await window.ai.setSettings(gather());
    $('#aiKey').value = ''; $('#sttKey').value = ''; await loadInfo();
    add('ai', r.ok ? `Saved. Online AI: ${info.hasKey ? 'ready' : 'no key'}. Online voice: ${info.hasStt ? 'ready' : 'no key'}.` : 'Could not save: ' + r.error);
  };
  $('#aiClear').onclick = async () => { await window.ai.setSettings(gather({ clearAi: true, aiKey: '', sttKey: '' })); await loadInfo(); add('ai', 'AI key removed. I will work offline.'); };
  $('#sttClear').onclick = async () => { await window.ai.setSettings(gather({ clearStt: true, aiKey: '', sttKey: '' })); await loadInfo(); add('ai', 'Speech key removed. Voice will use the offline model.'); };
  addEventListener('online', refreshBadge); addEventListener('offline', refreshBadge);
  function greet() {
    const who = window.nxtUser ? ', ' + window.nxtUser : '';
    add('ai', `Hi${who}! I can run your session from what you type: tempo, mixing, patterns, scenes and EQ. I work fully offline. What shall we make?`);
    setChips();
  }
  window.nxtAI = { ask, info: () => info, add, mode: () => mode };   // used by voice.js
  addEventListener('nxt-login', loadInfo);
  if (window.nxtUser) loadInfo(); else refreshBadge();
})();
