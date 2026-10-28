/* Naklank: bladmuziek tonen (OpenSheetMusicDisplay), met beginpunt kiezen, meelopende lijn en kleuren voor feedback */
(function(){
'use strict';
const $ = id => document.getElementById(id);
const LSZ = 'naklank-bladzoom', LSH = 'naklank-bladhoogte', LSHINT = 'naklank-bladhint';
const HEIGHTS = ['24%', '44%', '68%'];
let osmd = null, loadedKey = '', U = 6, dom = null, M = [], natW = 0, natH = 0, marks = [], rendering = false, want = null, cb = {};
let zlevel = 0, hlevel = 1;
try { zlevel = parseInt(localStorage.getItem(LSZ), 10) || 0; hlevel = Math.min(2, Math.max(0, parseInt(localStorage.getItem(LSH) || '1', 10))); } catch(e){}

function build(){
  const app = $('app'), stage = $('stage');
  const pane = document.createElement('div'); pane.id = 'spart'; pane.className = 'stuk-only'; pane.hidden = true;
  pane.innerHTML =
    '<div id="spscroll"><div id="spwrap"><div id="spsvg"></div><div id="spov"></div></div></div>' +
    '<div id="spload" hidden>Bladmuziek wordt geladen…</div>' +
    '<div id="spctl"><button id="spA2" aria-label="Kleiner">A−</button><button id="spA1" aria-label="Groter">A+</button><button id="spH" aria-label="Hoogte" title="Groter of kleiner venster">↕</button></div>' +
    '<div id="sphint">Tik op een maat om daar te beginnen · houd ingedrukt voor het eindpunt</div>';
  app.insertBefore(pane, stage);
  const css = document.createElement('style');
  css.textContent = `
body:not(.stuk) #spart{display:none!important}
#spart{position:relative;flex:0 0 ${HEIGHTS[hlevel]};min-height:150px;background:#fbfaf6;border-bottom:2px solid #2a2d33;overflow:hidden}
#spart[hidden]{display:none}
#spscroll{position:absolute;inset:0;overflow:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;overscroll-behavior:contain}
#spwrap{position:relative}
#spsvg svg{display:block}
#spov{position:absolute;left:0;top:0;pointer-events:none}
#spov div{position:absolute}
#spov .dim{background:rgba(251,250,246,.72)}
#spov .st{mix-blend-mode:multiply;border-radius:4px}
#spov .st.goed{background:rgba(60,207,122,.28)}#spov .st.wankel{background:rgba(232,137,12,.30)}#spov .st.opnieuw{background:rgba(255,107,94,.30)}
#spov .flag{background:#e8890c;color:#1c1105;font:700 11px/1 -apple-system,sans-serif;padding:4px 7px;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.3)}
#spov .edge{background:#e8890c;width:3px;border-radius:2px}
#spov .mk{width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;mix-blend-mode:multiply}
#spov .mk.ok{background:rgba(40,190,100,.55)}#spov .mk.high,#spov .mk.low{background:rgba(255,80,70,.6)}#spov .mk.none{background:rgba(120,125,140,.5)}
#spov .mk.sel{outline:2px solid #1c1105}
#spov .ph{width:2px;background:#e8890c;box-shadow:0 0 0 1px rgba(232,137,12,.35);display:none}
#spload{position:absolute;inset:0;display:grid;place-items:center;background:rgba(251,250,246,.9);color:#444;font-size:15px;z-index:3}
#spload[hidden]{display:none}
#spctl{position:absolute;right:8px;top:8px;display:flex;gap:6px;z-index:2}
#spctl button{min-width:38px;height:34px;padding:0 8px;border-radius:10px;background:rgba(28,31,36,.82);color:#fff;font-weight:700;font-size:14px}
#sphint{position:absolute;left:10px;right:10px;bottom:8px;text-align:center;font-size:12px;color:#fff;background:rgba(28,31,36,.78);border-radius:999px;padding:6px 10px;pointer-events:none;z-index:2}
#sphint[hidden]{display:none}
body.hassheet #sissues .issue,body.hassheet #sissues .small{display:none}
`;
  document.head.append(css);
  dom = { pane, sc: $('spscroll'), wrap: $('spwrap'), svg: $('spsvg'), ov: $('spov'), load: $('spload'), hint: $('sphint') };
  try { if (localStorage.getItem(LSHINT)) dom.hint.hidden = true; } catch(e){}
  $('spA1').onclick = () => zoomStep(1); $('spA2').onclick = () => zoomStep(-1);
  $('spH').onclick = () => { hlevel = (hlevel + 1) % 3; try { localStorage.setItem(LSH, hlevel); } catch(e){} dom.pane.style.flexBasis = HEIGHTS[hlevel]; };
  // tikken en ingedrukt houden
  let down = null;
  dom.sc.addEventListener('pointerdown', e => {
    down = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false, held: false };
    down.timer = setTimeout(() => { if (down && !down.moved){ down.held = true; const h = hit(e.clientX, e.clientY); if (h.mi != null && cb.onHold){ try { navigator.vibrate && navigator.vibrate(15); } catch(_){} cb.onHold(h.mi); } } }, 520);
  });
  dom.sc.addEventListener('pointermove', e => { if (down && (Math.abs(e.clientX - down.x) > 8 || Math.abs(e.clientY - down.y) > 8)){ down.moved = true; clearTimeout(down.timer); } });
  const up = e => {
    if (!down) return; const d = down; down = null; clearTimeout(d.timer);
    if (d.moved || d.held || e.type === 'pointercancel') return;
    const h = hit(e.clientX, e.clientY);
    if (h.note != null && cb.onNote){ cb.onNote(h.note); return; }
    if (h.mi != null && cb.onTap){ try { localStorage.setItem(LSHINT, '1'); } catch(_){} dom.hint.hidden = true; cb.onTap(h.mi); }
  };
  dom.sc.addEventListener('pointerup', up); dom.sc.addEventListener('pointercancel', up);
  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (want && dom.pane.offsetWidth && Math.abs(dom.pane.offsetWidth - natW) > 40) show(want.xml, want.key, want.inst, true); }, 400); });
}

