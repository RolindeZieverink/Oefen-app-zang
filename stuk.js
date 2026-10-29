/* Naklank: stuk oefenen (MusicXML / MIDI importeren, afspelen, nazingen met beoordeling per noot) */
(() => {
'use strict';
const C = window.NKcore;
if (!C) return;
const $ = id => document.getElementById(id);
const { nm, isBlack, mtof, median } = C;
const LS = 'naklank-stuk';
const LAT = 0.08;               // vertraging tussen horen/zien en zingen (seconden)
const WINDOW = 8;               // seconden zichtbaar in beeld
const PLAYHEAD = 0.25;          // plek van de afspeellijn (aandeel van de breedte)
const STEP = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };

/* =========================================================
   Parsers
   ========================================================= */
const kid = (el, tag) => { for (const c of el.children) if (c.tagName === tag) return c; return null; };
const kids = (el, tag) => [...el.children].filter(c => c.tagName === tag);
const txt = (el, tag) => { const k = kid(el, tag); return k ? k.textContent.trim() : ''; };

function lyricOf(noteEl){
  const l = kid(noteEl, 'lyric'); if (!l) return '';
  const t = txt(l, 'text'); if (!t) return '';
  const syl = txt(l, 'syllabic');
  return (syl === 'begin' || syl === 'middle') ? t + '-' : t;
}

function parseXML(text){
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('xml');
  const root = doc.documentElement;
  if (root.tagName !== 'score-partwise') throw new Error('timewise');
  const names = {};
  const pl = kid(root, 'part-list');
  if (pl) for (const sp of kids(pl, 'score-part')) names[sp.getAttribute('id')] = txt(sp, 'part-name') || txt(sp, 'part-abbreviation');
  const parts = [], measures = [], tempo = [], time = [];
  const partEls = kids(root, 'part');
  partEls.forEach((pe, pi) => {
    let div = 1, mq = 0;
    const notes = [], open = new Map();
    kids(pe, 'measure').forEach((me, mi) => {
      if (pi > 0 && measures[mi]) mq = measures[mi].b;
      let t = 0, maxT = 0, lastStart = 0;
      for (const el of me.children){
        const tag = el.tagName;
        if (tag === 'attributes'){
          const d = kid(el, 'divisions'); if (d) div = +d.textContent || div;
          if (pi === 0){
            const ti = kid(el, 'time');
            if (ti){
              const beats = txt(ti, 'beats').split('+').reduce((a, x) => a + (+x || 0), 0);
              time.push([mi, beats || 4, +txt(ti, 'beat-type') || 4]);
            }
          }
        } else if (tag === 'note'){
          if (kid(el, 'grace')) continue;
          const dur = +(txt(el, 'duration') || 0);
          const isChord = !!kid(el, 'chord');
          let start;
          if (isChord) start = lastStart; else { start = t; lastStart = t; t += dur; if (t > maxT) maxT = t; }
          const pit = kid(el, 'pitch'); if (!pit) continue;
          const m = 12 * (+txt(pit, 'octave') + 1) + STEP[txt(pit, 'step')] + Math.round(+(txt(pit, 'alter') || 0));
          const voice = txt(el, 'voice') || '1';
          const ties = kids(el, 'tie').map(c => c.getAttribute('type'));
          const key = m + '/' + voice, d = dur / div;
          if (ties.includes('stop') && open.has(key)){
            const n = open.get(key); n.d += d;
            if (!ties.includes('start')) open.delete(key);
          } else {
            const n = { b: mq + start / div, d, m, meas: mi, lyr: lyricOf(el) };
            notes.push(n);
            if (ties.includes('start')) open.set(key, n);
          }
        } else if (tag === 'backup'){ t -= +txt(el, 'duration') || 0; }
        else if (tag === 'forward'){ t += +txt(el, 'duration') || 0; if (t > maxT) maxT = t; }
        else if (pi === 0 && (tag === 'direction' || tag === 'sound')){
          const snd = tag === 'sound' ? el : kid(el, 'sound');
          const at = mq + t / div;
          if (snd && snd.getAttribute('tempo')) tempo.push([at, +snd.getAttribute('tempo')]);
          else if (tag === 'direction'){
            const met = el.getElementsByTagName('metronome')[0];
            if (met){
              const pm = parseFloat(txt(met, 'per-minute'));
              if (pm){
                const f = { whole:4, half:2, quarter:1, eighth:.5, '16th':.25 }[txt(met, 'beat-unit')] || 1;
                tempo.push([at, pm * f * (kid(met, 'beat-unit-dot') ? 1.5 : 1)]);
              }
            }
          }
        }
      }
      if (t > maxT) maxT = t;
      const len = maxT / div;
      if (pi === 0) measures.push({ i: mi, label: me.getAttribute('number'), b: mq, len });
      mq += len;
    });
    const id = pe.getAttribute('id');
    parts.push({ xi: pi, name: (names[id] || '').trim() || ('Stem ' + (pi + 1)), notes });
  });
  const title = txt(kid(root, 'work') || root, 'work-title') || txt(root, 'movement-title') || 'Stuk';
  return finishPiece({ title, parts: parts.filter(p => p.notes.length), measures, tempo, time });
}

function parseMidi(ab){
  const dv = new DataView(ab), u8 = new Uint8Array(ab);
  const str = (o, n) => String.fromCharCode(...u8.slice(o, o + n));
  if (str(0, 4) !== 'MThd') throw new Error('midi');
  const ntrk = dv.getUint16(10), division = dv.getUint16(12);
  if (division & 0x8000) throw new Error('smpte');
  let o = 14; const parts = [], tempo = [], timeEv = [];
  let title = '';
  for (let t = 0; t < ntrk && o < u8.length; t++){
    if (str(o, 4) !== 'MTrk') break;
    const len = dv.getUint32(o + 4); let p = o + 8; const end = p + len; o = end;
    let tick = 0, status = 0, name = '';
    const on = new Map(), notes = [];
    const vlq = () => { let v = 0, b; do { b = u8[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
    while (p < end){
      tick += vlq();
      let s = u8[p];
      if (s & 0x80){ status = s; p++; } else s = status;
      if (s === 0xff){
        const type = u8[p++], l = vlq();
        if (type === 0x03) name = str(p, l);
        else if (type === 0x51 && l === 3) tempo.push([tick / division, 60000000 / ((u8[p] << 16) | (u8[p+1] << 8) | u8[p+2])]);
        else if (type === 0x58 && l >= 2) timeEv.push([tick / division, u8[p], Math.pow(2, u8[p+1])]);
        p += l;
      } else if (s === 0xf0 || s === 0xf7){ p += vlq(); }
      else {
        const hi = s & 0xf0, ch = s & 0x0f;
        const a = u8[p++], b = (hi === 0xc0 || hi === 0xd0) ? 0 : u8[p++];
        if (hi === 0x90 && b > 0){ on.set(ch * 128 + a, tick); }
        else if (hi === 0x80 || (hi === 0x90 && b === 0)){
          const k = ch * 128 + a, st = on.get(k);
          if (st != null && ch !== 9){ notes.push({ b: st / division, d: Math.max(0.01, (tick - st) / division), m: a, meas: 0, lyr: '' }); on.delete(k); }
        }
      }
    }
    if (t === 0 && name && !notes.length) title = name;
    if (notes.length) parts.push({ name: name.trim() || ('Spoor ' + (parts.length + 1)), notes });
  }
  if (!parts.length) throw new Error('empty');
  tempo.sort((x, y) => x[0] - y[0]);
  timeEv.sort((x, y) => x[0] - y[0]);
  const endB = Math.max(...parts.map(p => Math.max(...p.notes.map(n => n.b + n.d))));
  const measures = []; let b = 0, ts = timeEv.length ? timeEv[0] : [0, 4, 4], ti = 0, i = 0;
  const time = [];
  while (b < endB - 1e-6 && i < 2000){
    while (ti < timeEv.length && timeEv[ti][0] <= b + 1e-6){ ts = timeEv[ti]; time.push([i, ts[1], ts[2]]); ti++; }
    const len = ts[1] * 4 / ts[2];
    measures.push({ i, label: String(i + 1), b, len }); b += len; i++;
  }
  if (!time.length) time.push([0, 4, 4]);
  parts.forEach(p => p.notes.forEach(n => { n.meas = Math.min(measures.length - 1, Math.max(0, measures.findLastIndex(m => m.b <= n.b + 1e-6))); }));
  return finishPiece({ title: title || 'MIDI-bestand', parts, measures, tempo, time });
}

function finishPiece(pc){
  if (!pc.parts.length) throw new Error('empty');
  pc.hadTempo = pc.hadTempo || pc.tempo.length > 0;
  if (!pc.tempo.length) pc.tempo = [[0, 100]];
  pc.tempo.sort((a, b) => a[0] - b[0]);
  pc.tempo = pc.tempo.filter((t, i, arr) => i === arr.length - 1 || Math.abs(arr[i+1][0] - t[0]) > 1e-6);
  if (pc.tempo[0][0] > 0) pc.tempo.unshift([0, pc.tempo[0][1]]);
  if (!pc.time.length) pc.time = [[0, 4, 4]];
  // unieke maatnummers (anders: volgnummer)
  const labels = pc.measures.map(m => parseInt(m.label, 10));
  const uniq = new Set(labels).size === labels.length && labels.every(x => Number.isFinite(x));
  pc.measures.forEach((m, i) => { m.label = uniq ? labels[i] : i + 1; });
  // noten per stem sorteren
  pc.parts.forEach(p => p.notes.sort((a, b) => a.b - b.b || a.m - b.m));
  // seconden-kaart (bij 100% tempo)
  let s = 0; pc.tmap = pc.tempo.map((t, i) => {
    if (i > 0){ const pt = pc.tempo[i-1]; s += (t[0] - pt[0]) * 60 / pt[1]; }
    return { b: t[0], s, bpm: t[1] };
  });
  return pc;
}

/* ---- MXL (zip) ---- */
async function inflateRaw(bytes){
  if (typeof DecompressionStream === 'undefined') throw new Error('nodecomp');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function readZip(ab){
  const dv = new DataView(ab), u8 = new Uint8Array(ab);
  let e = u8.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('zip');
  const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
  const out = {};
  for (let i = 0; i < n; i++){
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const lo = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.slice(p + 46, p + 46 + nl));
    const lnl = dv.getUint16(lo + 26, true), lel = dv.getUint16(lo + 28, true);
    const data = u8.slice(lo + 30 + lnl + lel, lo + 30 + lnl + lel + csize);
    out[name] = { method, data };
    p += 46 + nl + el + cl;
  }
  return out;
}
async function zipText(entry){
  const bytes = entry.method === 0 ? entry.data : await inflateRaw(entry.data);
  return new TextDecoder('utf-8').decode(bytes);
}

async function parseFile(file){
  const ab = await file.arrayBuffer();
  const head = new Uint8Array(ab, 0, Math.min(4, ab.byteLength));
  const h = String.fromCharCode(...head);
  if (h === 'MThd') return parseMidi(ab);
  if (h.startsWith('PK')){
    const z = await readZip(ab);
    let root = null;
    if (z['META-INF/container.xml']){
      const c = new DOMParser().parseFromString(await zipText(z['META-INF/container.xml']), 'application/xml');
      const rf = c.getElementsByTagName('rootfile')[0];
      if (rf) root = rf.getAttribute('full-path');
    }
    if (!root || !z[root]) root = Object.keys(z).find(k => /\.(musicxml|xml)$/i.test(k) && !/^META-INF/i.test(k));
    if (!root) throw new Error('zip');
    const xt = await zipText(z[root]); const pcz = parseXML(xt); pcz.xml = xt; return pcz;
  }
  const xt2 = new TextDecoder('utf-8').decode(new Uint8Array(ab)).replace(/^﻿/, ''); const pcx = parseXML(xt2); pcx.xml = xt2; return pcx;
}

/* =========================================================
   Stuk, stem, tijdlijn
   ========================================================= */
const DEF = { chord:'top', level:'medium', speed:1, click:false, volL:{}, volS:{}, mixMode:'L', zoom:1 };
let O = loadO();
let piece = null, partIdx = 0, from = 1, to = 1, notes = [];
let state = 'idle';     // idle | count | listen | sing | done
let run = null;
let pan = 0, sel = null, geom = null;   // terugkijken na afloop

function loadO(){ let o; try { o = Object.assign({}, DEF, (JSON.parse(localStorage.getItem(LS) || '{}').o) || {}); if (o.mixV !== 3){ o.volL = {}; o.volS = {}; o.mixV = 3; } } catch(e){ o = Object.assign({}, DEF); } return o; }
function savePiece(){
  try {
    const pcs = piece ? { title: piece.title,
      parts: piece.parts.map(p => ({ name: p.name, notes: p.notes.map(n => [+n.b.toFixed(4), +n.d.toFixed(4), n.m, n.meas, n.lyr]) })),
      measures: piece.measures.map(m => [m.i, m.label, +m.b.toFixed(4), +m.len.toFixed(4)]), tempo: piece.tempo, time: piece.time, kies: piece.kies || null } : null;
    localStorage.setItem(LS, JSON.stringify({ o: O, piece: pcs, partIdx, from, to }));
  } catch(e){}
}
function restore(){
  try {
    const d = JSON.parse(localStorage.getItem(LS) || '{}');
    if (!d.piece) return false;
    const p = d.piece;
    piece = finishPiece({ title: p.title,
      parts: p.parts.map(q => ({ name: q.name, notes: q.notes.map(a => ({ b:a[0], d:a[1], m:a[2], meas:a[3], lyr:a[4] })) })),
      measures: p.measures.map(a => ({ i:a[0], label:a[1], b:a[2], len:a[3] })), tempo: p.tempo, time: p.time });
    if (p.kies) piece.kies = p.kies;
    partIdx = Math.min(d.partIdx || 0, piece.parts.length - 1);
    const first = piece.measures[0].label, last = piece.measures[piece.measures.length-1].label;
    from = Math.max(first, d.from || first); to = Math.min(last, d.to || last);
    return true;
  } catch(e){ return false; }
}

function demoPiece(){
  const seq = [60,62,64,65, 67,65,64,62, 64,67,72,67, 60,0,0,0];
  const dur = [1,1,1,1, 1,1,1,1, 1,1,1,1, 4,0,0,0];
  const ns = []; let b = 0;
  seq.forEach((m, i) => { if (m){ ns.push({ b, d: dur[i], m, meas: Math.floor(b / 4), lyr: ['do','re','mi','fa','sol','fa','mi','re','mi','sol','do','sol','do'][ns.length] || '' }); } b += dur[i] || 0; });
  const measures = [0,1,2,3].map(i => ({ i, label: String(i + 1), b: i * 4, len: 4 }));
  return finishPiece({ title: 'Voorbeeld: do-re-mi', parts: [{ name: 'Oefenmelodie', notes: ns }], measures, tempo: [[0, 80]], time: [[0, 4, 4]] });
}

function reduce(arr){
  const out = []; let i = 0;
  while (i < arr.length){
    let j = i; while (j + 1 < arr.length && Math.abs(arr[j+1].b - arr[i].b) < 1e-4) j++;
    let pick = arr[i];
    for (let k = i; k <= j; k++) if (O.chord === 'top' ? arr[k].m > pick.m : arr[k].m < pick.m) pick = arr[k];
    out.push(Object.assign({}, pick)); i = j + 1;
  }
  for (let k = 0; k < out.length - 1; k++) if (out[k+1].b < out[k].b + out[k].d - 1e-4) out[k].d = out[k+1].b - out[k].b;
  return out;
}

const labelToIdx = lab => { const i = piece.measures.findIndex(m => m.label === lab); return i < 0 ? 0 : i; };
function prepare(){
  idleT = null; if (window.NKscore && piece) scoreSync();
  notes = piece ? reduce(piece.parts[partIdx].notes) : [];
}
function secOf(b){
  const t = piece.tmap; let k = t.length - 1; while (k > 0 && t[k].b > b + 1e-9) k--;
  return t[k].s + (b - t[k].b) * 60 / t[k].bpm;
}
function bpmAt(b){ const t = piece.tmap; let k = t.length - 1; while (k > 0 && t[k].b > b + 1e-9) k--; return t[k].bpm; }
function sigAt(mi){ let r = piece.time[0]; for (const t of piece.time) if (t[0] <= mi) r = t; return r; }

function buildRun(kind, f0, t0){
  const i0 = labelToIdx(f0 != null ? f0 : from), i1 = Math.max(i0, labelToIdx(t0 != null ? t0 : to));
  const bS = piece.measures[i0].b, bE = piece.measures[i1].b + piece.measures[i1].len;
  const sp = O.speed, s0 = secOf(bS);
  const sec = b => (secOf(b) - s0) / sp;
  const rn = { kind, bS, bE, speed: sp, frames: [], notes: [], dur: sec(bE), sec };
  for (const n of notes){
    if (n.b < bS - 1e-6 || n.b >= bE - 1e-6) continue;
    const e = Math.min(n.b + n.d, bE);
    rn.notes.push({ b: n.b, m: n.m, meas: n.meas, lyr: n.lyr, s: sec(n.b), e: sec(e), status: null });
  }
  const sig = sigAt(i0);
  const compound = sig[2] === 8 && sig[1] % 3 === 0;
  const pulseQ = compound ? 1.5 : 4 / sig[2];
  rn.nPulse = compound ? sig[1] / 3 : sig[1];
  rn.pulse = pulseQ * 60 / bpmAt(bS) / sp;
  rn.i0 = i0; rn.i1 = i1;
  return rn;
}

/* =========================================================
   Geluid
   ========================================================= */
const isPiano = p => /piano|klavier|vleugel|keyboard|toetsen/i.test(p && p.name || '');
// pianogeluid: korte aanslag, daarna uitklinkend; hogere tonen sneller weg
function playPiano(bus, t, d, m, vol){
  const ac = C.ac, f = mtof(m), g = ac.createGain(), v = vol * 0.8;
  const ring = Math.max(0.25, Math.min(d + 0.35, 2.6 - (m - 48) * 0.02));
  const end = t + ring;
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.006);
  g.gain.exponentialRampToValueAtTime(v * 0.35, t + Math.min(0.35, ring * 0.4));
  g.gain.exponentialRampToValueAtTime(0.0008, end);
  const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(6000, f * 7); lp.Q.value = 0.3;
  g.connect(lp); lp.connect(bus);
  [[1,1,'sine'],[2,.5,'sine'],[3,.28,'sine'],[4,.14,'triangle'],[5,.07,'sine']].forEach(([k, a, ty]) => {
    if (f * k > 9000) return;
    const o = ac.createOscillator(); o.type = ty; o.frequency.value = f * k; o.detune.value = (k - 1) * 1.5;
    const gg = ac.createGain(); gg.gain.setValueAtTime(a / 2.0, t); gg.gain.exponentialRampToValueAtTime(a / 2.0 * 0.15, t + Math.max(0.2, ring / k));
    o.connect(gg); gg.connect(g); o.start(t); o.stop(end + 0.03);
  });
}
function playNote(bus, t, d, m, vol, own, piano){
  if (piano && !own) return playPiano(bus, t, d, m, vol);
  const ac = C.ac, f = mtof(m), g = ac.createGain();
  if (own){   // eigen stem: helderder, 'rietachtig' geluid zodat je hem makkelijk herkent
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200; lp.Q.value = 0.5;
    g.connect(lp); lp.connect(bus); vol *= 0.9;
  } else g.connect(bus);
  const end = t + Math.max(0.06, d - 0.03);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.03);
  g.gain.setValueAtTime(vol, Math.max(t + 0.03, end - 0.06)); g.gain.linearRampToValueAtTime(0, end);
  if (own){   // eigen stem: stabiel, hol 'klarinet'-geluid (alleen oneven boventonen, geen zweving of zoem): duidelijk anders dan de zachte sinus van de andere stemmen
    [[1,1],[3,.55],[5,.3],[7,.14],[9,.06]].forEach(([k, a]) => {
      const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f * k;
      const gg = ac.createGain(); gg.gain.value = a / 2.1; o.connect(gg); gg.connect(g); o.start(t); o.stop(end + 0.03);
    });
    return;
  }
  [[1,1],[2,.35],[3,.12]].forEach(([k, a]) => {
    const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f * k;
    const gg = ac.createGain(); gg.gain.value = a / 1.47; o.connect(gg); gg.connect(g); o.start(t); o.stop(end + 0.03);
  });
}
function click(bus, t, accent){
  const ac = C.ac, o = ac.createOscillator(), g = ac.createGain();
  o.frequency.value = accent ? 1500 : 1000; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.35, t + .004); g.gain.exponentialRampToValueAtTime(.001, t + .07);
  o.connect(g); g.connect(bus); o.start(t); o.stop(t + .09);
}
const redCache = new WeakMap();
const reducedOf = p => { let r = redCache.get(p); if (!r || r.chord !== O.chord){ r = { chord: O.chord, notes: reduce(p.notes) }; redCache.set(p, r); } return r.notes; };
// volume per stem: eigen stem apart ('own'), andere stemmen op volgnummer
function volOf(kind, pi){
  const m = kind === 'sing' ? O.volS : O.volL;
  if (pi === partIdx){ const v = m.own; return v != null ? v : 1; }
  const v = m[pi]; return v != null ? v : (isPiano(piece && piece.parts[pi]) ? 0.45 : 0.1);
}
function applyMix(){
  if (!run || !run.partBus) return;
  run.partBus.forEach((g, pi) => { try { g.gain.setTargetAtTime(volOf(run.kind, pi), C.ac.currentTime, 0.02); } catch(e){} });
}
// metronoomtikken volgen de maatsoort van elke maat (ook bij wisselende maatsoorten)
function buildClicks(rn){
  const out = [];
  for (let mi = rn.i0; mi <= rn.i1; mi++){
    const m = piece.measures[mi], sig = sigAt(mi), compound = sig[2] === 8 && sig[1] % 3 === 0;
    const pq = compound ? 1.5 : 4 / sig[2], n = compound ? sig[1] / 3 : sig[1];
    for (let k = 0; k < n; k++){
      const b = m.b + k * pq;
      if (b >= m.b + m.len - 1e-6 || b >= rn.bE - 1e-6) break;
      out.push({ s: rn.sec(b), accent: k === 0 });
    }
  }
  return out;
}
function startAudio(rn){
  const ac = C.ac, bus = ac.createGain(); bus.connect(ac.destination); rn.bus = bus;
  rn.partBus = piece.parts.map((p, pi) => { const g = ac.createGain(); g.gain.value = volOf(rn.kind, pi); g.connect(bus); return g; });
  const ev = [];
  if (rn.kind === 'sing'){
    for (let k = 0; k < rn.nPulse; k++) ev.push({ t: rn.cs + k * rn.pulse, click: true, accent: k === 0 });
  }
  piece.parts.forEach((p, pi) => {
    const pno = isPiano(p) && pi !== partIdx;
    for (const n of (pno ? p.notes : reducedOf(p))){
      if (n.b < rn.bS - 1e-6 || n.b >= rn.bE - 1e-6) continue;
      const s0 = rn.sec(n.b);
      ev.push({ t: rn.t0 + s0, d: rn.sec(Math.min(n.b + n.d, rn.bE)) - s0, m: n.m, vol: 0.32, pi, pno });
    }
  });
  ev.sort((a, b) => a.t - b.t);
  let i = 0, ci = 0; rn.clicks = buildClicks(rn);
  const tick = () => {
    const lim = ac.currentTime + 0.7;
    // metronoom: live aan/uit te zetten tijdens het afspelen
    while (ci < rn.clicks.length && rn.t0 + rn.clicks[ci].s < lim){
      const c = rn.clicks[ci++], tt = rn.t0 + c.s;
      if (O.click && tt >= ac.currentTime - 0.05) click(bus, tt, c.accent);
    }
    while (i < ev.length && ev[i].t < lim){
      const e = ev[i++];
      if (e.t < ac.currentTime - 0.05) continue;
      if (e.click) click(bus, e.t, e.accent); else playNote(rn.partBus[e.pi], e.t, e.d, e.m, e.vol, e.pi === partIdx, e.pno);
    }
    if (i >= ev.length && ci >= rn.clicks.length) { clearInterval(rn.timer); rn.timer = null; }
  };
  tick(); rn.timer = setInterval(tick, 40);
}
function stopAudio(rn){
  if (!rn) return;
  if (rn.timer){ clearInterval(rn.timer); rn.timer = null; }
  if (rn.bus){ try { rn.bus.gain.cancelScheduledValues(C.ac.currentTime); rn.bus.gain.setTargetAtTime(0, C.ac.currentTime, 0.015); } catch(e){} }
}

/* =========================================================
   Beoordeling per noot
   ========================================================= */
// niveaus: hoe ruim de toonhoogte (cent) en het ritme (seconden) beoordeeld worden
const LEVELS = {
  easy:   { name: 'Easy',   tol: 50, on: 0.50, off: 0.50 },
  medium: { name: 'Medium', tol: 40, on: 0.35, off: 0.35 },
  hard:   { name: 'Hard',   tol: 30, on: 0.20, off: 0.20 }
};
const curLvl = () => LEVELS[O.level] || LEVELS.medium;
const RHY = { early: 1, late: 1, short: 1, long: 1 };
function foldDev(d){ return C.S.octave ? ((d + 6) % 12 + 12) % 12 - 6 : d; }
function rhythmOf(rn, n){
  const L = curLvl(), i = rn._ix ? rn._ix.get(n) : rn.notes.indexOf(n);
  const prev = rn.notes[i - 1], next = rn.notes[i + 1];
  const close = f => f.m != null && Math.abs(foldDev(f.m - n.m)) <= 1.0;
  const T = rn.t0 + n.s + LAT, TE = rn.t0 + n.e + LAT, fr = rn.frames;
  // begin: alleen als het begin goed te horen is (pauze ervoor of een andere toon ervoor)
  const canOn = !prev || prev.e < n.s - 0.08 || Math.abs(foldDev(prev.m - n.m)) > 1.3;
  if (canOn){
    let on = null;
    for (let j = 0; j + 2 < fr.length; j++){
      const f = fr[j]; if (f.t < T - 0.5) continue; if (f.t > T + 0.6) break;
      if (close(f) && close(fr[j + 1]) && close(fr[j + 2])){ on = f.t; break; }
    }
    if (on != null){
      const d = on - T;
      if (d > L.on) return { k: 'late', dt: d };
      if (d < -L.on) return { k: 'early', dt: d };
    }
  }
  // einde: alleen bij een pauze erna (anders is het einde niet te horen)
  const canOff = !next || next.s - n.e >= 0.3;
  if (canOff && n.e - n.s >= 0.3){
    let last = null;
    for (let j = 0; j < fr.length; j++){
      const f = fr[j]; if (f.t < T) continue; if (f.t > TE + L.off + 0.15) break;
      if (close(f)) last = f.t;
    }
    if (last != null){
      const e = last - TE;
      if (e < -L.off) return { k: 'short', dt: e };
      if (e > L.off) return { k: 'long', dt: e };
    }
  }
  return null;
}
function evalNote(rn, n){
  const dur = n.e - n.s, skip = Math.min(0.3, dur * 0.35);
  const a = rn.t0 + n.s + skip + LAT, b = rn.t0 + n.e + LAT - 0.03;
  let tot = 0; const v = [];
  for (const f of rn.frames){ if (f.t < a) continue; if (f.t > b) break; tot++; if (f.m != null) v.push(f.m); }
  if (tot < 2 || v.length < 2 || v.length < 0.3 * tot) return { k: 'none' };
  const med = median(v); let dev = med - n.m;
  if (C.S.octave) dev = ((dev + 6) % 12 + 12) % 12 - 6;
  const cents = dev * 100, tol = curLvl().tol * (dur < 0.25 ? 1.6 : 1);
  if (Math.abs(cents) > tol) return { k: cents > 0 ? 'high' : 'low', cents, sung: med };
  const r = rhythmOf(rn, n);
  if (r) return { k: r.k, dt: r.dt, cents, sung: med };
  return { k: 'ok', cents, sung: med };
}
function scoreAll(rn, final){
  const now = C.ac.currentTime;
  if (!rn._ix || rn._ixn !== rn.notes.length){ rn._ix = new Map(rn.notes.map((x, i) => [x, i])); rn._ixn = rn.notes.length; }
  for (const n of rn.notes){
    if (n.status) continue;
    if (!final && now < rn.t0 + n.e + LAT + 0.05 + curLvl().off + 0.2) break;
    n.status = evalNote(rn, n);
  }
}

/* =========================================================
   Bediening
   ========================================================= */
function stopAll(){
  recDiscard(); stopAudio(run); run = null; state = 'idle'; sres.hidden = true; if (window.NKscore) NKscore.clearMarks(); refresh();
}
async function start(kind){
  if (!piece || !notes.length){ openSetup(); return; }
  if (!buildRunPreview().notes.length){ updateNone(); return; }
  if (!C.ac) return;
  stopAudio(run); sres.hidden = true; pan = 0; sel = null; lastPan = 0; if (window.NKscore) NKscore.clearMarks();
  try { await C.ac.resume(); } catch(e){}
  const rn = buildRun(kind), now = C.ac.currentTime;
  if (kind === 'sing'){ rn.cs = now + 0.25; rn.t0 = rn.cs + rn.nPulse * rn.pulse; state = 'count'; }
  else { rn.t0 = now + 0.35; state = 'listen'; }
  run = rn; startAudio(rn); if (kind === 'sing') recStart(); refresh();
}
// tussentijds stoppen met zingen: je krijgt toch een analyse van wat je gezongen hebt
function stopSing(){
  if (!run || run.kind !== 'sing' || state !== 'sing'){ stopAll(); return; }
  const el = C.ac.currentTime - run.t0 - LAT;
  recStop(); stopAudio(run);
  run.notes = run.notes.filter(n => n.status || n.s + Math.min(0.3, (n.e - n.s) * 0.35) + 0.35 <= el);
  run.dur = Math.max(0.5, el);
  scoreAll(run, true);
  run.frozen = Math.max(0.5, el) + 0.5; state = 'done'; pan = 0; sel = null;
  saveAttempt(run); showResult(); refresh();
}
function finish(){
  if (!run) return;
  if (run.kind === 'sing'){
    recStop(); scoreAll(run, true); run.frozen = run.dur + 0.5; state = 'done'; saveAttempt(run); showResult();
  } else { stopAudio(run); run = null; state = 'idle'; }
  refresh();
}

/* =========================================================
   Weergave
   ========================================================= */
const cvEl = $('cv');
let sungM = null, medBuf = [];

function frame(ctx, W, H, dpr){
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const ac = C.ac, now = ac ? ac.currentTime : 0;
  if (run){
    if (state === 'count' && now >= run.t0){ state = 'sing'; refresh(); }
    if (state === 'sing' && C.analyser){ C.analyser.getFloatTimeDomainData(C.buf); sample(now); scoreAll(run, false); }
    if ((state === 'sing' || state === 'listen') && now - run.t0 > run.dur + (run.kind === 'sing' ? 0.9 : 0.4)) finish();
  }
  if (run && state === 'done') pan = Math.max(-1 - run.frozen, Math.min(0.4, pan));
  // in rust: het hele stuk, te verschuiven; begint bij de gekozen maat
  let idleM = -0.6;
  if (!run && piece && notes.length){ const rv = buildRunView(); if (idleT == null) idleT = initIdleT(rv); idleM = idleT; }
  const mnow = !run ? idleM : (state === 'done' ? run.frozen + pan : now - run.t0);
  if (window.NKscore) scoreFrame(mnow);

  // toonbereik van deze stem
  let lo = 55, hi = 76;
  if (notes.length){ lo = Math.min(...notes.map(n => n.m)) - 3; hi = Math.max(...notes.map(n => n.m)) + 3; }
  while (hi - lo < 13){ hi++; if (hi - lo < 13) lo--; }
  const n_ = hi - lo + 1, KW = Math.max(64, Math.min(84, W * 0.2)), gw = W - KW, rh = H / n_;
  const pxps = gw / (WINDOW * O.zoom), phX = gw * PLAYHEAD;
  geom = { KW, gw, rh, lo, hi, phX, pxps, mnow };
  const rowY = m => (hi - m) * rh;

  ctx.save(); ctx.translate(KW, 0);
  for (let m = lo; m <= hi; m++){
    ctx.fillStyle = isBlack(m) ? '#202328' : '#2a2d33'; ctx.fillRect(0, rowY(m), gw, rh + .5);
    const pc = ((m % 12) + 12) % 12;
    ctx.fillStyle = (pc === 0 || pc === 5) ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.04)'; ctx.fillRect(0, rowY(m) + rh - .5, gw, 1);
  }

  // maatstrepen
  if (piece && notes.length){
    const rn = run || buildRunView();
    ctx.font = '600 11px -apple-system,sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (let i = rn.i0; i <= rn.i1; i++){
      const ms = piece.measures[i], x = phX + (rn.sec(ms.b) - mnow) * pxps;
      if (x < -40 || x > gw + 4) continue;
      ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fillRect(x, 0, 1, H);
      ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.fillText(String(ms.label), x + 4, 4);
    }
    // doelnoten
    const bh = Math.max(6, rh * 0.78);
    let activeM = null;
    for (const n of rn.notes){
      const x0 = phX + (n.s - mnow) * pxps, x1 = phX + (n.e - mnow) * pxps;
      if (x1 < -4 || x0 > gw) continue;
      const active = mnow >= n.s && mnow < n.e; if (active) activeM = n.m;
      const st = n.status;
      let fill = active ? 'rgba(60,207,122,.85)' : 'rgba(60,207,122,.5)';
      if (st){ fill = st.k === 'ok' ? '#3ccf7a' : st.k === 'none' ? '#6b7080' : RHY[st.k] ? '#f2b233' : '#ff6b5e'; }
      const y = rowY(n.m) + (rh - bh) / 2, w = Math.max(3, x1 - x0 - 1.5);
      ctx.fillStyle = fill;
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x0, y, w, bh, 3); else ctx.rect(x0, y, w, bh); ctx.fill();
      if (state === 'done' && st && (st.k === 'high' || st.k === 'low')){
        const sy = (hi - (n.m + st.cents / 100) + .5) * rh;
        if (sy > 0 && sy < H){ ctx.fillStyle = '#fff'; ctx.fillRect(x0, sy - 1, Math.max(3, x1 - x0 - 1.5), 2); }
      }
      if (n === sel){ ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x0 - 1, y - 1, w + 2, bh + 2, 4); else ctx.rect(x0 - 1, y - 1, w + 2, bh + 2); ctx.stroke(); }
      if (st && (st.k === 'high' || st.k === 'low') && w > 14){
        ctx.fillStyle = '#2b0a06'; ctx.font = '700 ' + Math.min(14, bh) + 'px -apple-system,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(st.k === 'high' ? '↓' : '↑', x0 + w / 2, y + bh / 2 + .5);
      }
      if (n.lyr && w > 22 && bh >= 12 && !(st && (st.k === 'high' || st.k === 'low'))){
        ctx.fillStyle = st ? '#0d1a11' : '#e9fff1'; ctx.font = '600 ' + Math.min(12, bh - 1) + 'px -apple-system,sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.save(); ctx.beginPath(); ctx.rect(x0, y, w, bh); ctx.clip(); ctx.fillText(n.lyr, x0 + 4, y + bh / 2 + .5); ctx.restore();
      }
    }
    // stem
    if (run && run.frames.length){
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath();
      let pen = false, pt = 0;
      let startK = 0; for (let k = run.frames.length - 1; k >= 0; k--){ if (phX + ((run.frames[k].t - run.t0) - mnow) * pxps < -4){ startK = k; break; } }
      for (let k = startK; k < run.frames.length; k++){
        const f = run.frames[k];
        if (f.m == null || f.m < lo - 3 || f.m > hi + 3){ pen = false; continue; }
        const x = phX + ((f.t - run.t0) - mnow) * pxps, y = (hi - Math.max(lo - .5, Math.min(hi + .5, f.m)) + .5) * rh;
        if (!pen || f.t - pt > 0.12){ ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
        pt = f.t;
      }
      ctx.stroke();
    }
    // afspeellijn
    ctx.fillStyle = 'rgba(255,190,80,.9)'; ctx.fillRect(phX - .75, 0, 1.5, H);
    // aftellen
    if (state === 'count'){
      const k = Math.min(run.nPulse, Math.floor((now - run.cs) / run.pulse) + 1);
      if (k >= 1){
        ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.font = '700 ' + Math.min(110, H * 0.2) + 'px -apple-system,sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(k), gw * 0.55, H * 0.45);
      }
    }
    ctx.restore();
    drawKeys(ctx, KW, lo, hi, rh, activeM, state === 'sing' ? sungM : null);
  } else {
    ctx.restore();
    drawKeys(ctx, KW, lo, hi, rh, null, null);
    ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.font = '600 16px -apple-system,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Laad een stuk via de knop “Stuk”', KW + gw / 2, H / 2);
  }
  ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(KW - .5, 0, 1, H);
  updateHead();
}
function sample(now){
  const r = C.detect(C.buf, C.ac.sampleRate);
  let m = null;
  if (r.voiced){ medBuf.push(r.midi); if (medBuf.length > 5) medBuf.shift(); m = median(medBuf); } else if (medBuf.length) medBuf.shift();
  sungM = m;
  if (run) run.frames.push({ t: now, m });
}
let viewRun = null, viewKey = '', idleT = null;
function buildRunView(){
  const key = [piece.title, partIdx, O.speed, O.chord].join('|');
  if (key !== viewKey){ viewRun = buildRun('listen', piece.measures[0].label, piece.measures[piece.measures.length - 1].label); viewKey = key; idleT = null; }
  return viewRun;
}
function startOfFrom(rv){ return rv.sec(piece.measures[labelToIdx(from)].b); }
function initIdleT(rv){
  const st = startOfFrom(rv); let first = null;
  for (const n of rv.notes) if (n.s >= st - 1e-6 && (first == null || n.s < first)) first = n.s;
  return st + Math.max(-0.6, first == null ? -0.6 : first - st - 1.2);
}
let previewRun = null, previewKey = '';
function buildRunPreview(){
  const key = [piece.title, partIdx, from, to, O.speed, O.chord].join('|');
  if (key !== previewKey){ previewRun = buildRun('listen'); previewKey = key; }
  return previewRun;
}
function drawKeys(ctx, KW, lo, hi, rh, target, sung){
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.font = '600 ' + Math.max(10, Math.min(15, rh * 0.62)) + 'px -apple-system,sans-serif';
  const sr = sung != null ? Math.round(sung) : null;
  for (let m = lo; m <= hi; m++){
    const y = (hi - m) * rh, hit = m === target, sg = m === sr;
    if (isBlack(m)){
      ctx.fillStyle = hit ? '#3ccf7a' : (sg ? '#e8890c' : '#17191c'); ctx.fillRect(0, y, KW, rh + .5);
      if (hit || sg){ ctx.fillStyle = '#10130f'; ctx.fillText(nm(m), KW - 9, y + rh / 2 + .5); }
      continue;
    }
    const fill = hit ? '#3ccf7a' : (sg ? '#e8890c' : '#c6cadb');
    ctx.fillStyle = fill; ctx.fillRect(0, y, KW, rh + .5);
    ctx.fillStyle = 'rgba(30,32,40,.55)'; ctx.fillRect(0, y, KW, 1);
    ctx.fillStyle = fill === '#c6cadb' ? '#3b3f4d' : '#10130f'; ctx.fillText(nm(m), KW - 9, y + rh / 2 + .5);
  }
}

