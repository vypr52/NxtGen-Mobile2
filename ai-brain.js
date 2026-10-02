// Offline assistant: understands plain-English requests about the session and answers with
// { reply, actions, chips }. No network, no model — it works with the cable pulled out.
// `actions` use the same vocabulary the online AI uses, so both go through one executor (ai.js).
(function (root) {
  const PATTERNS = [   // [words that ask for it, steps that are ON, what to call it]
    [/four.?on.?the.?floor|house|techno|kick/, [0, 4, 8, 12], 'a four-on-the-floor pulse'],
    [/back.?beat|snare|clap|rock/, [4, 12], 'a backbeat on 2 and 4'],
    [/off.?beat|hi.?hat|hats?\b/, [2, 6, 10, 14], 'offbeat hats'],
    [/eighth|8th/, [0, 2, 4, 6, 8, 10, 12, 14], 'straight eighths'],
    [/sixteenth|16th|roll/, [...Array(16).keys()], 'running sixteenths'],
    [/funk|syncop/, [0, 3, 6, 10, 12, 15], 'a syncopated funk figure'],
    [/sparse|minimal|simple|space/, [0, 8], 'a sparse two-hit pattern'],
  ];
  const rnd = () => { const on = []; for (let i = 0; i < 16; i++) if (Math.random() < (i % 4 === 0 ? .7 : i % 2 === 0 ? .4 : .2)) on.push(i); return on.length ? on : [0]; };
  const PROPS = [['vol', /\b(volume|vol|level|fader|loud|quiet|louder|quieter|softer)\b/, 'volume'], ['pan', /\bpan(ning)?\b/, 'pan'],
                 ['send', /\b(reverb|verb)\b/, 'reverb'], ['dly', /\b(echo|delay)\b/, 'echo'],
                 ['cut', /\b(cutoff|cut.?off|filter|bright|brighter|darker|dark|muffle|muffled)\b/, 'filter cutoff'], ['sustain', /\bsustain\b/, 'sustain']];
  const FAQ = [
    [/sound ?font|sf2|no sound|can.?t hear|silent|nothing plays/, 'Each layer plays its own SoundFont. Press "Load SF2" on a layer (or drop a .sf2 file on it), then press its ♪ button so the keyboard plays it. Still silent? Press Test, then open Audio and check your output device.'],
    [/midi|keyboard|controller/, 'Pick your keyboard in the MIDI menu at the top (press ↻ to rescan). Press ♪ on a layer to play it live. The on-screen piano and your computer keys (Z to M, Q to I) work too, and the arrow keys shift the octave.'],
    [/scene|section/, 'A scene is a row: a song section. Clicking a scene button glides every layer to its saved mixer settings. Save Scene stores them. Tick "also launch clips" to start the row too. Double-click a scene to rename it.'],
    [/\beq\b|equali/, 'The master EQ has 12 bands (±12 dB). Double-click a band to reset it, or press Flat. You can also ask me: "more bass" or "cut the treble".'],
    [/cutoff|filter/, 'Cut is a low-pass filter per layer: lower it for a darker, muffled sound. Try "set layer 2 cutoff to 2000".'],
  ];
  const HELP = 'I can control the session: "play", "tempo 100", "mute layer 3", "layer 2 reverb to 40", "make a funk pattern on layer 1 in the verse", "more bass", "launch chorus". Ask me how anything works, too.';
  const CHIPS = ['Make a beat', 'Tempo 100', 'More reverb on layer 1', 'How do scenes work?', 'Status'];

  const num = t => { const m = t.match(/(-?\d+(?:\.\d+)?)\s*(k\b)?\s*(%|percent)?/); return m ? { n: +m[1] * (m[2] ? 1000 : 1), pct: !!m[3] } : null; };

  function brain(raw, S) {
    const t = ' ' + raw.toLowerCase().replace(/[’']/g, '').trim() + ' ';
    const NW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
    const tt = t.replace(/\b(layer|scene)\s+(one|two|three|four|five|six)\b/g, (m, k, w) => k + ' ' + NW[w]);
    return run(tt, S);
  }
  function run(t, S) {
    const L = S.layers.length, done = (reply, actions = [], chips = CHIPS) => ({ reply, actions, chips });
    // ---- targets ----
    let layer = (t.match(/\blayer\s*([1-9])\b/) || [])[1];
    const all = /\b(all|every|each)\b.*\blayers?\b|\ball\b/.test(t) && !layer;
    let tgt = all ? 'all' : layer ? +layer : null;
    if (typeof tgt === 'number' && tgt > L) return done(`There are only ${L} layers, so I can't reach layer ${tgt}.`);
    let scene = (t.match(/\bscene\s*([1-9])\b/) || [])[1];
    if (!scene) {
      const flat = t.replace(/\W+/g, ' '); let best = 0;
      S.scenes.forEach((nm, i) => { const n = nm.toLowerCase().replace(/\W+/g, ' ').trim(); if (n.length > best && new RegExp('\\b' + n + '\\b').test(flat)) { scene = i + 1; best = n.length; } });
    }
    scene = scene ? +scene : null;
    if (scene > S.scenes.length) return done(`There are only ${S.scenes.length} scenes.`);

    if (/^\s*(hi|hello|hey|yo|help|what can you do|\?)\W*\s*$/.test(t) || /what can you do|how do you work/.test(t)) return done(HELP);
    if (/\b(thanks|thank you|cheers)\b/.test(t)) return done('Any time! What should we do next?');
    if (/\b(status|state|what.?s (playing|going on)|summary)\b/.test(t)) {
      const loaded = S.layers.filter(l => l.sf).length, clips = S.layers.reduce((a, l) => a + l.clips.filter(Boolean).length, 0);
      return done(`${S.playing ? 'Playing' : 'Stopped'} at ${S.bpm} BPM. ${loaded} of ${L} layers have a SoundFont, ${clips} clips in the grid. Selected: layer ${S.sel.t + 1}, ${S.scenes[S.sel.s]}.`);
    }

    // ---- patterns ----
    if (/\b(make|create|generate|give|add|write|program|fill|put|new)\b/.test(t) && /\b(beat|pattern|groove|rhythm|drum|hats?|kick|snare|clip|figure)\b/.test(t) || /\b(clear|erase|empty)\b.*\b(clip|pattern|steps?)\b/.test(t)) {
      const t0 = typeof tgt === 'number' ? tgt : S.sel.t + 1, s0 = scene || S.sel.s + 1;
      if (/\b(clear|erase|empty)\b/.test(t)) return done(`Cleared layer ${t0}, ${S.scenes[s0 - 1]}.`, [{ a: 'pattern', t: t0, s: s0, steps: [] }]);
      const hit = PATTERNS.find(p => p[0].test(t)), steps = hit ? hit[1] : rnd();
      return done(`Done: ${hit ? hit[2] : 'a fresh random pattern'} on layer ${t0}, ${S.scenes[s0 - 1]}. Press the clip to launch it.`,
        [{ a: 'pattern', t: t0, s: s0, steps }, ...(/\bplay|launch|hear\b/.test(t) ? [{ a: 'launch', s: s0 }] : [])], ['Make another', 'Play', 'Add reverb to layer ' + t0, 'Clear it']);
    }

    // ---- mute / solo / arm ----
    const flag = t.match(/\b(unmute|mute|unsolo|solo)\b/);
    if (flag && (tgt !== null)) {
      const w = flag[1], prop = w.replace(/^un/, ''), v = !w.startsWith('un'), who = tgt === 'all' ? 'all layers' : 'layer ' + tgt;
      const msg = { mute: `Muted ${who}.`, unmute: `Unmuted ${who}.`, solo: `Soloed ${who}.`, unsolo: `Un-soloed ${who}.` }[w];
      return done(msg, [{ a: 'layer', t: tgt, prop, v }]);
    }
    if (flag && !tgt) return done(`Which layer? Try "${flag[1]} layer 2".`);

    // ---- tempo ----
    if (/\b(tempo|bpm|faster|slower|speed)\b/.test(t)) {
      const n = num(t.replace(/layer\s*\d|scene\s*\d/g, ''));
      let v = n && n.n >= 20 ? n.n : /\bfaster|speed up\b/.test(t) ? S.bpm + 10 : /\bslower|slow down\b/.test(t) ? S.bpm - 10 : null;
      if (v === null) return done('What tempo? For example "tempo 100" (40 to 220 BPM).');
      v = Math.max(40, Math.min(220, Math.round(v)));
      return done(`Tempo set to ${v} BPM.`, [{ a: 'tempo', v }]);
    }

    // ---- EQ ----
    if (/\beq\b.*\b(flat|reset)\b|\bflat\b.*\beq\b|\breset\b.*\beq\b/.test(t)) return done('Master EQ is flat again.', [{ a: 'eqflat' }]);
    const eqm = t.match(/\b(more|boost|add|raise|less|cut|reduce|lower|kill)\b.*\b(bass|low|lows|treble|high|highs|mid|mids|air)\b/);
    if (eqm && !/\b(reverb|echo|volume|layer)\b/.test(t)) {
      const up = /more|boost|add|raise/.test(eqm[1]), d = up ? 3 : -3, w = eqm[2];
      const bands = /bass|low/.test(w) ? [0, 1, 2] : /mid/.test(w) ? [4, 5, 6] : [8, 9, 10, 11];
      return done(`${up ? 'Boosted' : 'Cut'} the ${/bass|low/.test(w) ? 'bass' : /mid/.test(w) ? 'mids' : 'treble'} by 3 dB on the master EQ.`,
        bands.map(b => ({ a: 'eq', band: b, rel: d })));
    }

    // ---- per-layer settings ----
    const prop = PROPS.find(p => p[1].test(t));
    if (prop && (tgt !== null || S.sel)) {
      const target = tgt !== null ? tgt : S.sel.t + 1, cur = t2 => S.layers[(t2 === 'all' ? 1 : t2) - 1] || {};
      const [key,, label] = prop, who = target === 'all' ? 'all layers' : `layer ${target}`, n = num(t.replace(/layer\s*\d+|scene\s*\d+/g, ''));
      const upW = /\b(more|up|increase|raise|louder|brighter|bright|higher|boost)\b/.test(t), dnW = /\b(less|down|decrease|lower|quieter|softer|darker|dark|muffle|muffled|reduce)\b/.test(t);
      let v = null;
      if (key === 'pan' && /\bleft\b/.test(t)) v = -1; else if (key === 'pan' && /\bright\b/.test(t)) v = 1; else if (key === 'pan' && /\b(center|centre|middle)\b/.test(t)) v = 0;
      else if (n) v = key === 'cut' ? n.n : key === 'pan' ? n.n / 100 : (n.pct || n.n > 1) ? n.n / 100 : n.n;
      else if (upW || dnW) {
        const c = cur(target), s = upW ? 1 : -1;
        v = key === 'cut' ? Math.round(Math.max(40, Math.min(20000, (c.cutHz ?? 20000) * (s > 0 ? 3 : 1 / 3))))
          : Math.max(key === 'pan' ? -1 : 0, Math.min(1, (({ vol: c.vol, send: c.send, dly: c.echo, sustain: c.sustain, pan: c.pan })[key] ?? 0) + s * (key === 'pan' ? .3 : .15)));
      }
      if (v !== null && key !== 'cut') v = Math.round(v * 100) / 100;
      if (v === null) return done(`What should I set ${label} to? For example "layer 2 ${label} to 40%".`);
      const shown = key === 'cut' ? Math.round(v) + ' Hz' : key === 'pan' ? (v < -.05 ? Math.round(-v * 100) + '% left' : v > .05 ? Math.round(v * 100) + '% right' : 'center') : Math.round(v * 100) + '%';
      return done(`${label[0].toUpperCase() + label.slice(1)} on ${who} is now ${shown}.`, [{ a: 'layer', t: target, prop: key, v }]);
    }

    // ---- scenes / launching / transport ----
    if (scene) {
      const nm = S.scenes[scene - 1], clipsW = /\b(play|start|trigger|run)\b/.test(t), mixW0 = /\b(launch|switch|go|jump|load|recall|mix)\b/.test(t), mixW = mixW0 || (!clipsW && /\bscene\b/.test(t));   // "scene 3" alone = mix; "play scene 3" = clips only
      const acts = [], say = [];
      if (mixW || !clipsW) {
        acts.push({ a: 'scene', s: scene });
        say.push(S.saved && !S.saved[scene - 1] ? `${nm} has no saved mix yet. Set up your layers, then press Save Scene` : `Gliding the mix to ${nm}`);
      }
      if (clipsW) { acts.push({ a: 'launch', s: scene }); say.push(`starting the ${nm} clips at the next bar`); }
      if (mixW || clipsW) return done(say.join(', ') + '.', acts);
    }
    if (/\b(stop|pause|halt|silence)\b/.test(t) && !/\bhow\b/.test(t)) return done('Stopped.', [{ a: 'stop' }]);
    if (/\b(play|start|go|run)\b/.test(t) && !/\bhow\b/.test(t)) return done('Playing.', [{ a: 'play' }]);

    // ---- questions ----
    for (const [re, ans] of FAQ) if (re.test(t)) return done(ans);
    return done("I didn't catch that one. " + HELP);
  }
  root.NxtBrain = { brain, CHIPS, HELP };
  if (typeof module !== 'undefined') module.exports = root.NxtBrain;
})(typeof window !== 'undefined' ? window : globalThis);
