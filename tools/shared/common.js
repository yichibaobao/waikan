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
/* Progress is kept per learner: key "k" of learner "u1" lives in localStorage as "k@u1". who.js manages the learners
   (the list is in WHO_KEY, which itself is never namespaced). WHO_ID is '' until someone has been chosen. */
const WHO_KEY = 'wk-who-v1';
function whoReg(){
  const out = {v:1, cur:'', list:[], claimed:false};
  let d = null;
  try { d = JSON.parse(localStorage.getItem(WHO_KEY) || 'null'); } catch(e){}
  if (!d || typeof d !== 'object') return out;
  if (Array.isArray(d.list)) d.list.forEach(function(p){
    if (p && typeof p.id === 'string' && /^[a-z0-9]{3,24}$/.test(p.id) && typeof p.name === 'string' && p.name.trim() &&
        !out.list.some(function(q){ return q.id === p.id; }))
      out.list.push({id:p.id, name:p.name.trim().slice(0, 16), c:typeof p.c === 'number' ? p.c : 0, u:typeof p.u === 'number' ? p.u : 0});
  });
  if (typeof d.cur === 'string' && out.list.some(function(p){ return p.id === d.cur; })) out.cur = d.cur;
  out.claimed = !!d.claimed;
  return out;
}
let WHO_ID = whoReg().cur;
function pkey(k){ return WHO_ID ? k + '@' + WHO_ID : k; }
function lsGet(k){ try { return JSON.parse(localStorage.getItem(pkey(k)) || 'null'); } catch(e){ return null; } }
function lsSet(k, v){ try { localStorage.setItem(pkey(k), JSON.stringify(v)); } catch(e){} }
function lsDel(k){ try { localStorage.removeItem(pkey(k)); } catch(e){} }
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