function baseZoom(){ const w = dom.pane.clientWidth || 390; return Math.max(0.5, Math.min(1.1, w / 640)); }
function curZoom(){ return baseZoom() * Math.pow(1.25, zlevel); }
function zoomStep(d){
  const nz = Math.max(-3, Math.min(4, zlevel + d)); if (nz === zlevel) return;
  zlevel = nz; try { localStorage.setItem(LSZ, zlevel); } catch(_){}
  if (want) show(want.xml, want.key, want.inst, true);
}

function hit(cx, cy){
  const r = dom.sc.getBoundingClientRect(), x = cx - r.left + dom.sc.scrollLeft, y = cy - r.top + dom.sc.scrollTop;
  let note = null, bd = 16;
  for (const m of marks){ const d = Math.hypot(m.x - x, m.y - y); if (d < bd){ bd = d; note = m.idx; } }
  let mi = null, best = 1e9;
  M.forEach((m, i) => {
    const dx = x < m.x ? m.x - x : (x > m.x + m.w ? x - m.x - m.w : 0);
    const dy = y < m.y - 20 ? m.y - 20 - y : (y > m.y + m.h + 6 ? y - m.y - m.h - 6 : 0);
    const d = dx + dy * 3; if (d < best){ best = d; mi = i; }
  });
  if (best > 60) mi = null;
  return { mi, note };
}

function lib(){ return new Promise((res, rej) => { if (typeof opensheetmusicdisplay !== 'undefined') return res(); const sc = document.createElement('script'); sc.src = 'lib/osmd.min.js'; sc.onload = res; sc.onerror = rej; document.head.append(sc); }); }
function tick(){ return new Promise(r => requestAnimationFrame(() => setTimeout(r, 20))); }

/* xml tonen voor één stem (instrument-nummer) */
async function show(xml, key, inst, force){
  if (!dom) build();
  want = { xml, key, inst };
  if (rendering){ return false; }
  const full = key + '|' + inst + '|' + zlevel + '|' + Math.round(dom.pane.clientWidth / 40);
  if (!force && full === loadedKey && osmd){ dom.pane.hidden = false; return true; }
  try { await lib(); } catch(e){ return false; }
  rendering = true; dom.pane.hidden = false; document.body.classList.add('hassheet'); dom.load.hidden = false;
  const keepMi = firstVisible();
  await tick();
  try {
    const o = new opensheetmusicdisplay.OpenSheetMusicDisplay(dom.svg, { autoResize: false, backend: 'svg', drawTitle: false, drawSubtitle: false, drawComposer: false, drawLyricist: false, drawPartNames: false, drawingParameters: 'compact', drawMeasureNumbers: true, followCursor: false });
    dom.svg.innerHTML = '';
    await o.load(xml);
    if (inst >= o.Sheet.Instruments.length) throw new Error('inst');
    o.Sheet.Instruments.forEach((p, k) => { p.Visible = (k === inst); });
    try { o.EngravingRules.NewSystemAtXMLNewSystemAttribute = false; } catch(_){}
    o.zoom = curZoom(); U = 10 * o.zoom;
    o.render();
    osmd = o; loadedKey = full; layout();
    ok = true;
  } catch (e){
    console.warn('bladmuziek', e); osmd = null; loadedKey = ''; M = []; dom.pane.hidden = true; document.body.classList.remove('hassheet');
    rendering = false; dom.load.hidden = true; return false;
  }
  rendering = false; dom.load.hidden = true;
  redraw();
  if (keepMi != null) scrollToMeasure(keepMi, true);
  if (cb.onRendered) cb.onRendered();
  // tussentijds gevraagde andere stem of grootte
  if (want && (want.inst !== inst || want.key !== key)) return show(want.xml, want.key, want.inst);
  return true;
}
let ok = false;