/* =========================================================
   Interface
   ========================================================= */
const css = document.createElement('style');
css.textContent = `
body:not(.stuk) .stuk-only{display:none!important}
body.stuk #bar,body.stuk #res,body.stuk #card,body.stuk #meter,body.stuk #chip{display:none!important}
#shead{position:absolute;top:8px;left:calc(var(--kw) + 10px);right:10px;display:flex;justify-content:space-between;gap:10px;align-items:center;pointer-events:none;z-index:3}
#shead .a{padding:6px 11px;border-radius:12px;background:rgba(23,25,28,.85);border:1px solid var(--line);font-size:13px;color:#d7dae5;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#shead .a b{color:#fff}
#shead .b{padding:6px 11px;border-radius:999px;background:rgba(23,25,28,.85);border:1px solid var(--line);font-size:13px;color:var(--mute);font-variant-numeric:tabular-nums;flex:none}
#sres[hidden]{display:none}
#sstatus{margin:8px 0 0;color:var(--mute);font-size:14px}
#fileLbl{display:block;text-align:center}
#koorCode{width:100%;padding:14px;border-radius:12px;border:1px solid var(--line);background:#2b2f37;color:var(--ink);font:inherit;font-size:17px}
.kstuk{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;text-align:left;padding:13px 14px;border-radius:12px;background:#2b2f37}
.kstuk small{display:block;color:var(--mute);font-size:13px}
.kstuk b{font-weight:650}
.stp{display:flex;gap:10px;align-items:center}
.stp input{width:84px;padding:11px 8px;border-radius:10px;border:1px solid var(--line);background:#2b2f37;color:var(--ink);font:inherit;text-align:center}
.stp span{color:var(--mute)}
.small{font-size:13px;color:var(--mute);margin-top:6px}
.issue{font-size:13px;color:#d7dae5;margin-top:4px}
#smix{position:absolute;left:8px;right:8px;bottom:8px;max-height:64%;overflow:auto;-webkit-overflow-scrolling:touch;padding:14px;border-radius:16px;background:rgba(30,33,38,.98);border:1px solid var(--line);box-shadow:0 10px 34px rgba(0,0,0,.55);z-index:5}
#smix[hidden]{display:none}
#smix .hd{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px}
#smix .hd b{font-size:17px}
#smix .x{padding:8px 14px;border-radius:10px;background:#363a43;font-weight:650}
.mix{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr) 42px;gap:10px;align-items:center;margin-top:12px;font-size:14px}
.mix input[type=range]{width:100%;accent-color:var(--orange);margin:0}
.mix .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mix .nm b{color:var(--orange);font-weight:650}
.mix .pc{text-align:right;color:var(--mute);font-variant-numeric:tabular-nums}
.qb{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
.qb button{padding:9px 12px;border-radius:10px;background:#363a43;font-size:13px;font-weight:600}
#nav{display:flex;gap:8px;margin-top:10px}
#snone{position:absolute;left:calc(var(--kw) + 16px);right:16px;top:30%;padding:16px;border-radius:14px;background:rgba(23,25,28,.95);border:1px solid var(--line);z-index:4;text-align:center;font-size:15px;color:#e6e8f0}
#snone[hidden],#vaCont[hidden]{display:none!important}
#snone{pointer-events:none}#snone button{pointer-events:auto}
#shint{position:absolute;left:calc(var(--kw) + 10px);right:10px;bottom:10px;text-align:center;font-size:12px;color:var(--mute);background:rgba(23,25,28,.8);border-radius:999px;padding:6px 10px;pointer-events:none;z-index:3}
#shint[hidden]{display:none}
#szoom{position:absolute;right:10px;top:52px;display:flex;flex-direction:column;gap:6px;z-index:3}
#szoom button{width:40px;height:40px;border-radius:12px;background:rgba(23,25,28,.85);border:1px solid var(--line);color:#fff;font-size:22px;font-weight:600;line-height:1}
.prog{margin-top:10px}
.mstrip{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
.mc{min-width:28px;padding:5px 4px;border-radius:7px;font-size:11px;font-weight:650;text-align:center;background:#3a3e48;color:#aab0c0;cursor:pointer;user-select:none}
.mc.goed{background:#3ccf7a;color:#0d1a11}.mc.wankel{background:#e8890c;color:#221300}.mc.opnieuw{background:#ff6b5e;color:#2b0a06}
.pl{font-size:13px;color:#d7dae5;margin-top:3px;line-height:1.35}
.pl i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px;background:#3a3e48}
.pl.goed i{background:#3ccf7a}.pl.wankel i{background:#e8890c}.pl.opnieuw i{background:#ff6b5e}
.hrow{display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:12px;background:#2b2f37;margin-top:8px}
.hrow .t{flex:1;min-width:0;font-size:14px}.hrow .t small{display:block;color:var(--mute);font-size:12px;margin-top:2px}
.hrow button{flex:none;padding:8px 12px;border-radius:10px;background:#3a3e48;font-weight:600;font-size:13px;color:#fff}
#nav button{flex:1;padding:9px 8px;border-radius:10px;background:#2f333b;font-size:13px;font-weight:600;color:#d7dae5}
#sbar .col{width:64px}#sbar .col .lbl{white-space:nowrap}#sMet.on{background:var(--orange);color:#1c1105}#sMet.on svg{stroke:#1c1105}
`;
document.head.append(css);

