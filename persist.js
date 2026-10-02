// Save Rig / Load Rig: one file holding the SoundFonts, scenes, scene names, layers (mixer + FX), EQ, tempo and pads.
(function () {
  const say = t => { e.error = t; setTimeout(() => { if (e.error === t) e.error = ''; }, 3500); };
  // remember each SoundFont's raw bytes so they can go into the rig file
  const hook = (fn, after) => { const o = e[fn].bind(e); e[fn] = (...a) => { const r = o(...a); after(...a); return r; }; };
  hook('loadSF2', (t, d) => { e.tracks[t].sfRaw = d; });
  hook('loadPadSF2', (i, d) => { e.pads[i].sfRaw = d; });
  hook('shareSF2', (i, from) => { e.pads[i].sfRaw = from.sfRaw; });
  hook('clearPad', i => { e.pads[i].sfRaw = null; });
  const fileKey = o => (o.sf && o.sfRaw ? o.sfName + '|' + o.sfRaw.byteLength : null);
  const rawOf = k => [...e.tracks, ...e.pads].find(o => fileKey(o) === k)?.sfRaw;
  const nameOf = k => k.slice(0, k.lastIndexOf('|'));

  const snap = () => ({
    v: 1, bpm: e.bpm, scenes: [...e.sceneNames], sceneMix: e.sceneMix, eq: e.eqVals.map(v => Math.round(v * 100) / 100),
    tracks: e.tracks.map(tr => ({ sf: fileKey(tr), preset: tr.preset, key: tr.key, midi: tr.midi, vol: tr.vol, pan: tr.pan, sustain: tr.sustain,
      cut: tr.cutHz ?? 20000, send: tr.send ?? 0, dly: tr.echo ?? 0, mute: tr.mute, solo: tr.solo,
      clips: tr.clips.map(c => (c && c.type === 'seq' ? { steps: c.steps } : null)) })),
    pads: { ...window.nxtPads.save(), pads: e.pads.map(p => ({ sf: fileKey(p), preset: p.preset, key: p.key })) },
  });

  async function restore(st, readSf) {
    const missing = [];
    e.setBpm(st.bpm ?? 120); $('#bpm').value = e.bpm;
    (st.eq || []).forEach((d, i) => { if (e.eq[i]) e.setEq(i, d); });
    (st.scenes || []).slice(0, SCENES).forEach((nm, s) => { if (nm) { e.sceneNames[s] = nm; sceneBtns[s].textContent = nm; gridSceneBtns[s].title = 'Launch ' + nm; } });
    sceneBtns.forEach(b => b.querySelector('.saved')?.remove());
    e.sceneMix = Array.from({ length: SCENES }, () => null);
    (st.sceneMix || []).forEach((m, s) => { if (m && s < SCENES) { e.sceneMix[s] = m; markSaved(s); } });
    for (let t = 0; t < e.tracks.length; t++) {
      const sp = st.tracks?.[t], tr = e.tracks[t], ui = uiLayers[t];
      if (!sp) continue;
      if (sp.sf) {
        try {
          const raw = await readSf(sp.sf); if (!raw) throw new Error('missing');
          e.loadSF2(t, raw, nameOf(sp.sf));
          ui.pre.innerHTML = ''; tr.sf.presets.forEach((p, i) => ui.pre.add(new Option(`${p.bank}:${p.num} ${p.name}`, i)));
          ui.pre.disabled = false; ui.pre.value = Math.max(0, Math.min(sp.preset | 0, tr.sf.presets.length - 1)); tr.preset = +ui.pre.value;
          ui.load.textContent = ui.load.title = nameOf(sp.sf);
        } catch { missing.push(`${tr.name}: ${nameOf(sp.sf)}`); }
      } else if (tr.sf) {
        tr.sf = null; tr.sfName = null; tr.sfRaw = null; ui.pre.innerHTML = ''; ui.pre.disabled = true; ui.load.textContent = 'Load SF2';
      }
      ['vol', 'pan', 'sustain', 'mute', 'solo'].forEach(k => { if (sp[k] !== undefined) e.setTrack(t, k, sp[k]); });
      e.setTrack(t, 'cut', sp.cut ?? 20000); e.setTrack(t, 'send', sp.send ?? 0); e.setTrack(t, 'dly', sp.dly ?? 0); e.setTrack(t, 'midi', !!sp.midi);
      ui.key.value = tr.key = Math.min(127, Math.max(0, sp.key ?? 60));
      (sp.clips || []).forEach((c, s) => { if (s < SCENES) { if (c) tr.clips[s] = { type: 'seq', steps: [...c.steps] }; else if (tr.clips[s]?.type === 'seq') tr.clips[s] = null; } });
    }
    syncMixUI();
    const P = st.pads || {}, enc = k => k && 'idb/' + k.slice(k.lastIndexOf('|') + 1) + '/' + nameOf(k);
    await window.nxtPads.load({ vol: P.vol, fade: P.fade, pads: (P.pads || []).map(p => ({ sfPath: enc(p.sf), preset: p.preset, key: p.key })) },
      async path => { const [, size, ...n] = path.split('/'); const raw = await readSf(n.join('/') + '|' + size); if (!raw) throw new Error('not in the rig'); return raw; }, missing);
    return missing;
  }

  const MAGIC = [78, 88, 84, 66, 75, 49, 0, 0];   // "NXTBK1"
  async function saveRig() {
    try {
      const s = snap(), ks = [...new Set([...s.tracks.map(t => t.sf), ...s.pads.pads.map(p => p.sf)].filter(Boolean))];
      const head = new TextEncoder().encode(JSON.stringify({ state: s, files: ks.map(k => ({ key: k, size: rawOf(k).byteLength })) }));
      const blob = new Blob([new Uint8Array(MAGIC), new Uint32Array([head.length]), head, ...ks.map(rawOf)], { type: 'application/octet-stream' });
      const file = new File([blob], 'my-rig.rig', { type: 'application/octet-stream' });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'NxtGen rig' });
      else { const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: file.name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
      say('Rig saved.');
    } catch (err) { if (err.name !== 'AbortError') say('Could not save the rig: ' + err.message); }
  }
  async function loadRig(f) {
    try {
      const ab = await f.arrayBuffer(), u = new Uint8Array(ab);
      if (ab.byteLength < 12 || MAGIC.some((b, i) => u[i] !== b)) throw new Error('that is not a NxtGen rig file');
      const len = new DataView(ab).getUint32(8, true), h = JSON.parse(new TextDecoder().decode(ab.slice(12, 12 + len)));
      let off = 12 + len; const map = {};
      for (const x of h.files) { map[x.key] = ab.slice(off, off + x.size); off += x.size; }
      const m = await restore(h.state, async k => map[k]);
      say(m.length ? 'Rig loaded, but could not load: ' + m.join(', ') : 'Rig loaded.');
    } catch (err) { say('Could not load the rig: ' + err.message); }
  }
  $('#saveRig').onclick = saveRig;
  $('#loadRig').onclick = () => $('#rigFile').click();
  $('#rigFile').onchange = ev => { const f = ev.target.files[0]; ev.target.value = ''; if (f) loadRig(f); };
})();