function layout(){
  const ml = osmd.GraphicSheet.MeasureList; M = [];
  const svg = dom.svg.querySelector('svg');
  natW = dom.pane.clientWidth; natH = svg ? parseFloat(svg.getAttribute('height')) || svg.clientHeight : 0;
  const inst = want.inst; let k = -1;
  const vis = osmd.Sheet.Instruments.map((p, i) => p.Visible ? i : -1).filter(i => i >= 0);
  const col = vis.length ? vis[0] : inst;
  for (let mi = 0; mi < ml.length; mi++){
    const gm = ml[mi][col] || ml[mi].find(Boolean);
    if (!gm){ M.push({ x: 0, y: 0, w: 0, h: 0, e: [] }); continue; }
    const p = gm.PositionAndShape.AbsolutePosition, s = gm.PositionAndShape.Size;
    const st = gm.parentSourceMeasure.AbsoluteTimestamp.RealValue;
    const e = [];
    for (const se of gm.staffEntries){
      const ts = (se.sourceStaffEntry.AbsoluteTimestamp.RealValue - st) * 4;
      const notes = [];
      for (const gve of se.graphicalVoiceEntries) for (const n of gve.notes){
        const sn = n.sourceNote; if (!sn || sn.isRest() || !sn.Pitch) continue;
        const q = n.PositionAndShape.AbsolutePosition; notes.push({ midi: sn.halfTone + 12, x: q.x * U, y: q.y * U });
      }
      e.push({ off: ts, x: se.PositionAndShape.AbsolutePosition.x * U, notes });
    }
    e.sort((a, b) => a.off - b.off);
    M.push({ x: p.x * U, y: p.y * U, w: s.width * U, h: s.height * U, e, len: gm.parentSourceMeasure.Duration.RealValue * 4 });
  }
  const svgEl = dom.svg.querySelector('svg');
  const W = svgEl ? parseFloat(svgEl.getAttribute('width')) : natW;
  dom.ov.style.width = W + 'px'; dom.ov.style.height = natH + 'px';
}

function firstVisible(){
  if (!M.length || !dom) return null;
  const top = dom.sc.scrollTop; for (let i = 0; i < M.length; i++) if (M[i].y + M[i].h > top + 10) return i; return null;
}
function scrollToMeasure(mi, instant){
  if (!M[mi]) return; const m = M[mi];
  dom.sc.scrollTo({ top: Math.max(0, m.y - 34), behavior: instant ? 'auto' : 'smooth' });
}

/* overlay */
let st = { a: 0, b: 0, status: [] }, phEl = null, phMi = -1;
function div(cls, x, y, w, h, txt){
  const d = document.createElement('div'); d.className = cls; d.style.left = x + 'px'; d.style.top = y + 'px';
  if (w != null) d.style.width = w + 'px'; if (h != null) d.style.height = h + 'px'; if (txt) d.textContent = txt; return d;
}
function redraw(){
  if (!dom || !M.length) return;
  const ov = dom.ov; ov.innerHTML = '';
  const fr = document.createDocumentFragment();
  M.forEach((m, i) => {
    if (!m.w) return;
    const y = m.y - 18, h = m.h + 24;
    if (i < st.a || i > st.b) fr.append(div('dim', m.x - 2, y, m.w + 4, h));
    else if (st.status[i]) fr.append(div('st ' + st.status[i], m.x - 2, y, m.w + 4, h));
  });
  const A = M[st.a], B = M[st.b];
  if (A && A.w){ fr.append(div('edge', A.x - 3, A.y - 18, 3, A.h + 24)); fr.append(div('flag', Math.max(2, A.x - 44), A.y - 14, null, null, '▶')); }
  if (B && B.w && st.b !== M.length - 1){ fr.append(div('edge', B.x + B.w, B.y - 18, 3, B.h + 24)); const f = div('flag', 0, B.y - 30, null, null, 'Eind ■'); f.style.left = Math.max(0, B.x + B.w - 52) + 'px'; fr.append(f); }
  marks.forEach(mk => { mk.el = div('mk ' + mk.k + (mk.sel ? ' sel' : ''), mk.x, mk.y); fr.append(mk.el); });
  phEl = div('ph', 0, 0, 2, 40); fr.append(phEl);
  ov.append(fr);
}

