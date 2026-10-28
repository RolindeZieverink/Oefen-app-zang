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
    parts.push({ name: (names[id] || '').trim() || ('Stem ' + (pi + 1)), notes });
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
  while (b < endB + 1e-6 && i < 2000){
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
    return parseXML(await zipText(z[root]));
  }
  return parseXML(new TextDecoder('utf-8').decode(new Uint8Array(ab)).replace(/^﻿/, ''));
}

/* =========================================================
   Stuk, stem, tijdlijn
   ========================================================= */
const DEF = { chord:'top', speed:1, guide:'uit', others:false, hide:false, click:false };
let O = loadO();
let piece = null, partIdx = 0, from = 1, to = 1, notes = [];
let state = 'idle';     // idle | count | listen | sing | done
let run = null;

function loadO(){ try { return Object.assign({}, DEF, (JSON.parse(localStorage.getItem(LS) || '{}').o) || {}); } catch(e){ return Object.assign({}, DEF); } }
function savePiece(){
  try {
    const pcs = piece ? { title: piece.title,
      parts: piece.parts.map(p => ({ name: p.name, notes: p.notes.map(n => [+n.b.toFixed(4), +n.d.toFixed(4), n.m, n.meas, n.lyr]) })),
      measures: piece.measures.map(m => [m.i, m.label, +m.b.toFixed(4), +m.len.toFixed(4)]), tempo: piece.tempo, time: piece.time } : null;
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
  notes = piece ? reduce(piece.parts[partIdx].notes) : [];
}
function secOf(b){
  const t = piece.tmap; let k = t.length - 1; while (k > 0 && t[k].b > b + 1e-9) k--;
  return t[k].s + (b - t[k].b) * 60 / t[k].bpm;
}
function bpmAt(b){ const t = piece.tmap; let k = t.length - 1; while (k > 0 && t[k].b > b + 1e-9) k--; return t[k].bpm; }
function sigAt(mi){ let r = piece.time[0]; for (const t of piece.time) if (t[0] <= mi) r = t; return r; }

function buildRun(kind){
  const i0 = labelToIdx(from), i1 = Math.max(i0, labelToIdx(to));
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
function playNote(bus, t, d, m, vol){
  const ac = C.ac, f = mtof(m), g = ac.createGain(); g.connect(bus);
  const end = t + Math.max(0.06, d - 0.03);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.03);
  g.gain.setValueAtTime(vol, Math.max(t + 0.03, end - 0.06)); g.gain.linearRampToValueAtTime(0, end);
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
function startAudio(rn){
  const ac = C.ac, bus = ac.createGain(); bus.connect(ac.destination); rn.bus = bus;
  const ev = [];
  if (rn.kind === 'sing'){
    for (let k = 0; k < rn.nPulse; k++) ev.push({ t: rn.cs + k * rn.pulse, click: true, accent: k === 0 });
    if (O.click) for (let t = 0, k = 0; ; k++){
      const tt = rn.t0 + k * rn.pulse; if (tt - rn.t0 > rn.dur) break; ev.push({ t: tt, click: true, accent: false });
    }
    if (O.guide !== 'uit'){
      const vol = O.guide === 'luid' ? 0.3 : 0.12;
      for (const n of rn.notes) ev.push({ t: rn.t0 + n.s, d: n.e - n.s, m: n.m, vol });
    }
  } else {
    for (const n of rn.notes) ev.push({ t: rn.t0 + n.s, d: n.e - n.s, m: n.m, vol: 0.34 });
    if (O.others){
      piece.parts.forEach((p, pi) => {
        if (pi === partIdx) return;
        for (const n of reduce(p.notes)){
          if (n.b < rn.bS - 1e-6 || n.b >= rn.bE - 1e-6) continue;
          ev.push({ t: rn.t0 + rn.sec(n.b), d: rn.sec(Math.min(n.b + n.d, rn.bE)) - rn.sec(n.b), m: n.m, vol: 0.09 });
        }
      });
    }
  }
  ev.sort((a, b) => a.t - b.t);
  let i = 0;
  const tick = () => {
    const lim = ac.currentTime + 0.7;
    while (i < ev.length && ev[i].t < lim){
      const e = ev[i++];
      if (e.t < ac.currentTime - 0.05) continue;
      if (e.click) click(bus, e.t, e.accent); else playNote(bus, e.t, e.d, e.m, e.vol);
    }
    if (i >= ev.length) { clearInterval(rn.timer); rn.timer = null; }
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
function evalNote(rn, n){
  const dur = n.e - n.s, skip = Math.min(0.3, dur * 0.35);
  const a = rn.t0 + n.s + skip + LAT, b = rn.t0 + n.e + LAT - 0.03;
  let tot = 0; const v = [];
  for (const f of rn.frames){ if (f.t < a) continue; if (f.t > b) break; tot++; if (f.m != null) v.push(f.m); }
  if (tot < 2 || v.length < 2 || v.length < 0.3 * tot) return { k: 'none' };
  const med = median(v); let dev = med - n.m;
  if (C.S.octave) dev = ((dev + 6) % 12 + 12) % 12 - 6;
  const cents = dev * 100, tol = C.S.tol * (dur < 0.25 ? 1.6 : 1);
  return { k: Math.abs(cents) <= tol ? 'ok' : (cents > 0 ? 'high' : 'low'), cents, sung: med };
}
function scoreAll(rn, final){
  const now = C.ac.currentTime;
  for (const n of rn.notes){
    if (n.status) continue;
    if (!final && now < rn.t0 + n.e + LAT + 0.05) break;
    n.status = evalNote(rn, n);
  }
}

/* =========================================================
   Bediening
   ========================================================= */
function stopAll(){
  stopAudio(run); run = null; state = 'idle'; sres.hidden = true; refresh();
}
async function start(kind){
  if (!piece || !notes.length){ openSetup(); return; }
  if (!C.ac) return;
  stopAudio(run); sres.hidden = true;
  try { await C.ac.resume(); } catch(e){}
  const rn = buildRun(kind), now = C.ac.currentTime;
  if (kind === 'sing'){ rn.cs = now + 0.25; rn.t0 = rn.cs + rn.nPulse * rn.pulse; state = 'count'; }
  else { rn.t0 = now + 0.35; state = 'listen'; }
  run = rn; startAudio(rn); refresh();
}
function finish(){
  if (!run) return;
  if (run.kind === 'sing'){
    scoreAll(run, true); run.frozen = run.dur + 0.5; state = 'done'; showResult();
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
    if (state === 'count' && now >= run.t0) state = 'sing';
    if (state === 'sing' && C.analyser){ C.analyser.getFloatTimeDomainData(C.buf); sample(now); scoreAll(run, false); }
    if ((state === 'sing' || state === 'listen') && now - run.t0 > run.dur + (run.kind === 'sing' ? 0.9 : 0.4)) finish();
  }
  const mnow = !run ? -0.6 : (state === 'done' ? run.frozen : now - run.t0);

  // toonbereik van deze stem
  let lo = 55, hi = 76;
  if (notes.length){ lo = Math.min(...notes.map(n => n.m)) - 3; hi = Math.max(...notes.map(n => n.m)) + 3; }
  while (hi - lo < 13){ hi++; if (hi - lo < 13) lo--; }
  const n_ = hi - lo + 1, KW = Math.max(64, Math.min(84, W * 0.2)), gw = W - KW, rh = H / n_;
  const pxps = gw / WINDOW, phX = gw * PLAYHEAD;
  const rowY = m => (hi - m) * rh;

  ctx.save(); ctx.translate(KW, 0);
  for (let m = lo; m <= hi; m++){
    ctx.fillStyle = isBlack(m) ? '#202328' : '#2a2d33'; ctx.fillRect(0, rowY(m), gw, rh + .5);
    const pc = ((m % 12) + 12) % 12;
    ctx.fillStyle = (pc === 0 || pc === 5) ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.04)'; ctx.fillRect(0, rowY(m) + rh - .5, gw, 1);
  }

  // maatstrepen
  if (piece && notes.length){
    const rn = run || buildRunPreview();
    ctx.font = '600 11px -apple-system,sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (let i = rn.i0; i <= rn.i1; i++){
      const ms = piece.measures[i], x = phX + (rn.sec(ms.b) - mnow) * pxps;
      if (x < -40 || x > gw + 4) continue;
      ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fillRect(x, 0, 1, H);
      ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.fillText(String(ms.label), x + 4, 4);
    }
    // doelnoten
    const hideTargets = O.hide && state === 'sing';
    const bh = Math.max(6, rh * 0.78);
    let activeM = null;
    for (const n of rn.notes){
      const x0 = phX + (n.s - mnow) * pxps, x1 = phX + (n.e - mnow) * pxps;
      if (x1 < -4 || x0 > gw) continue;
      const active = mnow >= n.s && mnow < n.e; if (active) activeM = n.m;
      const st = n.status;
      if (hideTargets && !st) continue;
      let fill = active ? 'rgba(60,207,122,.85)' : 'rgba(60,207,122,.5)';
      if (st){ fill = st.k === 'ok' ? '#3ccf7a' : st.k === 'none' ? '#6b7080' : '#ff6b5e'; }
      const y = rowY(n.m) + (rh - bh) / 2, w = Math.max(3, x1 - x0 - 1.5);
      ctx.fillStyle = fill;
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x0, y, w, bh, 3); else ctx.rect(x0, y, w, bh); ctx.fill();
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
        if (f.m == null){ pen = false; continue; }
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
.stp{display:flex;gap:10px;align-items:center}
.stp input{width:84px;padding:11px 8px;border-radius:10px;border:1px solid var(--line);background:#2b2f37;color:var(--ink);font:inherit;text-align:center}
.stp span{color:var(--mute)}
.small{font-size:13px;color:var(--mute);margin-top:6px}
.issue{font-size:13px;color:#d7dae5;margin-top:4px}
`;
document.head.append(css);

const stage = $('stage'), app = $('app');
const head = document.createElement('div'); head.id = 'shead'; head.className = 'stuk-only';
head.innerHTML = '<div class="a" id="sheadA"></div><div class="b" id="sheadB"></div>'; stage.append(head);

const sres = document.createElement('div'); sres.id = 'sres'; sres.className = 'stuk-only'; sres.hidden = true;
sres.innerHTML = '<div class="top"><div class="badge" id="sbadge"></div><div style="min-width:0"><div id="stitle"></div><div id="sdetail"></div></div></div><div id="sissues"></div><div class="btns" id="sbtns"></div>';
app.insertBefore(sres, $('bar'));

const sbar = document.createElement('div'); sbar.id = 'sbar'; sbar.className = 'stuk-only';
sbar.innerHTML = `
<div class="col"><button id="sListen" aria-label="Luister"><svg viewBox="0 0 24 24"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13"/></svg></button><span class="lbl" id="sListenL">Luister</span></div>
<div class="col"><button id="sSing" class="big" aria-label="Zing mee"><svg viewBox="0 0 24 24" id="sSingI"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg></button><span class="lbl" id="sSingL">Zing mee</span></div>
<div class="col"><button id="sSet" aria-label="Stuk en opties"><svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg></button><span class="lbl">Stuk</span></div>`;
app.append(sbar);

const sheet = document.createElement('div'); sheet.className = 'sheet stuk-only'; sheet.id = 'ssetup'; sheet.hidden = true;
sheet.innerHTML = `<div class="wrap">
<h1 style="font-size:32px">Stuk oefenen</h1>
<h2>Bestand</h2>
<label class="go sec" id="fileLbl" style="margin-top:0">Kies MusicXML of MIDI<input id="fileIn" type="file" style="display:none"></label>
<button class="go sec" id="demoBtn" style="margin-top:10px">Voorbeeldmelodie laden</button>
<div id="sstatus"></div>
<div id="partWrap"><h2>Stem</h2><div class="seg" id="partSeg"></div></div>
<h2>Maten</h2>
<div class="stp"><input id="mFrom" type="number" inputmode="numeric" min="1"><span>tot en met</span><input id="mTo" type="number" inputmode="numeric" min="1"><button class="btn" id="mAll" style="flex:none;padding:11px 14px">Alles</button></div>
<div class="small" id="mHint"></div>
<h2>Tempo</h2><div class="seg" id="spdSeg"></div>
<h2>Bij gedeelde stemmen</h2><div class="seg" id="chordSeg"></div>
<div class="small">Heeft een stem op één moment twee noten, dan oefen je de bovenste of onderste.</div>
<h2>Voorbeeld horen tijdens het zingen</h2><div class="seg" id="guideSeg"></div>
<div class="small">Gebruik hiervoor oordopjes. Anders hoort de microfoon het voorbeeld mee.</div>
<h2>Opties</h2>
<div class="row"><div>Bij “Luister” ook de andere stemmen<small>Zacht, zodat je de harmonie hoort.</small></div><button class="sw" id="swOthers" aria-label="Andere stemmen"></button></div>
<div class="row"><div>Noten verbergen tijdens het zingen<small>Je ziet de noten pas nadat je ze gezongen hebt.</small></div><button class="sw" id="swHide" aria-label="Noten verbergen"></button></div>
<div class="row"><div>Klik tijdens het zingen</div><button class="sw" id="swClick" aria-label="Klik"></button></div>
<button class="go" id="sDone">Klaar</button>
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
  $('sstatus').textContent = piece ? piece.title + ' · ' + piece.parts.length + (piece.parts.length === 1 ? ' stem' : ' stemmen') + ' · ' + fmtLen() + ' maten' : 'Nog geen stuk geladen.';
  $('partWrap').hidden = !piece;
  if (piece){
    const names = partNames();
    seg($('partSeg'), names.map((n, i) => [i, n]), partIdx, v => { partIdx = v; prepare(); });
    const first = piece.measures[0].label, last = piece.measures[piece.measures.length - 1].label;
    $('mFrom').value = from; $('mTo').value = to;
    $('mHint').textContent = 'Maat ' + first + ' tot en met ' + last + ' beschikbaar.';
  }
  seg($('spdSeg'), [[.5, '50%'], [.7, '70%'], [.85, '85%'], [1, '100%']], O.speed, v => { O.speed = v; });
  seg($('chordSeg'), [['top', 'Bovenste noot'], ['bottom', 'Onderste noot']], O.chord, v => { O.chord = v; prepare(); });
  seg($('guideSeg'), [['uit', 'Uit'], ['zacht', 'Zacht'], ['luid', 'Luid']], O.guide, v => { O.guide = v; });
  $('swOthers').classList.toggle('on', O.others); $('swHide').classList.toggle('on', O.hide); $('swClick').classList.toggle('on', O.click);
}
[['swOthers', 'others'], ['swHide', 'hide'], ['swClick', 'click']].forEach(([id, k]) => { $(id).onclick = () => { O[k] = !O[k]; renderSetup(); }; });

function openSetup(){ stopAll(); renderSetup(); sheet.hidden = false; }
function closeSetup(){
  if (piece){
    const first = piece.measures[0].label, last = piece.measures[piece.measures.length - 1].label;
    let f = parseInt($('mFrom').value, 10), t = parseInt($('mTo').value, 10);
    if (!Number.isFinite(f)) f = first; if (!Number.isFinite(t)) t = last;
    f = Math.max(first, Math.min(last, f)); t = Math.max(f, Math.min(last, t));
    from = f; to = t; prepare();
  }
  sheet.hidden = true; savePiece(); refresh();
}
$('sDone').onclick = closeSetup;
$('mAll').onclick = () => { if (!piece) return; $('mFrom').value = piece.measures[0].label; $('mTo').value = piece.measures[piece.measures.length - 1].label; };
$('demoBtn').onclick = () => { setPiece(demoPiece()); };
$('fileIn').onchange = async e => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  $('sstatus').textContent = 'Bezig met lezen…';
  try { setPiece(await parseFile(f)); }
  catch (err){
    const m = err && err.message;
    $('sstatus').textContent = m === 'timewise' ? 'Dit MusicXML-formaat (timewise) wordt niet ondersteund. Exporteer als gewone MusicXML of MIDI.'
      : m === 'nodecomp' ? 'Dit gecomprimeerde bestand kan op dit toestel niet geopend worden. Exporteer als .musicxml (niet gecomprimeerd) of .mid.'
      : m === 'smpte' ? 'Dit MIDI-bestand gebruikt een tijdformaat dat niet ondersteund wordt.'
      : 'Dit bestand kon niet gelezen worden. Gebruik MusicXML (.musicxml, .xml, .mxl) of MIDI (.mid).';
  }
  e.target.value = '';
};
function setPiece(p){
  piece = p; partIdx = 0; from = p.measures[0].label; to = p.measures[p.measures.length - 1].label;
  prepare(); previewKey = ''; renderSetup(); savePiece();
}

function updateHead(){
  const a = $('sheadA'), b = $('sheadB');
  if (!piece){ a.textContent = 'Geen stuk geladen'; b.textContent = ''; return; }
  const names = partNames();
  a.innerHTML = '<b>' + esc(names[partIdx]) + '</b> · maat ' + from + (to !== from ? '–' + to : '') + ' · ' + Math.round(O.speed * 100) + '%';
  if (run && run.kind === 'sing'){
    const done = run.notes.filter(n => n.status), ok = done.filter(n => n.status.k === 'ok').length;
    b.textContent = '✓ ' + ok + '/' + run.notes.length;
  } else b.textContent = notes.length + ' noten';
}
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]));

function refresh(){
  const running = state === 'count' || state === 'listen' || state === 'sing';
  $('sListenL').textContent = state === 'listen' ? 'Stop' : 'Luister';
  $('sSingL').textContent = (state === 'count' || state === 'sing') ? 'Stop' : 'Zing mee';
  $('sSingI').innerHTML = (state === 'count' || state === 'sing') ? '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>' : '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>';
  $('sListen').disabled = $('sSing').disabled = false;
  updateHead();
}
$('sListen').onclick = () => { if (state === 'listen') stopAll(); else start('listen'); };
$('sSing').onclick = () => { if (state === 'count' || state === 'sing') stopAll(); else start('sing'); };
$('sSet').onclick = openSetup;

function showResult(){
  const ns = run.notes, tot = ns.length;
  const ok = ns.filter(n => n.status.k === 'ok').length, pct = tot ? Math.round(100 * ok / tot) : 0;
  const badge = $('sbadge'), t = $('stitle'), d = $('sdetail'), iss = $('sissues'), bt = $('sbtns');
  badge.className = 'badge ' + (pct >= 85 ? 'ok' : (pct >= 50 ? 'neutral' : 'bad'));
  if (pct >= 85) badge.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
  else { badge.textContent = pct + '%'; badge.style.fontSize = '20px'; }
  if (pct >= 85) badge.style.fontSize = '';
  t.textContent = pct >= 90 ? 'Sterk gezongen!' : pct >= 70 ? 'Goed bezig' : pct >= 40 ? 'Nog even oefenen' : 'Probeer het rustiger';
  d.textContent = ok + ' van ' + tot + ' noten goed (' + pct + '%).';
  const bad = ns.filter(n => n.status.k !== 'ok');
  const byM = {}; bad.forEach(n => { byM[n.meas] = (byM[n.meas] || 0) + 1; });
  let worst = null, wc = 0; for (const k in byM) if (byM[k] > wc){ wc = byM[k]; worst = +k; }
  iss.innerHTML = '';
  bad.slice(0, 5).forEach(n => {
    const el = document.createElement('div'); el.className = 'issue';
    const lab = piece.measures[n.meas] ? piece.measures[n.meas].label : '?';
    const what = n.status.k === 'none' ? 'niet gehoord' : (n.status.k === 'high' ? 'te hoog' : 'te laag') + ' (' + (n.status.cents > 0 ? '+' : '−') + Math.round(Math.abs(n.status.cents)) + ' cent)';
    el.textContent = 'Maat ' + lab + ', ' + nm(n.m) + (n.lyr ? ' “' + n.lyr.replace(/-$/, '') + '”' : '') + ': ' + what;
    iss.append(el);
  });
  if (bad.length > 5){ const el = document.createElement('div'); el.className = 'issue'; el.style.color = 'var(--mute)'; el.textContent = '… en ' + (bad.length - 5) + ' meer'; iss.append(el); }
  bt.innerHTML = '';
  const b1 = document.createElement('button'); b1.className = 'btn'; b1.textContent = 'Nog eens'; b1.onclick = () => start('sing');
  bt.append(b1);
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
  sres.hidden = false;
}

window.NKstuk = {
  frame,
  enter(){ medBuf = []; if (!piece && restore()) prepare(); if (!piece) openSetup(); else { prepare(); refresh(); } },
  leave(){ stopAll(); sheet.hidden = true; },
  _t: { parseXML, parseMidi, parseFile, reduce, evalNote, demoPiece, finishPiece, get state(){ return state; }, get run(){ return run; }, get notes(){ return notes; }, setPiece, get piece(){ return piece; } }
};
})();
