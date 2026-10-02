// Audio interface panel: pick output/input devices, meter + monitor the input, see rate and latency.
(function () {
  const pn = $('#audioPanel'), out = $('#aoOut'), inp = $('#aoIn'), on = $('#aoOn'), mon = $('#aoMon'), gain = $('#aoGain'), msg = $('#aoMsg');
  const KEY = 'nxtgen.audio', DEF_MSG = msg.textContent;
  let prefs = {}; try { prefs = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {} };
  const say = t => { msg.textContent = t; };

  async function scan(ask) {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return say('This system does not expose audio devices.');
    let list = await md.enumerateDevices();
    if (ask && list.some(d => d.kind === 'audioinput' && !d.label)) {   // labels stay blank until the mic permission is granted once
      try { (await md.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop()); list = await md.enumerateDevices(); } catch {}
    }
    const fill = (sel, kind, want, dflt) => {
      sel.innerHTML = ''; sel.add(new Option(dflt, ''));
      list.filter(d => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications')
          .forEach((d, i) => sel.add(new Option(d.label || `${kind === 'audiooutput' ? 'Output' : 'Input'} ${i + 1}`, d.deviceId)));
      const has = [...sel.options].some(o => o.value === want);
      sel.value = has ? want : ''; return has || !want;
    };
    const okO = fill(out, 'audiooutput', prefs.out || '', 'System default output');
    const okI = fill(inp, 'audioinput', prefs.in || '', 'System default input');
    if (!okO) { prefs.out = ''; applyOut(); say('Your output device was unplugged. Switched to the system default.'); }
    if (!okI) { prefs.in = ''; e.inputId = ''; if (on.checked) reopen(); say('Your input device was unplugged. Switched to the system default.'); }
  }
  async function applyOut() {
    try { await e.setSink(prefs.out || ''); } catch (err) { say('Could not use that output: ' + err.message); out.value = ''; prefs.out = ''; }
    save(); info();
  }
  async function reopen() {
    try { await e.openInput(on.checked); mon.disabled = !on.checked; if (!on.checked) { mon.checked = false; e.setMonitor(false); } }
    catch (err) { on.checked = false; mon.disabled = true; say('Could not open the input: ' + err.message); }
  }
  function info() {
    const c = e.ctx, ms = v => (v == null ? 'n/a' : (v * 1000).toFixed(1) + ' ms');
    $('#aoSr').textContent = c.sampleRate + ' Hz'; $('#aoBl').textContent = ms(c.baseLatency);
    $('#aoOl').textContent = ms(c.outputLatency); $('#aoSt').textContent = c.state;
  }

  out.onchange = () => { prefs.out = out.value; applyOut(); };
  inp.onchange = () => { prefs.in = inp.value; e.inputId = inp.value; save(); if (on.checked) reopen(); };
  on.onchange = reopen;
  mon.onchange = () => { e.setMonitor(mon.checked); say(mon.checked ? 'Monitoring on. Use headphones to avoid feedback.' : DEF_MSG); };
  gain.oninput = () => { e.setInputGain(+gain.value); $('#aoGainV').textContent = Math.round(gain.value * 100) + '%'; };
  $('#aoTest').onclick = () => e.beep();
  $('#aoScan').onclick = () => scan(true);
  $('#aoClose').onclick = () => { pn.hidden = true; };
  $('#audioBtn').onclick = () => { pn.hidden = !pn.hidden; if (!pn.hidden) { $('#aiPanel').style.zIndex = 60; scan(true); info(); } };
  navigator.mediaDevices?.addEventListener?.('devicechange', () => scan(false));
  setInterval(() => {   // level meter + latency readout only while the panel is open
    if (pn.hidden) return;
    $('#aoMeter').style.width = Math.min(100, e.inputLevel() * 100) + '%'; info();
  }, 100);

  if (!e.ctx.setSinkId) out.closest('label').hidden = true;
  e.inputId = prefs.in || '';
  if (prefs.out) e.setSink(prefs.out).catch(() => { prefs.out = ''; save(); });   // remembered output comes back on launch
  scan(false);
})();
