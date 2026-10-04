// Step 3 — soul-sea/review.html: a self-contained page to check the timeline
// chapter by chapter (pick a chapter → Sunny's Soul Sea as of the end of it,
// with the book's rune sheets and the passages behind every change).
// Gitignored like the rest of soul-sea/, since it embeds book text.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { WORK } from './lib.mjs'

const data = JSON.parse(await readFile(path.join(WORK, 'resolved.json'), 'utf8'))
const text = JSON.parse(await readFile(path.join(WORK, 'text.json'), 'utf8'))
const { chapters } = JSON.parse(await readFile(path.join(WORK, 'runes.json'), 'utf8'))

// Only the paragraphs the page needs.
const paras = {}
const keep = ({ ch, p }) => (paras[`${ch}:${p}`] = text[ch][p])
for (const e of data.events) {
  keep(e.ref)
  e.paras?.forEach(keep)
}
const titles = {}
for (let c = 1; c <= data.reviewedThrough; c++) titles[c] = chapters[c]?.title

const payload = JSON.stringify({ ...data, paras, titles }).replace(/</g, '\\u003c')

await writeFile(
  path.join(WORK, 'review.html'),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Soul Sea review</title>
<style>
:root{--page:#1a1e27;--surface:#20252f;--alt:#171b23;--pill:#2b323f;--border:#262b36;--strong:#2b313d;
--t1:#e5e9ef;--t2:#c6cbd3;--muted:#9aa2ae;--dim:#79818e;--gain:#7fb38a;--lose:#d97066;--rune:#b9c4e8;
--ui:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--serif:Georgia,serif}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--t2);font:15px/1.5 var(--ui)}
header{position:sticky;top:0;z-index:2;background:var(--alt);border-bottom:1px solid var(--border);padding:12px 16px}
header h1{margin:0 0 8px;font-size:15px;color:var(--t1);font-weight:600}
header h1 span{color:var(--dim);font-weight:400}
.nav{display:flex;gap:8px;align-items:center}
.nav input[type=range]{flex:1;min-width:0}
.nav input[type=number]{width:72px;background:var(--surface);color:var(--t1);border:1px solid var(--strong);border-radius:6px;padding:4px 6px;font:inherit}
button{background:var(--pill);color:var(--t1);border:0;border-radius:6px;padding:5px 10px;font:inherit;cursor:pointer}
.title{margin-top:6px;color:var(--muted);font-size:13px}
.chip{display:inline-block;font-size:11px;padding:1px 7px;border-radius:9px;background:var(--pill);color:var(--muted);margin-left:6px}
main{max-width:760px;margin:0 auto;padding:8px 16px 80px}
h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:26px 0 8px;font-weight:600}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin:8px 0}
.card .head{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.name{color:var(--t1);font-weight:600}
.name.label{font-weight:400;font-style:italic}
.since,.ref{color:var(--dim);font-size:12px;white-space:nowrap}
a.ref{color:var(--dim);text-decoration:underline dotted;cursor:pointer}
.runes{margin:8px 0 0;font:14px/1.55 var(--serif);color:var(--rune)}
.runes p{margin:2px 0}
details{margin-top:6px}
summary{cursor:pointer;color:var(--muted);font-size:12px}
.passage{font:14px/1.6 var(--serif);color:var(--t2);border-left:2px solid var(--strong);padding-left:10px;margin:6px 0}
.passage p{margin:4px 0}
.ev{display:flex;gap:10px;align-items:baseline;margin:10px 0}
.ev .tag{font-size:11px;font-weight:600;min-width:62px;text-transform:uppercase;letter-spacing:.05em}
.tag.gain{color:var(--gain)}.tag.lose{color:var(--lose)}.tag.other{color:var(--muted)}
.stat{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)}
.stat b{color:var(--t1);font-weight:500}
.gone .name{color:var(--muted);text-decoration:line-through}
.check{font-size:13px;margin:4px 0}.check.bad{color:var(--lose)}
.empty{color:var(--dim);font-style:italic}
</style></head><body>
<header>
  <h1>Sunny's Soul Sea <span>· review draft · ch 1–${data.reviewedThrough}</span></h1>
  <div class="nav"><button id="prev">‹</button><input id="slider" type="range" min="1" max="${data.reviewedThrough}"><button id="next">›</button><input id="num" type="number" min="1" max="${data.reviewedThrough}"></div>
  <div class="title" id="title"></div>
</header>
<main id="main"></main>
<script>
const D = ${payload};
const KIND_ORDER = [['stat','Status'],['aspect','Aspect'],['ability','Abilities'],['flaw','Flaw'],['attribute','Attributes'],['memory','Memories'],['echo','Echoes'],['shadow','Shadows']];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const P = (r) => D.paras[r.ch + ':' + r.p];
const link = (r) => '<a class="ref" data-ch="' + r.ch + '">ch ' + r.ch + '</a>';
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1];
const inFlashback = (c) => D.events.some((e) => e.flashback) && c >= 122 && c <= 168;

function stateAt(upto) {
  const s = {};
  const get = (id) => (s[id] ??= { id, kind: D.entries[id].kind, runes: [], history: [] });
  for (const e of D.events) {
    if (cmp(e.at, upto) > 0) break;
    if (e.gain) Object.assign(get(e.gain), { held: true, name: e.name, label: e.label, since: e.ref, lost: null });
    if (e.lose) Object.assign(get(e.lose), { held: false, lost: e.ref, how: e.how });
    if (e.become) { Object.assign(get(e.become), { held: false, lost: e.ref, how: 'became ' + e.name }); Object.assign(get(e.to), { held: true, name: e.name, since: e.ref }); }
    if (e.name && !e.gain && !e.become) get(e.name).name = e.value;
    if (e.set) Object.assign(get(e.set), { held: true, value: e.value, since: e.ref });
    if (e.runes) get(e.runes).runes.unshift(e.paras);
    if (e.history) get(e.history).history.push(e);
  }
  return s;
}