const stage = $('stage'), app = $('app');
const head = document.createElement('div'); head.id = 'shead'; head.className = 'stuk-only';
head.innerHTML = '<div class="a" id="sheadA"></div><div class="b" id="sheadB"></div>'; stage.append(head);

const szoom = document.createElement('div'); szoom.id = 'szoom'; szoom.className = 'stuk-only';
szoom.innerHTML = '<button id="zIn" aria-label="Inzoomen">+</button><button id="zOut" aria-label="Uitzoomen">−</button>'; stage.append(szoom);
const shint = document.createElement('div'); shint.id = 'shint'; shint.className = 'stuk-only'; shint.textContent = '← Sleep om naar een andere maat te gaan →'; shint.hidden = true; stage.append(shint);
const sno = document.createElement('div'); sno.id = 'snone'; sno.className = 'stuk-only'; sno.hidden = true; stage.append(sno);
const sres = document.createElement('div'); sres.id = 'sres'; sres.className = 'stuk-only'; sres.hidden = true;
sres.innerHTML = '<div class="top"><div class="badge" id="sbadge"></div><div style="min-width:0"><div id="stitle"></div><div id="sdetail"></div></div></div><div id="sissues"></div><div id="srec"></div><div class="btns" id="sbtns"></div>';
app.insertBefore(sres, $('bar'));

