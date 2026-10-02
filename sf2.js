// Minimal SoundFont 2 reader: presets -> instruments -> samples, plus zone lookup for a note.
function parseSF2(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  const str = (o, n) => String.fromCharCode(...u8.subarray(o, o + n)).replace(/\0.*$/, '');
  if (u8.length < 12 || str(0, 4) !== 'RIFF' || str(8, 4) !== 'sfbk') throw new Error('That is not a SoundFont (.sf2) file.');
  const ch = {};
  (function walk(o, end) {
    while (o + 8 <= end) {
      const id = str(o, 4), n = dv.getUint32(o + 4, true);
      if (id === 'LIST') walk(o + 12, o + 8 + n); else ch[id] = { o: o + 8, n };
      o += 8 + n + (n & 1);
    }
  })(12, u8.length);
  if (!ch.smpl) throw new Error('This SoundFont has no sample data. Compressed .sf3 files are not supported.');
  const rec = (id, size, fn) => {
    if (!ch[id]) throw new Error('Incomplete SoundFont: missing ' + id);
    return Array.from({ length: Math.floor(ch[id].n / size) }, (_, i) => fn(ch[id].o + i * size));
  };
  const u16 = o => dv.getUint16(o, true), u32 = o => dv.getUint32(o, true);
  const bag = o => ({ gen: u16(o) });
  const gen = o => ({ lo: u8[o + 2], hi: u8[o + 3], val: dv.getInt16(o + 2, true), op: u16(o) });
  const phdr = rec('phdr', 38, o => ({ name: str(o, 20), num: u16(o + 20), bank: u16(o + 22), bag: u16(o + 24) }));
  const inst = rec('inst', 22, o => ({ name: str(o, 20), bag: u16(o + 20) }));
  const shdr = rec('shdr', 46, o => ({ start: u32(o + 20), end: u32(o + 24), sLoop: u32(o + 28), eLoop: u32(o + 32),
                                       rate: u32(o + 36), pitch: u8[o + 40], corr: dv.getInt8(o + 41) }));
  const pbag = rec('pbag', 4, bag), pgen = rec('pgen', 4, gen), ibag = rec('ibag', 4, bag), igen = rec('igen', 4, gen);
  const zones = (list, bags, gens, i) => {   // each zone: { generator id: generator }
    const out = [];
    for (let b = list[i].bag; b < list[i + 1].bag; b++) {
      const g = {}; for (let k = bags[b].gen; k < bags[b + 1].gen; k++) g[gens[k].op] = gens[k];
      out.push(g);
    }
    return out;
  };
  const n = Math.floor(ch.smpl.n / 2) * 2;
  return { presets: phdr.slice(0, -1), pz: i => zones(phdr, pbag, pgen, i), iz: i => zones(inst, ibag, igen, i),
           shdr, pcm: new Int16Array(buf.slice(ch.smpl.o, ch.smpl.o + n)), bufs: {} };
}

// Sample zones that sound for this key and velocity (preset zone -> instrument zone -> sample).
function zonesFor(sf, p, key, vel) {
  const inR = (g, op, v) => !g[op] || (v >= g[op].lo && v <= g[op].hi);
  const pz = sf.pz(p), pg = pz.length && !pz[0][41] ? pz.shift() : {}, out = [];
  for (const z of pz) {
    const m = { ...pg, ...z };
    if (!z[41] || !inR(m, 43, key) || !inR(m, 44, vel)) continue;
    const iz = sf.iz(z[41].val), ig = iz.length && !iz[0][53] ? iz.shift() : {};
    for (const y of iz) {
      const g = { ...ig, ...y };
      if (g[53] && inR(g, 43, key) && inR(g, 44, vel)) out.push({ sample: g[53].val, g });
    }
  }
  return out;
}

function sfBuffer(ctx, sf, i) {
  if (sf.bufs[i]) return sf.bufs[i];
  const sh = sf.shdr[i], n = sh.end - sh.start;
  if (!(n > 1) || sh.end > sf.pcm.length) return null;
  const b = ctx.createBuffer(1, n, sh.rate || 44100), d = b.getChannelData(0);
  for (let k = 0; k < n; k++) d[k] = sf.pcm[sh.start + k] / 32768;
  return (sf.bufs[i] = b);
}