const api = {
  init(c){ cb = c || {}; if (!dom) build(); },
  get active(){ return !!dom && !dom.pane.hidden && ok && M.length > 0; },
  async show(xml, key, inst){ return show(xml, key, inst, false); },
  hide(){ if (dom){ dom.pane.hidden = true; } document.body.classList.remove('hassheet'); },
  setSel(a, b){ st.a = a; st.b = b; redraw(); },
  setStatus(arr){ st.status = arr || []; redraw(); },
  clearMarks(){ marks = []; if (dom && M.length) redraw(); },
  mark(mi, off, midi, k, idx){
    const m = M[mi]; if (!m) return;
    let best = null, bd = 0.2;
    for (const e of m.e){ const d = Math.abs(e.off - off); if (d < bd){ bd = d; best = e; } }
    if (!best || !best.notes.length) return;
    let n = best.notes[0], nd = 99; for (const c of best.notes){ const d = Math.abs(c.midi - midi); if (d < nd){ nd = d; n = c; } }
    const mk = { mi, x: n.x + 3, y: n.y, k, idx, sel: false };
    marks.push(mk);
    const el = div('mk ' + k, mk.x, mk.y); mk.el = el; dom.ov.append(el);
  },
  select(idx){ marks.forEach(m => { m.sel = m.idx === idx; if (m.el) m.el.classList.toggle('sel', m.sel); }); },
  playhead(mi, off){
    if (!phEl || !M[mi]){ api.hidePlayhead(); return; }
    const m = M[mi]; let x = m.x + 6, e = m.e;
    if (e.length){
      if (off <= e[0].off) x = e[0].x - 6 + Math.max(0, (off - e[0].off)) ;
      else {
        x = e[e.length - 1].x + 8;
        for (let i = 0; i < e.length; i++){
          const nx = i + 1 < e.length ? e[i + 1] : null;
          if (!nx){ const endX = m.x + m.w - 4; const span = Math.max(0.01, (m.len || 4) - e[i].off); x = e[i].x + (endX - e[i].x) * Math.min(1, (off - e[i].off) / span); break; }
          if (off < nx.off){ x = e[i].x + (nx.x - e[i].x) * ((off - e[i].off) / Math.max(0.001, nx.off - e[i].off)); break; }
        }
      }
    } else x = m.x + m.w * Math.min(1, off / Math.max(0.01, m.len || 4));
    phEl.style.display = 'block'; phEl.style.left = (x - 1) + 'px'; phEl.style.top = (m.y - 12) + 'px'; phEl.style.height = (m.h + 4) + 'px';
    phMi = mi;
  },
  hidePlayhead(){ if (phEl) phEl.style.display = 'none'; phMi = -1; },
  follow(mi){
    const m = M[mi]; if (!m || !dom) return;
    const top = dom.sc.scrollTop, hh = dom.sc.clientHeight;
    if (m.y - 30 < top || m.y + m.h + 20 > top + hh * 0.8) dom.sc.scrollTo({ top: Math.max(0, m.y - 34), behavior: 'smooth' });
  },
  scrollToMeasure(mi){ scrollToMeasure(mi, false); },
  measureCount(){ return M.length; },
  // bewaren van de bladmuziek op het toestel (IndexedDB), zodat het stuk ook na opnieuw openen een partituur heeft
  async saveXml(title, xml){ try { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction('x', 'readwrite'); t.objectStore('x').put({ title, xml }, 'last'); t.oncomplete = res; t.onerror = rej; }); } catch(e){} },
  async loadXml(title){ try { const db = await idb(); return await new Promise(res => { const r = db.transaction('x').objectStore('x').get('last'); r.onsuccess = () => res(r.result && r.result.title === title ? r.result.xml : null); r.onerror = () => res(null); }); } catch(e){ return null; } }
};
function idb(){ return new Promise((res, rej) => { const r = indexedDB.open('naklank', 1); r.onupgradeneeded = () => r.result.createObjectStore('x'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
window.NKscore = api;
})();