const sbar = document.createElement('div'); sbar.id = 'sbar'; sbar.className = 'stuk-only';
sbar.innerHTML = `
<div class="col"><button id="sMix" aria-label="Mixer"><svg viewBox="0 0 24 24"><path d="M5 4v16M12 4v16M19 4v16"/><circle cx="5" cy="14" r="2" fill="currentColor"/><circle cx="12" cy="8" r="2" fill="currentColor"/><circle cx="19" cy="15" r="2" fill="currentColor"/></svg></button><span class="lbl">Mixer</span></div>
<div class="col"><button id="sListen" aria-label="Luister"><svg viewBox="0 0 24 24"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13"/></svg></button><span class="lbl" id="sListenL">Luister</span></div>
<div class="col"><button id="sSing" class="big" aria-label="Zing mee"><svg viewBox="0 0 24 24" id="sSingI"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg></button><span class="lbl" id="sSingL">Zing mee</span></div>
<div class="col"><button id="sMet" aria-label="Metronoom"><svg viewBox="0 0 24 24"><path d="M9 3h6l4 18H5L9 3z"/><path d="M12 17L16 7"/><circle cx="16" cy="7" r="1.5" fill="currentColor"/></svg></button><span class="lbl" id="sMetL">Metronoom</span></div>`;
app.append(sbar);

const sheet = document.createElement('div'); sheet.className = 'sheet stuk-only'; sheet.id = 'ssetup'; sheet.hidden = true;
sheet.innerHTML = `<div class="wrap">
<div id="vA">
<h1 style="font-size:32px">Repertoire</h1>
<button class="go" id="vaCont" hidden style="margin-top:14px"></button>
<div id="koorOut">
  <h2>Log in met je koorcode</h2>
  <input id="koorCode" type="text" placeholder="Koorcode" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false">
  <button class="go sec" id="koorGo" style="margin-top:10px">Open mijn koor</button>
  <div class="small">De code heb je van je dirigent gekregen.</div>
</div>
<div id="koorIn" hidden>
  <h2 id="koorNaam"></h2>
  <div id="koorList" style="display:grid;gap:10px"></div>
  <button class="btn" id="koorUit" style="margin-top:14px;flex:none;padding:10px 14px">Uitloggen</button>
</div>
<div id="koorMsg" class="small"></div>
<details id="eigen" style="margin-top:26px"><summary style="color:var(--mute);font-size:14px;cursor:pointer">Eigen bestand of voorbeeld</summary>
<label class="go sec" id="fileLbl" style="margin-top:12px">Kies MusicXML of MIDI<input id="fileIn" type="file" multiple style="display:none"></label>
<label class="go sec" id="fileLbl2" style="margin-top:10px">Voeg nog bestanden toe (bijvoorbeeld een andere stem)<input id="fileAdd" type="file" multiple style="display:none"></label>
<div class="small">Je kunt één bestand met alle stemmen kiezen, of meerdere bestanden tegelijk, bijvoorbeeld één MIDI per stem. De bestandsnaam wordt dan de naam van de stem.</div>
<button class="go sec" id="demoBtn" style="margin-top:10px">Voorbeeldmelodie laden</button>
</details>
<div id="sstatus"></div>
</div>
<div id="vB" hidden>
<button class="btn" id="vbBack" style="flex:none;padding:10px 14px">← Ander stuk kiezen</button>
<h1 style="font-size:28px;margin-top:14px" id="vbTitle"></h1>
<div class="small" id="vbInfo"></div>
<div id="partWrap"><h2>Stem</h2><div class="seg" id="partSeg"></div><button class="go sec" id="histBtn" style="margin-top:12px">Mijn resultaten bij deze stem</button><button class="go sec" id="recBtn" style="margin-top:10px">Mijn opnames</button></div>
<h2>Maten</h2>
<div class="stp"><input id="mFrom" type="number" inputmode="numeric" min="1"><span>tot en met</span><input id="mTo" type="number" inputmode="numeric" min="1"><button class="btn" id="mAll" style="flex:none;padding:11px 14px">Alles</button></div>
<div class="small" id="mHint"></div>
<h2>Tempo</h2><div class="seg" id="spdSeg"></div>
<h2>Niveau</h2><div class="seg" id="lvlSeg"></div>
<div class="small" id="lvlHint"></div>
<h2>Bij gedeelde stemmen</h2><div class="seg" id="chordSeg"></div>
<div class="small">Heeft een stem op één moment twee noten, dan oefen je de bovenste of onderste.</div>
<div class="small" style="margin-top:14px">Het volume van elke stem stel je in met de knop “Mixer” onderin het scherm. Gebruik oordopjes als er stemmen meespelen tijdens het zingen.</div>
<h2>Opties</h2>
<div class="row"><div>Metronoom</div><button class="sw" id="swClick" aria-label="Klik"></button></div>
<button class="go" id="sDone">Klaar</button>

</div>
</div>`;
document.body.append(sheet);

