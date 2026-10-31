/* ---------- small helpers shared by every page (inlined by tools/build.py) ---------- */
function $(s, r){ return (r || document).querySelector(s); }
function $$(s, r){ return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
function h(tag, attrs){
  const e = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function(k){
    const v = attrs[k];
    if (v == null || v === false) return;
    if (k === 'class') e.className = v;
    else if (k.slice(0,2) === 'on') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  });
  Array.prototype.slice.call(arguments, 2).forEach(function(kid){
    [].concat(kid).forEach(function(k){
      if (k == null || k === false) return;
      e.append(k.nodeType ? k : document.createTextNode(String(k)));
    });
  });
  return e;
}
function pad2(n){ return String(n).padStart(2, '0'); }
function ymd(d){ return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function today(){ return ymd(new Date()); }
function lsGet(k){ try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch(e){ return null; } }
function lsSet(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }
function shuffle(a){ for (let i = a.length - 1; i > 0; i--){ const j = Math.floor(Math.random()*(i+1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function norm(s){ return String(s).toLowerCase().replace(/[^a-z]/g, ''); }
function esc(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/* example sentences mark their target as [[target]] */
function exNodes(s){
  const out = [];
  s.split(/\[\[(.+?)\]\]/).forEach(function(part, k){ if (part) out.push(k % 2 ? h('b', null, part) : document.createTextNode(part)); });
  return out;
}
function exPlain(s){ return s.replace(/\[\[|\]\]/g, ''); }