const sheet = (ps) => '<div class="runes">' + ps.map((r) => '<p>' + esc(P(r)) + '</p>').join('') + '</div>';
const passage = (ps) => '<div class="passage">' + ps.map((r) => '<p>' + esc(P(r)) + '</p>').join('') + '</div>';
const title = (x) => x.name ? '<span class="name">' + esc(x.name) + '</span>' : '<span class="name label">“' + esc(x.label) + '”</span>';

function card(x, gone) {
  let h = '<div class="card' + (gone ? ' gone' : '') + '"><div class="head">' + title(x) +
    '<span class="since">' + (gone ? (esc(x.how || 'lost') + ' · ' + link(x.lost)) : 'since ' + link(x.since)) + '</span></div>';
  if (x.runes[0]) h += sheet(x.runes[0]);
  else if (!gone) h += '<div class="runes empty">No rune sheet yet</div>';
  if (x.history.length) h += '<details><summary>From the book (' + x.history.length + ')</summary>' +
    x.history.map((e) => '<div class="ref">' + link(e.ref) + (e.flashback ? ' · flashback' : '') + '</div>' + passage(e.paras)).join('') + '</details>';
  return h + '</div>';
}

function evLine(e) {
  const id = e.gain || e.lose || e.become || e.runes || e.history || e.name || e.set;
  const kind = e.gain ? ['gain', 'gained'] : e.lose ? ['lose', e.how || 'lost'] : e.become ? ['other', 'became'] : e.runes ? ['other', 'runes'] : e.history ? ['other', 'passage'] : e.name ? ['other', 'named'] : ['other', 'stat'];
  const x = stateAt(e.at)[e.become ? e.to : id] || {};
  const what = e.set ? D.entries[id].label + ': ' + e.value : x.name || (x.label ? '“' + x.label + '”' : id);
  const ps = e.paras && !e.runes ? e.paras : [e.ref];
  return '<div class="ev"><span class="tag ' + kind[0] + '">' + kind[1] + '</span><div style="flex:1"><div class="name">' + esc(what) + '</div>' +
    (e.runes ? sheet(e.paras) : passage(ps)) + '</div></div>';
}

function render(c) {
  c = Math.max(1, Math.min(D.reviewedThrough, c | 0));
  slider.value = num.value = c;
  document.getElementById('title').innerHTML = esc(D.titles[c] || 'Chapter ' + c) + (inFlashback(c) ? '<span class="chip">flashback</span>' : '');
  const s = stateAt([c, 1e9]);
  const items = Object.values(s);
  let h = '';
  const here = D.events.filter((e) => e.at[0] === c && !e.auto);
  h += '<h2>In this chapter</h2>' + (here.length ? here.map(evLine).join('') : '<div class="empty">Nothing changes in this chapter.</div>');
  for (const [k, label] of KIND_ORDER) {
    const held = items.filter((x) => x.kind === k && x.held);
    if (k === 'stat') {
      if (held.length) h += '<h2>' + label + '</h2><div class="card">' + held.map((x) => '<div class="stat"><span>' + esc(D.entries[x.id].label) + '</span><span><b>' + esc(x.value) + '</b> <span class="since">as of ' + link(x.since) + '</span></span></div>').join('') + '</div>';
      continue;
    }
    if (held.length) h += '<h2>' + label + ' (' + held.length + ')</h2>' + held.map((x) => card(x)).join('');
  }
  const gone = items.filter((x) => x.held === false && x.kind !== 'stat');
  if (gone.length) h += '<details style="margin-top:26px"><summary>No longer held (' + gone.length + ')</summary>' + gone.map((x) => card(x, true)).join('') + '</details>';
  const cps = D.checkpoints;
  h += '<h2>Checkpoints (rune lists in the book)</h2>' + cps.map((k) => {
    const bad = k.missing.length || k.extra.length;
    return '<div class="check' + (bad ? ' bad' : '') + '">' + (bad ? '✗' : '✓') + ' <a class="ref" data-ch="' + k.at.split(':')[0] + '">ch ' + k.at + '</a> ' + k.list + ' · ' + k.names.length + ' listed' + (k.truncated ? ' (cut off)' : '') +
      (k.missing.length ? ' · missing from timeline: ' + esc(k.missing.join(', ')) : '') + (k.extra.length ? ' · not in book: ' + esc(k.extra.join(', ')) : '') + (k.note ? '<div class="since">' + esc(k.note) + '</div>' : '') + '</div>';
  }).join('');
  main.innerHTML = h;
  try { localStorage.setItem('soulsea-ch', c); } catch {}
}
const main = document.getElementById('main'), slider = document.getElementById('slider'), num = document.getElementById('num');
slider.oninput = () => render(+slider.value);
num.onchange = () => render(+num.value);
prev.onclick = () => render(+slider.value - 1);
next.onclick = () => render(+slider.value + 1);
document.addEventListener('click', (e) => { const a = e.target.closest('a.ref[data-ch]'); if (a) { render(+a.dataset.ch); scrollTo(0, 0); } });
document.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT' && e.target.type === 'number') return; if (e.key === 'ArrowLeft') render(+slider.value - 1); if (e.key === 'ArrowRight') render(+slider.value + 1); });
let start = 1; try { start = +localStorage.getItem('soulsea-ch') || 1; } catch {}
render(start);
</script></body></html>
`,
)
console.log('soul-sea/review.html written')