function seg(el, items, cur, on){
  el.innerHTML = '';
  items.forEach(([val, label]) => {
    const b = document.createElement('button'); b.textContent = label; if (val === cur) b.className = 'on';
    b.onclick = () => { on(val); seg(el, items, val, on); }; el.append(b);
  });
}
function partNames(){
  const cnt = {}; piece.parts.forEach(p => cnt[p.name] = (cnt[p.name] || 0) + 1);
  const seen = {};
  return piece.parts.map(p => { seen[p.name] = (seen[p.name] || 0) + 1; return cnt[p.name] > 1 ? p.name + ' ' + seen[p.name] : p.name; });
}
function fmtLen(){ return piece.measures.length; }
function renderSetup(){
  renderKoor();
  $('sstatus').textContent = '';
  $('vbTitle').textContent = piece ? piece.title : '';
  $('vbInfo').textContent = piece ? piece.parts.length + (piece.parts.length === 1 ? ' stem' : ' stemmen') + ' · ' + fmtLen() + ' maten' : '';
  $('vaCont').hidden = !piece; if (piece) $('vaCont').textContent = 'Verder met “' + piece.title + '”';
  $('partWrap').hidden = !piece;
  if (piece){
    const names = partNames();
    seg($('partSeg'), names.map((n, i) => [i, n]).filter(([i, n]) => !piece.kies || piece.kies.includes(n)), partIdx, v => { partIdx = v; prepare(); });
    const first = piece.measures[0].label, last = piece.measures[piece.measures.length - 1].label;
    $('mFrom').value = from; $('mTo').value = to;
    $('mHint').textContent = 'Maat ' + first + ' tot en met ' + last + ' beschikbaar.';
  }
  seg($('spdSeg'), [[.5, '50%'], [.7, '70%'], [.85, '85%'], [1, '100%']], O.speed, v => { O.speed = v; });
  { const lh = { easy: 'Ruim: toon mag ±50 cent afwijken en het ritme maximaal 0,5 seconde.', medium: 'Gemiddeld: toon ±40 cent, ritme maximaal 0,35 seconde.', hard: 'Streng: toon ±30 cent, ritme maximaal 0,2 seconde.' };
    seg($('lvlSeg'), [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']], O.level, v => { O.level = v; $('lvlHint').textContent = lh[v]; });
    $('lvlHint').textContent = lh[O.level] || ''; }
  seg($('chordSeg'), [['top', 'Bovenste noot'], ['bottom', 'Onderste noot']], O.chord, v => { O.chord = v; prepare(); });
  $('swClick').classList.toggle('on', O.click); $('sMet').classList.toggle('on', O.click);
}
[['swClick', 'click']].forEach(([id, k]) => { $(id).onclick = () => { O[k] = !O[k]; renderSetup(); }; });

function showView(v){ $('vA').hidden = v !== 'A'; $('vB').hidden = v !== 'B'; sheet.scrollTop = 0; }
function openSetup(v){ stopAll(); renderSetup(); showView(v || (piece ? 'B' : 'A')); sheet.hidden = false; }
function closeSetup(){
  if (piece){
    const first = piece.measures[0].label, last = piece.measures[piece.measures.length - 1].label;
    let f = parseInt($('mFrom').value, 10), t = parseInt($('mTo').value, 10);
    if (!Number.isFinite(f)) f = first; if (!Number.isFinite(t)) t = last;
    f = Math.max(first, Math.min(last, f)); t = Math.max(f, Math.min(last, t));
    from = f; to = t; prepare();
  }
  sheet.hidden = true; savePiece(); refresh(); scoreEnsure();
}
$('sDone').onclick = closeSetup;
$('mAll').onclick = () => { if (!piece) return; $('mFrom').value = piece.measures[0].label; $('mTo').value = piece.measures[piece.measures.length - 1].label; };
$('demoBtn').onclick = () => { setPiece(demoPiece()); };
const stemOf = n => n.replace(/\.[^.]+$/, '');
function commonPrefix(names){
  if (names.length < 2) return '';
  let p = names[0]; for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
  const m = p.match(/^(.*[\s\-_–—:.])/); const pre = m ? m[1] : '';
  const ok = names.every(n => /[A-Za-zÀ-ÿ]{3,}/.test(n.slice(pre.length)));
  return ok ? pre : '';
}
function mergePieces(list){
  const base = list.reduce((a, b) => b.piece.measures.length > a.piece.measures.length ? b : a).piece;
  const stems = list.filter(x => x.stem).map(x => x.stem);
  const pre = commonPrefix(stems);
  const parts = [];
  list.forEach(x => x.piece.parts.forEach(pt => {
    let name = pt.name;
    if (x.stem && x.piece.parts.length === 1 && list.length > 1){
      const st = x.stem.slice(pre.length).replace(/^[\s\-_–—:.]+|[\s\-_–—:.]+$/g, '');
      name = st || x.stem;
    }
    parts.push({ name, notes: pt.notes.map(n => Object.assign({}, n)) });
  }));
  const measures = base.measures.map(m => ({ i: m.i, label: m.label, b: m.b, len: m.len }));
  const tp = list.find(x => x.piece.hadTempo) || list[0];
  parts.forEach(p => p.notes.forEach(n => { let k = measures.length - 1; while (k > 0 && measures[k].b > n.b + 1e-6) k--; n.meas = k; }));
  const generic = t => !t || /^MIDI-bestand$|^Stuk$|^Spoor/i.test(t);
  const named = list.find(x => !generic(x.piece.title));
  const title = named ? named.piece.title : (pre.replace(/[\s\-_–—:.]+$/, '') || (list[0].stem || 'Stuk'));
  return finishPiece({ title, parts, measures, tempo: tp.piece.tempo.map(t => t.slice()), time: base.time.map(t => t.slice()) });
}
async function loadFiles(files, add, title){
  if (!files || !files.length) return;
  $('sstatus').textContent = 'Bezig met lezen…';
  try {
    const list = [];
    if (add && piece) list.push({ piece, stem: null });
    for (const f of files) list.push({ piece: await parseFile(f), stem: stemOf(f.name) });
    const keepPart = add && piece ? partIdx : 0, keepFrom = from, keepTo = to;
    const merged = list.length === 1 ? list[0].piece : mergePieces(list);
    setPiece(merged);
    if (title){ piece.title = title; renderSetup(); savePiece(); }
    if (piece.xml && window.NKscore) NKscore.saveXml(piece.title, piece.xml);
    if (add && keepPart < merged.parts.length){ partIdx = keepPart; from = keepFrom; to = keepTo; prepare(); renderSetup(); savePiece(); }
  } catch (err){
    const m = err && err.message;
    $('sstatus').textContent = m === 'timewise' ? 'Dit MusicXML-formaat (timewise) wordt niet ondersteund. Exporteer als gewone MusicXML of MIDI.'
      : m === 'nodecomp' ? 'Dit gecomprimeerde bestand kan op dit toestel niet geopend worden. Exporteer als .musicxml (niet gecomprimeerd) of .mid.'
      : m === 'smpte' ? 'Dit MIDI-bestand gebruikt een tijdformaat dat niet ondersteund wordt.'
      : 'Een van de bestanden kon niet gelezen worden. Gebruik MusicXML (.musicxml, .xml, .mxl) of MIDI (.mid).';
  }
}
$('fileIn').onchange = async e => { const f = [...(e.target.files || [])]; await loadFiles(f, false); e.target.value = ''; };
$('fileAdd').onchange = async e => { const f = [...(e.target.files || [])]; await loadFiles(f, true); e.target.value = ''; };
/* ---------- koor (versleutelde stukken) ---------- */
const KK = 'naklank-koor';
let koor = null;   // { id, key, idx }
const koorMsg = t => { $('koorMsg').textContent = t || ''; };
let koorPdfMenu = false;
function renderKoor(){
  $('koorOut').hidden = !!koor; $('koorIn').hidden = !koor;
  if (!koor){ koorPdfMenu = false; return; }
  $('koorNaam').textContent = (koorPdfMenu ? 'PDF’s – ' : '') + (koor.idx.koor || 'Mijn koor');
  const l = $('koorList'); l.innerHTML = '';
  const mk = (cls, txt, fn, css) => { const x = document.createElement('button'); x.type = 'button'; x.className = cls; if (css) x.style.cssText = css; x.innerHTML = txt; x.onclick = fn; l.append(x); return x; };
  const metPdf = koor.idx.stukken.filter(s => s.pdf && s.pdf.length);
  if (koorPdfMenu){
    mk('btn', '‹ Terug naar de stukken', () => { koorPdfMenu = false; renderKoor(); }, 'flex:none;padding:10px 14px;justify-self:start');
    if (!metPdf.length) l.insertAdjacentHTML('beforeend', '<div class="small">Er staan nog geen PDF’s klaar.</div>');
    metPdf.forEach(st => {
      l.insertAdjacentHTML('beforeend', '<div style="font-weight:650;margin-top:8px">' + esc(st.titel) + '</div>');
      st.pdf.forEach(p => mk('kstuk', '<span>' + esc(p.naam) + '</span><span style="color:var(--orange);font-weight:700;font-size:18px">⬇</span>', () => koorPdf([{ pdf: [p] }])));
    });
    const n = metPdf.reduce((a, st) => a + st.pdf.length, 0);
    if (n > 1) mk('go sec', '⬇ Alles in één keer (zip, ' + n + ' PDF’s)', () => koorPdf(metPdf), 'margin-top:8px');
    return;
  }
  if (!koor.idx.stukken.length) l.innerHTML = '<div class="small">Er staan nog geen stukken klaar.</div>';
  koor.idx.stukken.forEach(st => {
    const b = mk('kstuk', '<span><b style="font-size:17px">' + esc(st.titel) + '</b></span><span style="color:var(--orange);font-weight:700;font-size:20px">›</span>', () => koorLoad(st));
  });
  mk('go sec', 'PDF’s', () => { koorPdfMenu = true; renderKoor(); }, 'margin-top:6px');
}
const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++){ let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = u => { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = crcT[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipStore(files){   // files: [{name, data:Uint8Array}] zonder compressie (pdf's zijn al gecomprimeerd)
  const te = new TextEncoder(), parts = [], cen = []; let off = 0;
  for (const f of files){
    const nm = te.encode(f.name), crc = crc32(f.data), h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true); h.setUint32(18, f.data.length, true); h.setUint32(22, f.data.length, true);
    h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), nm, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true);
    c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    cen.push(new Uint8Array(c.buffer), nm);
    off += 30 + nm.length + f.data.length;
  }
  let cl = 0; for (const x of cen) cl += x.length;
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cl, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cen, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
async function koorPdf(stukken){
  const lijst = []; stukken.forEach(s => (s.pdf || []).forEach(p => lijst.push(p)));
  if (!lijst.length) return;
  koorMsg('PDF’s worden klaargemaakt…');
  try {
    const files = [];
    for (const p of lijst){
      const r = await fetch('koren/' + koor.id + '/' + p.id + '.nk');
      if (!r.ok) throw new Error('fetch');
      files.push({ name: p.naam, data: await window.NKkoor.decrypt(koor.key, await r.arrayBuffer()) });
    }
    let blob, naam;
    if (files.length === 1){ blob = new Blob([files[0].data], { type: 'application/pdf' }); naam = files[0].name; }
    else { blob = zipStore(files); naam = (koor.idx.koor || 'Koor').replace(/[^\w\- ]+/g, '') + ' PDFs.zip'; }
    koorMsg('');
    const file = new File([blob], naam, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })){
      try { await navigator.share({ files: [file] }); return; } catch (e){ if (e && e.name === 'AbortError') return; }
    }
    const u = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = u; a.download = naam; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  } catch (e){ koorMsg('De PDF’s konden niet geladen worden. Probeer het opnieuw als je online bent.'); }
}
async function koorUnlock(code, quiet){
  const K = window.NKkoor;
  if (!K || !window.crypto || !crypto.subtle){ koorMsg('Dit toestel kan de koorcode niet gebruiken. Open de app via https.'); return false; }
  if (!quiet) koorMsg('Bezig met openen…');
  let d;
  try { d = await K.derive(code); } catch (e){ koorMsg('Vul een geldige koorcode in.'); return false; }
  let idx = null;
  try {
    const r = await fetch('koren/' + d.id + '/index.nk', { cache: 'no-cache' });
    if (r.ok){ idx = JSON.parse(new TextDecoder().decode(await K.decrypt(d.key, await r.arrayBuffer()))); try { localStorage.setItem(KK + '-idx', JSON.stringify(idx)); } catch(_){} }
    else { koorMsg('Deze koorcode is niet bekend. Controleer de code.'); return false; }
  } catch (e){
    try { const sv = JSON.parse(localStorage.getItem(KK) || '{}'); if (sv.id === d.id) idx = JSON.parse(localStorage.getItem(KK + '-idx')); } catch(_){}
    if (!idx){ koorMsg('Geen verbinding. Probeer het opnieuw als je online bent.'); return false; }
  }
  koor = { id: d.id, key: d.key, idx };
  try { localStorage.setItem(KK, JSON.stringify({ code, id: d.id })); } catch(_){}
  koorMsg(''); renderKoor(); return true;
}
async function koorLoad(st){
  koorMsg('“' + st.titel + '” wordt geladen…');
  try {
    const files = [];
    for (const b of st.bestanden){
      const r = await fetch('koren/' + koor.id + '/' + b.id + '.nk');
      if (!r.ok) throw new Error('fetch');
      files.push(new File([await window.NKkoor.decrypt(koor.key, await r.arrayBuffer())], b.naam));
    }
    await loadFiles(files, false, st.titel);
    if (st.kies && st.kies.length && piece){   // alleen deze stemmen als keuzeknop; de rest staat wel in de mixer
      piece.kies = st.kies.slice();
      const f = partNames().findIndex(n => piece.kies.includes(n));
      if (f >= 0){ partIdx = f; prepare(); }
      renderSetup(); savePiece();
    }
    koorMsg('');
  } catch (e){ koorMsg('Dit stuk kon niet geladen worden. Probeer het opnieuw als je online bent.'); }
}
$('koorGo').onclick = () => koorUnlock($('koorCode').value, false);
$('koorCode').onkeydown = e => { if (e.key === 'Enter') koorUnlock($('koorCode').value, false); };
$('koorUit').onclick = () => { koor = null; koorPdfMenu = false; try { localStorage.removeItem(KK); localStorage.removeItem(KK + '-idx'); } catch(_){} $('koorCode').value = ''; renderKoor(); };
// uitnodigingslink: ...#koor=CODE
(() => {
  const m = /(?:^|[#&])koor=([^&]+)/.exec(location.hash || '');
  if (!m) return;
  try { const code = decodeURIComponent(m[1]); localStorage.setItem(KK, JSON.stringify({ code, id: '' })); } catch(_){}
  try { history.replaceState(null, '', location.pathname + location.search); } catch(_){}
})();
async function koorAuto(){
  if (koor) return;
  try { const sv = JSON.parse(localStorage.getItem(KK) || '{}'); if (sv.code) await koorUnlock(sv.code, true); } catch(_){}
}

function setPiece(p){
  O.volL = {}; O.volS = {};
  piece = p; partIdx = 0; from = p.measures[0].label; to = p.measures[p.measures.length - 1].label;
  prepare(); previewKey = ''; renderSetup(); showView('B'); savePiece();
}

function updateNone(){
  const el = $('snone'); if (!el) return;
  if (!piece || state === 'count' || state === 'sing' || state === 'listen' || state === 'done'){ el.hidden = true; return; }
  const rn = buildRunPreview();
  if (rn.notes.length){ el.hidden = true; return; }
  const last = piece.measures[piece.measures.length - 1].label;
  let nxt = null; for (const n of notes){ if (n.b >= rn.bE - 1e-6 && (!nxt || n.b < nxt.b)) nxt = n; }
  if (!nxt) for (const n of notes){ if (!nxt || n.b < nxt.b) nxt = n; }
  const lab = nxt && piece.measures[nxt.meas] ? piece.measures[nxt.meas].label : null;
  const nmS = partNames()[partIdx];
  const key = nmS + '|' + from + '|' + to + '|' + lab; if (el.dataset.k === key && !el.hidden) return; el.dataset.k = key;
  el.innerHTML = '<div><b>' + esc(nmS) + '</b> zingt niet in maat ' + from + (to !== from ? '–' + to : '') + '.</div>' + (lab != null ? '<button class="btn main" id="snoneGo" style="margin-top:10px">Ga naar maat ' + lab + '</button>' : '');
  el.hidden = false;
  const go = $('snoneGo');
  if (go) go.onclick = () => { const len = Math.max(0, to - from); from = lab; to = Math.min(last, lab + len); prepare(); previewKey = ''; savePiece(); refresh(); };
}
function updateHead(){
  updateNone();
  { const h = $('shint'); if (h) h.hidden = !(piece && state === 'idle' && !run && notes.length && !(window.NKscore && NKscore.active)); }
  const a = $('sheadA'), b = $('sheadB');
  if (!piece){ a.textContent = 'Geen stuk geladen'; b.textContent = ''; return; }
  const names = partNames();
  a.innerHTML = '<b>' + esc(names[partIdx]) + '</b> · maat ' + from + (to !== from ? '–' + to : '') + ' · ' + Math.round(O.speed * 100) + '%';
  if (state === 'done' && sel && sel.status){
    const st = sel.status, lab = piece.measures[sel.meas] ? piece.measures[sel.meas].label : '?';
    const what = wat(st);
    a.innerHTML = 'Maat ' + lab + ' · <b>' + nm(sel.m) + '</b>' + (sel.lyr ? ' “' + esc(sel.lyr.replace(/-$/, '')) + '”' : '') + ': ' + what;
  }
  if (run && run.kind === 'sing'){
    const done = run.notes.filter(n => n.status), ok = done.filter(n => n.status.k === 'ok').length;
    b.textContent = '✓ ' + ok + '/' + run.notes.length;
  } else b.textContent = notes.length + ' noten';
}
const wat = st => st.k === 'ok' ? 'goed' : st.k === 'none' ? 'niet gehoord' : RHY[st.k] ? ({ late: 'te laat begonnen', early: 'te vroeg begonnen', short: 'te kort aangehouden', long: 'te lang aangehouden' })[st.k] + ' (' + Math.abs(st.dt).toFixed(1).replace('.', ',') + ' s)' : (st.k === 'high' ? 'te hoog' : 'te laag') + ' (' + (st.cents > 0 ? '+' : '−') + Math.round(Math.abs(st.cents)) + ' cent)';
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]));

function refresh(){
  { const mb = $('sMet'); if (mb) mb.classList.toggle('on', !!O.click); }
  const running = state === 'count' || state === 'listen' || state === 'sing';
  $('sListenL').textContent = state === 'listen' ? 'Stop' : 'Luister';
  $('sSingL').textContent = state === 'sing' ? 'Klaar' : (state === 'count' ? 'Stop' : 'Zing mee');
  $('sSingI').innerHTML = (state === 'count' || state === 'sing') ? '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>' : '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>';
  $('sListen').disabled = $('sSing').disabled = false;
  updateHead(); scoreSync();
}
$('sListen').onclick = () => { if (state === 'listen') stopAll(); else start('listen'); };
$('sMet').onclick = () => { O.click = !O.click; $('sMet').classList.toggle('on', O.click); const sc = $('swClick'); if (sc) sc.classList.toggle('on', O.click); savePiece(); };
$('sSing').onclick = () => { if (state === 'sing') stopSing(); else if (state === 'count') stopAll(); else start('sing'); };
{ const hd = $('sheadA'); hd.style.pointerEvents = 'auto'; hd.style.cursor = 'pointer'; hd.title = 'Stem, tempo en opties'; hd.addEventListener('click', e => { if (e.target.closest('button')) return; if (piece) openSetup('B'); }); }

const mix = document.createElement('div'); mix.id = 'smix'; mix.className = 'stuk-only'; mix.hidden = true;
stage.append(mix);
function renderMix(){
  if (!piece){ mix.innerHTML = '<div class="hd"><b>Mixer</b><button class="x" id="mixX">Klaar</button></div><div class="small">Laad eerst een stuk.</div>'; $('mixX').onclick = () => { mix.hidden = true; }; return; }
  const kind = O.mixMode === 'S' ? 'sing' : 'listen', map = kind === 'sing' ? O.volS : O.volL, names = partNames();
  const order = [partIdx].concat(names.map((_, i) => i).filter(i => i !== partIdx));
  mix.innerHTML = '<div class="hd"><b>Mixer</b><button class="x" id="mixX">Klaar</button></div><div class="seg" id="mixSeg"></div>';
  const rows = document.createElement('div');
  order.forEach(pi => {
    const key = pi === partIdx ? 'own' : pi, v = Math.round(volOf(kind, pi) * 100);
    const r = document.createElement('div'); r.className = 'mix';
    r.innerHTML = '<div class="nm">' + (pi === partIdx ? '<b>Mijn stem</b> · ' : '') + esc(names[pi]) + '</div><input type="range" min="0" max="100" step="5" value="' + v + '" aria-label="' + esc(names[pi]) + '"><div class="pc">' + v + '%</div>';
    const inp = r.querySelector('input'), pc = r.querySelector('.pc');
    inp.oninput = () => { map[key] = inp.value / 100; pc.textContent = inp.value + '%'; if (run && run.kind === kind) applyMix(); };
    inp.onchange = () => savePiece();
    rows.append(r);
  });
  mix.append(rows);
  const qb = document.createElement('div'); qb.className = 'qb';
  const setOthers = v => { piece.parts.forEach((_, pi) => { if (pi !== partIdx) map[pi] = v; }); renderMix(); if (run && run.kind === kind) applyMix(); savePiece(); };
  [['Andere stemmen uit', 0], ['Andere stemmen zacht', 0.1], ['Andere stemmen gelijk', 0.7]].forEach(([l, v]) => { const b = document.createElement('button'); b.textContent = l; b.onclick = () => setOthers(v); qb.append(b); });
  mix.append(qb);
  const note = document.createElement('div'); note.className = 'small';
  note.textContent = kind === 'sing' ? 'Zo hoor je de stemmen terwijl je meezingt. Gebruik oordopjes, anders hoort de microfoon de stemmen mee en klopt de beoordeling niet.' : 'Zo hoor je de stemmen bij “Luister”.';
  mix.append(note);
  seg($('mixSeg'), [['L', 'Bij luisteren'], ['S', 'Bij meezingen']], O.mixMode, v => { O.mixMode = v; renderMix(); });
  $('mixX').onclick = () => { mix.hidden = true; savePiece(); };
}
$('sMix').onclick = () => { if (!mix.hidden){ mix.hidden = true; return; } if (state === 'count' || state === 'sing') O.mixMode = 'S'; else if (state === 'listen') O.mixMode = 'L'; renderMix(); mix.hidden = false; };

function jumpError(dir){
  if (!run) return;
  const bad = run.notes.filter(n => n.status && n.status.k !== 'ok');
  if (!bad.length) return;
  const cur = (geom ? geom.mnow : run.frozen) ;
  let target = null;
  if (dir > 0){ target = bad.find(n => n.s > cur + 0.25 - 0.0) || null; }
  else { for (let i = bad.length - 1; i >= 0; i--) if (bad[i].s < cur - 0.25){ target = bad[i]; break; } }
  if (!target) return;
  sel = target; pan = target.s + 0.5 - run.frozen;
}

function showResult(){
  const ns = run.notes, tot = ns.length;
  if (!tot){
    const badge0 = $('sbadge'); badge0.className = 'badge neutral'; badge0.textContent = '–'; badge0.style.fontSize = '24px';
    $('stitle').textContent = 'Te kort om te beoordelen'; $('sdetail').textContent = 'Zing iets langer mee, dan krijg je een analyse van je noten.';
    $('sissues').innerHTML = ''; const bt0 = $('sbtns'); bt0.innerHTML = '';
    const b0 = document.createElement('button'); b0.className = 'btn main'; b0.textContent = 'Nog eens'; b0.onclick = () => start('sing'); bt0.append(b0);
    renderRec(); sres.hidden = false; return;
  }
  const ok = ns.filter(n => n.status.k === 'ok').length, pct = tot ? Math.round(100 * ok / tot) : 0;
  const badge = $('sbadge'), t = $('stitle'), d = $('sdetail'), iss = $('sissues'), bt = $('sbtns');
  badge.className = 'badge ' + (pct >= 85 ? 'ok' : (pct >= 50 ? 'neutral' : 'bad'));
  if (pct >= 85) badge.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
  else { badge.textContent = pct + '%'; badge.style.fontSize = '20px'; }
  if (pct >= 85) badge.style.fontSize = '';
  t.textContent = pct >= 90 ? 'Sterk gezongen!' : pct >= 70 ? 'Goed bezig' : pct >= 40 ? 'Nog even oefenen' : 'Probeer het rustiger';
  const nr = ns.filter(n => RHY[n.status.k]).length;
  d.textContent = ok + ' van ' + tot + ' noten goed (' + pct + '%).' + (nr ? ' Bij ' + nr + ' noten klopte de toon, maar het ritme niet.' : '');
  const bad = ns.filter(n => n.status.k !== 'ok');
  const byM = {}; bad.forEach(n => { byM[n.meas] = (byM[n.meas] || 0) + 1; });
  let worst = null, wc = 0; for (const k in byM) if (byM[k] > wc){ wc = byM[k]; worst = +k; }
  iss.innerHTML = '';
  bad.slice(0, 2).forEach(n => {
    const el = document.createElement('div'); el.className = 'issue';
    const lab = piece.measures[n.meas] ? piece.measures[n.meas].label : '?';
    const what = wat(n.status);
    el.textContent = 'Maat ' + lab + ', ' + nm(n.m) + (n.lyr ? ' “' + n.lyr.replace(/-$/, '') + '”' : '') + ': ' + what;
    iss.append(el);
  });
  if (bad.length > 2){ const el = document.createElement('div'); el.className = 'issue'; el.style.color = 'var(--mute)'; el.textContent = '… en ' + (bad.length - 2) + ' meer, gebruik de knoppen hieronder'; iss.append(el); }
  const i0p = labelToIdx(from), i1p = Math.max(i0p, labelToIdx(to));
  renderProgress(iss, measProgress(), i0p, i1p, 24, i => { pan = run.sec(piece.measures[i].b) - 0.4 - run.frozen; sel = null; });
  const nav = document.createElement('div'); nav.id = 'nav';
  nav.innerHTML = '<button id="navP">← Vorige fout</button><button id="navN">Volgende fout →</button>';
  iss.append(nav);
  nav.querySelector('#navP').onclick = () => jumpError(-1); nav.querySelector('#navN').onclick = () => jumpError(1);
  const hint = document.createElement('div'); hint.className = 'small'; hint.textContent = 'Sleep het beeld om terug te kijken. Tik op een noot voor details.'; iss.append(hint);
  bt.innerHTML = '';
  const b1 = document.createElement('button'); b1.className = 'btn'; b1.textContent = 'Nog eens'; b1.onclick = () => start('sing');
  bt.append(b1);
  const bh = document.createElement('button'); bh.className = 'btn'; bh.textContent = 'Resultaten'; bh.onclick = openHist; bt.append(bh);
  if (worst != null && (to > from)){
    const lab = piece.measures[worst].label;
    const b2 = document.createElement('button'); b2.className = 'btn main'; b2.textContent = 'Oefen maat ' + lab;
    b2.onclick = () => { from = to = lab; prepare(); previewKey = ''; savePiece(); start('sing'); };
    bt.append(b2);
  } else if (from !== piece.measures[0].label || to !== piece.measures[piece.measures.length - 1].label){
    const b2 = document.createElement('button'); b2.className = 'btn main'; b2.textContent = 'Hele stuk';
    b2.onclick = () => { from = piece.measures[0].label; to = piece.measures[piece.measures.length - 1].label; prepare(); previewKey = ''; savePiece(); start('sing'); };
    bt.append(b2);
  }
  renderRec(); sres.hidden = false;
}


/* =========================================================
   Eigen opnames: opnemen tijdens Zing mee, kiezen wat je bewaart, delen
   ========================================================= */
let recM = null, recChunks = [], take = null, recGen = 0;
const recMime = () => { try { for (const t of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t; } catch(_){} return ''; };
function recStart(){
  recDiscard();
  try {
    if (!window.MediaRecorder || !C.stream) return;
    const mt = recMime(), gen = ++recGen;
    recChunks = [];
    const m = new MediaRecorder(C.stream, mt ? { mimeType: mt } : undefined);
    m.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
    m.onstop = () => {
      if (gen !== recGen || m._drop){ recChunks = []; return; }
      const blob = new Blob(recChunks, { type: m.mimeType || mt || 'audio/mp4' }); recChunks = [];
      if (!blob.size) return;
      take = { blob, mime: blob.type, url: URL.createObjectURL(blob), ts: Date.now(), from, to, titel: piece ? piece.title : '', stem: partNames()[partIdx] || '', pct: null, saved: false };
      renderRec();
    };
    m.start(); recM = m;
  } catch(e){ recM = null; }
}
function recStop(){
  if (take && take.url && !take.saved){ try { URL.revokeObjectURL(take.url); } catch(_){} }
  take = null;
  if (recM && recM.state !== 'inactive'){ try { recM.stop(); } catch(_){} }
  recM = null;
}
function recDiscard(){
  recGen++;
  if (recM){ recM._drop = true; if (recM.state !== 'inactive'){ try { recM.stop(); } catch(_){} } recM = null; }
  if (take && take.url){ try { URL.revokeObjectURL(take.url); } catch(_){} }
  take = null; recChunks = [];
  const e = document.getElementById('srec'); if (e) e.innerHTML = '';
}
function recName(t){
  const d = new Date(t.ts), rg = t.from === t.to ? 'maat ' + t.from : 'maat ' + t.from + '-' + t.to;
  const ext = /mp4|m4a|aac/.test(t.mime) ? 'm4a' : (/ogg/.test(t.mime) ? 'ogg' : 'webm');
  return (t.titel + ' - ' + t.stem + ' - ' + rg + ' - ' + d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }).replace(':', '.')).replace(/[\\/:*?"<>|]+/g, '') + '.' + ext;
}
async function recShare(t){
  const file = new File([t.blob], recName(t), { type: t.mime });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })){ await navigator.share({ files: [file], title: t.titel }); return; }
  } catch(e){ if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(t.blob); a.download = file.name; document.body.append(a); a.click(); setTimeout(() => { a.remove(); }, 500);
}
// opslag
const odb = () => new Promise((res, rej) => {
  const q = indexedDB.open('naklank-opn', 1);
  q.onupgradeneeded = () => q.result.createObjectStore('opn', { keyPath: 'id', autoIncrement: true });
  q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
});
async function opnAll(){ const d = await odb(); return new Promise((res, rej) => { const r = d.transaction('opn').objectStore('opn').getAll(); r.onsuccess = () => res(r.result.sort((a, b) => b.ts - a.ts)); r.onerror = () => rej(r.error); }); }
async function opnPut(o){ const d = await odb(); return new Promise((res, rej) => { const r = d.transaction('opn', 'readwrite').objectStore('opn').put(o); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function opnDel(id){ const d = await odb(); return new Promise((res, rej) => { const r = d.transaction('opn', 'readwrite').objectStore('opn').delete(id); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }
function renderRec(){
  const el = document.getElementById('srec'); if (!el) return;
  el.innerHTML = '';
  if (!take){ if (recM && recM.state !== 'inactive') el.innerHTML = '<div class="small">Je opname wordt klaargezet…</div>'; return; }
  if (run && run.notes && run.notes.length && take.pct == null){ const ok = run.notes.filter(n => n.status && n.status.k === 'ok').length; take.pct = Math.round(100 * ok / run.notes.length); }
  const box = document.createElement('div'); box.className = 'recbox';
  box.innerHTML = '<div class="small" style="margin:10px 0 4px"><b>Je opname</b></div>';
  const au = document.createElement('audio'); au.controls = true; au.src = take.url; au.style.width = '100%'; au.preload = 'metadata'; box.append(au);
  const row = document.createElement('div'); row.className = 'btns'; row.style.marginTop = '8px';
  const mk = (txt, fn, cls) => { const b = document.createElement('button'); b.className = 'btn' + (cls ? ' ' + cls : ''); b.textContent = txt; b.onclick = fn; row.append(b); return b; };
  if (!take.saved){
    const bs = mk('Bewaar opname', async () => {
      try {
        const o = { ts: take.ts, titel: take.titel, stem: take.stem, from: take.from, to: take.to, pct: take.pct, mime: take.mime, blob: take.blob };
        o.id = await opnPut(o); take.id = o.id; take.saved = true; renderRec();
      } catch(e){ bs.textContent = 'Opslaan lukt niet'; }
    }, 'main');
    mk('Weggooien', () => { recDiscard(); renderRec(); });
  } else {
    const sv = document.createElement('div'); sv.className = 'small'; sv.textContent = 'Bewaard bij “Mijn opnames”.'; box.append(sv);
    mk('Delen', () => recShare(take), 'main');
    mk('Verwijderen', async () => { try { await opnDel(take.id); } catch(_){} recDiscard(); renderRec(); });
  }
  box.append(row); el.append(box);
}
const opnSheet = document.createElement('div'); opnSheet.className = 'sheet stuk-only'; opnSheet.id = 'sopn'; opnSheet.hidden = true; document.body.append(opnSheet);
let opnUrl = null, opnArm = null;
async function openOpn(){
  opnSheet.hidden = false; opnSheet.scrollTop = 0;
  opnSheet.innerHTML = '<div class="wrap"><h1 style="font-size:30px">Mijn opnames</h1><div class="small" id="oSub"></div><div id="oList" style="margin-top:12px"></div><button class="go" id="oTerug" style="margin-top:16px">Terug</button></div>';
  $('oTerug').onclick = () => { opnSheet.hidden = true; if (opnUrl){ try { URL.revokeObjectURL(opnUrl); } catch(_){} opnUrl = null; } const a = opnSheet.querySelector('audio'); if (a) a.pause(); };
  let list = [];
  try { list = await opnAll(); } catch(e){ $('oSub').textContent = 'Opnames zijn op dit apparaat niet beschikbaar.'; return; }
  $('oSub').textContent = list.length ? 'Alleen op dit apparaat bewaard. Tik op Delen om er één door te sturen.' : 'Je hebt nog geen opnames bewaard. Zing mee en kies na afloop “Bewaar opname”.';
  const ol = $('oList');
  list.forEach(o => {
    const d = new Date(o.ts), rg = o.from === o.to ? 'maat ' + o.from : 'maat ' + o.from + '–' + o.to;
    const r = document.createElement('div'); r.className = 'hrow'; r.style.flexWrap = 'wrap'; r.style.gap = '8px';
    r.innerHTML = '<div class="t"><b></b><small></small></div>';
    r.querySelector('b').textContent = o.titel + ' · ' + o.stem;
    r.querySelector('small').textContent = d.toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' · ' + rg + (o.pct != null ? ' · ' + o.pct + '% goed' : '');
    const au = document.createElement('audio'); au.controls = true; au.preload = 'none'; au.style.width = '100%'; au.src = URL.createObjectURL(o.blob);
    au.onplay = () => { opnSheet.querySelectorAll('audio').forEach(x => { if (x !== au) x.pause(); }); };
    const bd = document.createElement('button'); bd.textContent = 'Delen'; bd.onclick = () => recShare(o);
    const bx = document.createElement('button'); bx.textContent = 'Verwijder'; bx.onclick = async () => {
      if (opnArm !== o.id){ opnArm = o.id; bx.textContent = 'Zeker weten?'; setTimeout(() => { if (opnArm === o.id){ opnArm = null; bx.textContent = 'Verwijder'; } }, 3500); return; }
      opnArm = null; try { await opnDel(o.id); } catch(_){} openOpn();
    };
    r.append(bd, bx, au); ol.append(r);
  });
}
$('recBtn').onclick = openOpn;

let drag = null;
cvEl.addEventListener('pointerdown', e => {
  if (!document.body.classList.contains('stuk') || !geom) return;
  const idle = state === 'idle' && !run && piece && notes.length;
  if (state !== 'done' && !idle) return;
  drag = { x: e.clientX, y: e.clientY, pan0: pan, t0: idleT, idle, moved: false };
  try { cvEl.setPointerCapture(e.pointerId); } catch(_){}
});
cvEl.addEventListener('pointermove', e => {
  if (!drag || !geom) return;
  const dx = e.clientX - drag.x;
  if (Math.abs(dx) > 4) drag.moved = true;
  if (!drag.moved) return;
  if (drag.idle){ const rv = buildRunView(); idleT = Math.max(-1, Math.min(rv.dur, (drag.t0 == null ? 0 : drag.t0) - dx / geom.pxps)); }
  else pan = drag.pan0 - dx / geom.pxps;
});
// na het loslaten: kies de maat die het dichtst bij de afspeellijn ligt als beginmaat
function snapToMeasure(){
  const rv = buildRunView(); let best = 0, bd = 1e9;
  piece.measures.forEach((ms, i) => { const d = Math.abs(rv.sec(ms.b) - (idleT + 0.6)); if (d < bd){ bd = d; best = i; } });
  const lab = piece.measures[best].label, last = piece.measures[piece.measures.length - 1].label;
  from = lab; if (to < from) to = last;
  previewKey = ''; savePiece();
  idleT = rv.sec(piece.measures[best].b) - 0.6;
  updateHead(); updateNone(); scoreSync(); if (window.NKscore && NKscore.active) NKscore.scrollToMeasure(best);
}
cvEl.addEventListener('pointerup', e => {
  if (!drag || !geom){ drag = null; return; }
  const d = drag; drag = null;
  if (d.idle){ if (d.moved) snapToMeasure(); return; }
  if (d.moved || !run) return;
  const r = cvEl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, g = geom;
  const m = g.hi - Math.floor(y / g.rh);
  if (x < g.KW){
    const bus = C.ac.createGain(); bus.connect(C.ac.destination); playNote(bus, C.ac.currentTime + 0.03, 1.1, m, 0.4); return;
  }
  const t = g.mnow + (x - g.KW - g.phX) / g.pxps;
  sel = run.notes.find(n => n.m === m && t >= n.s - 0.05 && t <= n.e + 0.05) || null;
});

/* =========================================================
   Opslaan en voortgang per stem
   ========================================================= */
const HK = 'naklank-hist', KC = { ok: 'o', high: 'h', low: 'l', none: 'n', early: 'v', late: 'z', short: 's', long: 'g' }, CK = { o: 'ok', h: 'high', l: 'low', n: 'none', v: 'early', z: 'late', s: 'short', g: 'long' };
const histAll = () => { try { return JSON.parse(localStorage.getItem(HK)) || {}; } catch(e){ return {}; } };
function histPut(h){
  for (let tries = 0; tries < 10; tries++){
    try { localStorage.setItem(HK, JSON.stringify(h)); return true; } catch(e){}
    let done = false;   // vol: eerst oude opnames (lijn) weghalen, dan de oudste pogingen
    for (const k in h){ const arr = h[k]; for (let i = arr.length - 1; i >= 3; i--) if (arr[i].fr){ delete arr[i].fr; done = true; } }
    if (!done) for (const k in h){ if (h[k].length > 1){ h[k].pop(); done = true; break; } }
    if (!done) break;
  }
  return false;
}
const histKey = () => piece.title + ' | ' + partNames()[partIdx];
function saveAttempt(rn){
  if (!piece || !rn.notes.length || rn.notes.every(n => n.status.k === 'none')) return;
  const meas = {}; let ok = 0;
  rn.notes.forEach(n => {
    const l = piece.measures[n.meas] ? piece.measures[n.meas].label : n.meas;
    const m = meas[l] || (meas[l] = [0, 0]); m[1]++; if (n.status.k === 'ok'){ m[0]++; ok++; }
  });
  const fr = []; let lt = -9;
  for (const f of rn.frames){ const t = f.t - rn.t0; if (t - lt < 0.05) continue; lt = t; fr.push(Math.round(t * 100) / 100, f.m == null ? -1 : Math.round(f.m * 10) / 10); }
  const a = { ts: Date.now(), from, to, speed: O.speed, chord: O.chord, ok, tot: rn.notes.length, meas, st: rn.notes.map(n => [KC[n.status.k], RHY[n.status.k] ? Math.round(n.status.dt * 1000) : (n.status.cents != null ? Math.round(n.status.cents) : 0)]), fr };
  const h = histAll(), k = histKey(); (h[k] = h[k] || []).unshift(a); h[k].length = Math.min(h[k].length, 10); histPut(h);
}
// goed / wankel / opnieuw per maat, op basis van de laatste drie keer dat de maat gezongen is
function measProgress(){
  const list = histAll()[histKey()] || [], out = {};
  piece.measures.forEach(ms => {
    const rs = [];
    for (const a of list){ const m = a.meas[ms.label]; if (m && m[1]) rs.push(m[0] / m[1]); if (rs.length >= 3) break; }
    if (!rs.length) return;
    out[ms.label] = rs[0] < 0.5 ? 'opnieuw' : (rs.every(r => r >= 0.85) ? 'goed' : 'wankel');
  });
  return out;
}
function rangeTxt(arr){
  const a = arr.map(Number).sort((x, y) => x - y), parts = [];
  for (let i = 0; i < a.length;){ let j = i; while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++; parts.push(j > i ? a[i] + '–' + a[j] : String(a[i])); i = j + 1; }
  return (a.length > 1 ? 'maten ' : 'maat ') + parts.join(', ');
}
function renderProgress(parent, pg, i0, i1, maxChips, tap){
  const by = { opnieuw: [], wankel: [], goed: [] }, idx = [];
  for (let i = i0; i <= i1; i++){ idx.push(i); const l = piece.measures[i].label, st = pg[l]; if (st) by[st].push(l); }
  if (!by.opnieuw.length && !by.wankel.length && !by.goed.length) return;
  const box = document.createElement('div'); box.className = 'prog';
  if (idx.length <= maxChips){
    const strip = document.createElement('div'); strip.className = 'mstrip';
    idx.forEach(i => { const c = document.createElement('div'); c.className = 'mc ' + (pg[piece.measures[i].label] || ''); c.textContent = piece.measures[i].label; c.onclick = () => tap(i); strip.append(c); });
    box.append(strip);
  }
  [['opnieuw', 'Opnieuw bekijken'], ['wankel', 'Wankel'], ['goed', 'Goed']].forEach(([k, lab]) => {
    if (!by[k].length) return;
    const l = document.createElement('div'); l.className = 'pl ' + k; l.innerHTML = '<i></i><b>' + lab + ':</b> ' + rangeTxt(by[k]); box.append(l);
  });
  parent.append(box);
}

const hist = document.createElement('div'); hist.className = 'sheet stuk-only'; hist.id = 'shist'; hist.hidden = true; document.body.append(hist);
let wisArm = false;
function openHist(){
  if (!piece) return;
  wisArm = false; renderHist(); hist.hidden = false; hist.scrollTop = 0;
}
function renderHist(){
  const list = histAll()[histKey()] || [], pg = measProgress(), n = piece.measures.length;
  hist.innerHTML = '<div class="wrap"><h1 style="font-size:30px">Mijn resultaten</h1><div class="small" id="hSub"></div><div id="hProg"></div><h2>Eerdere keren</h2><div id="hList"></div><button class="go sec" id="hWis" style="margin-top:16px"></button><button class="go" id="hTerug">Terug</button></div>';
  $('hSub').textContent = piece.title + ' · ' + partNames()[partIdx];
  const hp = $('hProg');
  if (!list.length) hp.innerHTML = '<div class="small" style="margin-top:12px">Je hebt bij deze stem nog niets opgeslagen. Zing een stuk mee en het resultaat wordt hier automatisch bewaard.</div>';
  else {
    renderProgress(hp, pg, 0, n - 1, 400, i => { const l = piece.measures[i].label; from = to = l; prepare(); previewKey = ''; savePiece(); hist.hidden = true; sheet.hidden = true; refresh(); });
    const lg = document.createElement('div'); lg.className = 'small'; lg.textContent = 'Grijs = nog niet geoefend. Tik op een maat om alleen die maat te oefenen. Wankel = nog niet steeds goed in de laatste drie keer.'; hp.append(lg);
  }
  const hl = $('hList');
  list.forEach((a, i) => {
    const d = new Date(a.ts), pct = a.tot ? Math.round(100 * a.ok / a.tot) : 0;
    const r = document.createElement('div'); r.className = 'hrow';
    const rg = a.from === a.to ? 'maat ' + a.from : 'maat ' + a.from + '–' + a.to;
    r.innerHTML = '<div class="t"><b>' + pct + '%</b> goed · ' + a.ok + ' van ' + a.tot + ' noten<small>' + d.toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' · ' + rg + ' · tempo ' + Math.round(a.speed * 100) + '%</small></div>';
    if (a.fr){ const b = document.createElement('button'); b.textContent = 'Bekijk'; b.onclick = () => reviewAttempt(a); r.append(b); }
    hl.append(r);
  });
  $('hWis').textContent = wisArm ? 'Zeker weten? Tik nog eens om te wissen' : 'Wis mijn resultaten bij deze stem';
  $('hWis').hidden = !list.length;
  $('hWis').onclick = () => {
    if (!wisArm){ wisArm = true; renderHist(); return; }
    const h = histAll(); delete h[histKey()]; histPut(h); wisArm = false; renderHist();
  };
  $('hTerug').onclick = () => { hist.hidden = true; if (run && state === 'done') showResult(); };
}
function reviewAttempt(a){
  stopAll(); from = a.from; to = a.to; O.speed = a.speed; lastPan = 0; if (a.chord) O.chord = a.chord; prepare(); previewKey = '';
  const rn = buildRun('sing');
  if (rn.notes.length !== a.st.length){ hist.querySelector('#hSub').textContent = 'Deze opname past niet meer bij het stuk (het stuk is veranderd).'; return; }
  rn.t0 = 0;
  rn.notes.forEach((n, i) => { const k = CK[a.st[i][0]] || 'none', c = a.st[i][1]; n.status = RHY[k] ? { k, cents: 0, sung: n.m, dt: c / 1000 } : { k, cents: c, sung: n.m + c / 100 }; });
  for (let i = 0; i + 1 < a.fr.length; i += 2) rn.frames.push({ t: a.fr[i], m: a.fr[i + 1] < 0 ? null : a.fr[i + 1] });
  run = rn; state = 'done'; run.frozen = run.dur + 0.5; pan = 0; sel = null; lastPan = 0;
  savePiece(); hist.hidden = true; sheet.hidden = true; mix.hidden = true;
  showResult(); refresh();
}
$('histBtn').onclick = openHist;
$('vbBack').onclick = () => showView('A');
$('vaCont').onclick = () => showView('B');

/* in- en uitzoomen: knoppen, knijpen met twee vingers, of Ctrl + scrollen */
const ZMIN = 0.3, ZMAX = 4;
function setZoom(z, save){ O.zoom = Math.max(ZMIN, Math.min(ZMAX, z)); if (save) savePiece(); }
$('zIn').onclick = () => setZoom(O.zoom / 1.4, true);
$('zOut').onclick = () => setZoom(O.zoom * 1.4, true);
const pts = new Map(); let pinch = null;
cvEl.addEventListener('pointerdown', e => {
  if (!document.body.classList.contains('stuk')) return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pts.size === 2){ const [a, b] = [...pts.values()]; pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: O.zoom }; drag = null; }
});
cvEl.addEventListener('pointermove', e => {
  if (!pts.has(e.pointerId)) return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pts.size >= 2){ const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y) || 1; setZoom(pinch.z0 * pinch.d0 / d, false); }
});
const pend = e => { pts.delete(e.pointerId); if (pts.size < 2 && pinch){ pinch = null; savePiece(); } };
cvEl.addEventListener('pointerup', pend); cvEl.addEventListener('pointercancel', pend);
cvEl.addEventListener('wheel', e => { if (!document.body.classList.contains('stuk') || !e.ctrlKey) return; e.preventDefault(); setZoom(O.zoom * Math.exp(e.deltaY * 0.01), true); }, { passive: false });

/* =========================================================
   Bladmuziek (partituur.js)
   ========================================================= */
let scoreKey = '', lastFollow = -1, lastPan = 0;
function scoreInit(){
  if (!window.NKscore || scoreInit.done) return; scoreInit.done = true;
  NKscore.init({
    onTap: mi => {
      if (!piece || state === 'count' || state === 'listen' || state === 'sing') return;
      const last = piece.measures[piece.measures.length - 1].label;
      from = piece.measures[mi].label; if (to < from) to = last;
      prepare(); previewKey = ''; savePiece(); updateHead();
      if (state === 'done' && run){ pan = Math.max(-1 - run.frozen, Math.min(0.4, run.sec(piece.measures[mi].b) - 0.5 - run.frozen)); }
    },
    onHold: mi => {
      if (!piece || state === 'count' || state === 'listen' || state === 'sing') return;
      const lab = piece.measures[mi].label; to = Math.max(lab, from);
      prepare(); previewKey = ''; savePiece(); updateHead();
    },
    onNote: idx => { if (state === 'done' && run && run.notes[idx]){ sel = run.notes[idx]; NKscore.select(idx); pan = sel.s + 0.5 - run.frozen; } },
    onRendered: () => { scoreSync(); if (run) { run._mk = 0; scoreFlush(); } }
  });
}
function scoreEnsure(){
  if (!window.NKscore || !piece || !piece.xml){ if (window.NKscore) NKscore.hide(); return; }
  scoreInit();
  const names = partNames();
  NKscore.show(piece.xml, piece.title, (piece.parts[partIdx].xi != null ? piece.parts[partIdx].xi : partIdx)).then(ok => { if (ok) scoreSync(); });
}
function scoreSync(){
  if (!window.NKscore || !NKscore.active || !piece) return;
  const a = labelToIdx(from), b = Math.max(a, labelToIdx(to));
  const pg = measProgress();
  NKscore.setSel(a, b); NKscore.setStatus(piece.measures.map(ms => pg[ms.label]));
  scoreSync.k = piece.title + partIdx;
}
function scoreFlush(){
  if (!window.NKscore || !NKscore.active || !run || run.kind !== 'sing') return;
  if (run._mk == null) run._mk = 0;
  while (run._mk < run.notes.length && run.notes[run._mk].status){
    const n = run.notes[run._mk]; const ms = piece.measures[n.meas];
    if (ms) NKscore.mark(n.meas, n.b - ms.b, n.m, n.status.k, run._mk);
    run._mk++;
  }
}
function beatPos(rn, t){
  for (let i = rn.i0; i <= rn.i1; i++){
    const ms = piece.measures[i], s0 = rn.sec(ms.b), s1 = rn.sec(ms.b + ms.len);
    if (t >= s0 && t < s1) return { mi: i, off: (t - s0) / Math.max(1e-6, s1 - s0) * ms.len };
  }
  return null;
}
function scoreFrame(mnow){
  if (!NKscore.active) return;
  if (run && (state === 'sing' || state === 'listen')){
    const p = beatPos(run, mnow);
    if (p){ NKscore.playhead(p.mi, p.off); if (p.mi !== lastFollow){ lastFollow = p.mi; NKscore.follow(p.mi); } } else NKscore.hidePlayhead();
    scoreFlush();
  } else if (run && state === 'done'){
    scoreFlush();
    if (pan !== lastPan){ lastPan = pan; const p = beatPos(run, mnow); if (p){ NKscore.playhead(p.mi, p.off); if (p.mi !== lastFollow){ lastFollow = p.mi; NKscore.follow(p.mi); } } }
  } else { NKscore.hidePlayhead(); lastFollow = -1; }
}

window.NKstuk = {
  frame,
  enter(){ medBuf = []; if (!piece && restore()) prepare(); if (piece && !piece.xml && window.NKscore) NKscore.loadXml(piece.title).then(x => { if (x && piece && !piece.xml) piece.xml = x; }); koorAuto().then(() => { if (!sheet.hidden) renderSetup(); }); openSetup('A'); },
  leave(){ stopAll(); sheet.hidden = true; hist.hidden = true; opnSheet.hidden = true; if (window.NKscore) NKscore.hide(); },
  _t: { parseXML, parseMidi, parseFile, reduce, evalNote, get O(){ return O; }, LAT, demoPiece, finishPiece, get state(){ return state; }, get run(){ return run; }, get notes(){ return notes; }, setPiece, get piece(){ return piece; } }
};
})();
