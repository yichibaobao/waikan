/* ---------- spaced repetition on the Ebbinghaus ladder (inlined by tools/build.py) ----------
   Everything lives in this browser's localStorage under SRS_KEY (per learner, see common.js), shape
     {v:1, w:{"<slug>:<word id>": {b, t, l, c, x}}, log:{"YYYY-MM-DD": {n, ok}}, ex:[{d, score, total, scope, k}]}   (k: "exam" = 总考, "listen" = 听力考试)
   b = steps of the ladder passed (0..9)   t = when it is due next (ms)   l = last answered (ms)
   c / x = how many times answered right / wrong.   m = 1: the learner marked the word as fully mastered; it is never asked again
   (review, exam, listening) until restored. Answers given elsewhere (an article's self-test) keep the mark.
   Rules:  first answer right -> b=1 (next review after the 2nd step), first answer wrong -> b=0 (5 minutes)
           right and due     -> b+1, next review after SRS_STEPS[b] (after the last step: SRS_LONG)
           right but early   -> the schedule does not move (drilling a word again right away must not push it up the ladder)
           wrong at any time -> b=0, back to the first step
   srsStep is pure; it is covered by tools/tests/srs.test.js. */
const SRS_KEY = 'wk-srs-v1';
const SRS_MIN = 60000, SRS_HOUR = 3600000, SRS_DAY = 86400000;
const SRS_STEPS = [5 * SRS_MIN, 30 * SRS_MIN, 12 * SRS_HOUR, SRS_DAY, 2 * SRS_DAY, 4 * SRS_DAY, 7 * SRS_DAY, 15 * SRS_DAY, 30 * SRS_DAY];
const SRS_LONG = 60 * SRS_DAY;
const SRS_TOP = SRS_STEPS.length;                 /* b can go from 0 to SRS_TOP */
const SRS_LABELS = ['5 分钟', '30 分钟', '12 小时', '1 天', '2 天', '4 天', '7 天', '15 天', '30 天', '60 天'];

function srsInterval(b){ return b < SRS_STEPS.length ? SRS_STEPS[b] : SRS_LONG; }
function srsNum(x){ return typeof x === 'number' && isFinite(x) ? x : 0; }
/* sanitize anything that claims to be saved progress (from localStorage or from an imported file) */
function srsClean(d){
  const out = {v:1, w:{}, log:{}, ex:[]};
  if (!d || typeof d !== 'object') return out;
  if (d.w && typeof d.w === 'object') Object.keys(d.w).forEach(function(k){
    const e = d.w[k];
    if (k === '__proto__' || !e || typeof e !== 'object') return;
    const b = Math.max(0, Math.min(SRS_TOP, Math.floor(srsNum(e.b))));
    out.w[k] = {b:b, t:srsNum(e.t), l:srsNum(e.l), c:Math.max(0, Math.floor(srsNum(e.c))), x:Math.max(0, Math.floor(srsNum(e.x)))};
    if (e.m) out.w[k].m = 1;
  });
  if (d.log && typeof d.log === 'object') Object.keys(d.log).forEach(function(k){
    const e = d.log[k];
    if (/^\d{4}-\d{2}-\d{2}$/.test(k) && e && typeof e === 'object') out.log[k] = {n:Math.max(0, Math.floor(srsNum(e.n))), ok:Math.max(0, Math.floor(srsNum(e.ok)))};
  });
  if (Array.isArray(d.ex)) d.ex.slice(-20).forEach(function(e){
    if (e && typeof e === 'object' && typeof e.score === 'number' && typeof e.total === 'number')
      out.ex.push({d:String(e.d || '').slice(0, 10), score:e.score, total:e.total, scope:String(e.scope || '').slice(0, 60), k:e.k === 'listen' ? 'listen' : 'exam'});
  });
  return out;
}
function srsLoad(){ return srsClean(lsGet(SRS_KEY)); }
/* two copies of the same learner's progress (this device + an imported one) -> one. A word keeps the copy that was answered last;
   a day's counts keep the larger tally (the same answers are in both copies, so adding them would count twice); results are united. */
function srsMerge(a, b){
  a = srsClean(a); b = srsClean(b);
  const out = {v:1, w:{}, log:{}, ex:[]};
  Object.keys(a.w).forEach(function(k){ out.w[k] = a.w[k]; });
  Object.keys(b.w).forEach(function(k){
    const x = out.w[k], y = b.w[k];
    if (!x || y.l > x.l || (y.l === x.l && y.c + y.x > x.c + x.x)) out.w[k] = y;
  });
  [a.log, b.log].forEach(function(lg){
    Object.keys(lg).forEach(function(k){
      const g = out.log[k], e = lg[k];
      if (!g || e.n > g.n || (e.n === g.n && e.ok > g.ok)) out.log[k] = e;
    });
  });
  const seen = {};
  a.ex.concat(b.ex).forEach(function(e){
    const id = [e.d, e.score, e.total, e.scope, e.k].join('|');
    if (!seen[id]){ seen[id] = 1; out.ex.push(e); }
  });
  out.ex.sort(function(x, y){ return x.d < y.d ? -1 : x.d > y.d ? 1 : 0; });
  out.ex = out.ex.slice(-20);
  return out;
}
function srsSave(s){ lsSet(SRS_KEY, s); }
function srsGet(key){ return srsLoad().w[key] || null; }

/* pure: the entry after one answer (e = null when the word has never been answered) */
function srsStep(e, ok, now){
  const first = !e;
  const n = first ? {b:0, t:0, l:0, c:0, x:0} : {b:e.b, t:e.t, l:e.l, c:e.c, x:e.x};
  if (e && e.m) n.m = 1;
  if (!ok){
    n.b = 0; n.t = now + srsInterval(0); n.x++;
  } else {
    n.c++;
    if (first){ n.b = 1; n.t = now + srsInterval(1); }
    else if (n.t <= now){ n.b = Math.min(n.b + 1, SRS_TOP); n.t = now + srsInterval(n.b); }
  }
  n.l = now;
  return n;
}
/* what would happen, without writing anything: {kind:'first'|'up'|'early'|'reset', b, t} */
function srsPreview(key, ok, now){
  now = now || Date.now();
  const e = srsGet(key), n = srsStep(e, ok, now);
  const kind = !ok ? 'reset' : !e ? 'first' : e.t <= now ? 'up' : 'early';
  return {kind:kind, b:n.b, t:n.t, was:e};
}
function srsRecord(key, ok, now){
  now = now || Date.now();
  const s = srsLoad();
  const prev = s.w[key] || null;
  s.w[key] = srsStep(prev, ok, now);
  const day = ymd(new Date(now));
  const g = s.log[day] || (s.log[day] = {n:0, ok:0});
  g.n++; if (ok) g.ok++;
  const keep = Object.keys(s.log).sort().slice(-120);
  Object.keys(s.log).forEach(function(k){ if (keep.indexOf(k) < 0) delete s.log[k]; });
  srsSave(s);
  return {prev:prev, next:s.w[key], now:now};
}
/* take back one srsRecord(key, ok, now) whose result was `rec` (used when the learner overrules a mark afterwards) */
function srsUndo(key, rec, ok){
  const s = srsLoad();
  if (rec.prev) s.w[key] = rec.prev; else delete s.w[key];
  const g = s.log[ymd(new Date(rec.now))];
  if (g){ g.n = Math.max(0, g.n - 1); if (ok) g.ok = Math.max(0, g.ok - 1); }
  srsSave(s);
}
/* mark a word as fully mastered (on) or put it back into the review plan; `l` moves so that merging progress keeps this choice */
function srsRetire(key, on, now){
  now = now || Date.now();
  const s = srsLoad();
  const e = s.w[key] || {b:SRS_TOP, t:now + SRS_LONG, l:now, c:0, x:0};
  if (on) e.m = 1; else delete e.m;
  e.l = now;
  s.w[key] = e;
  srsSave(s);
  return e;
}
/* drop a word from the plan altogether (a word the learner added and then deleted) */
function srsForget(key){
  const s = srsLoad();
  if (!s.w[key]) return;
  delete s.w[key];
  srsSave(s);
}
function srsAddExam(rec){
  const s = srsLoad();
  s.ex.push(rec);
  s.ex = s.ex.slice(-20);
  srsSave(s);
}
/* the learner overruled a mark in the result list: correct the score of the exam just saved */
function srsSetLastExamScore(score){
  const s = srsLoad();
  if (s.ex.length){ s.ex[s.ex.length - 1].score = score; srsSave(s); }
}
function srsReset(){ lsDel(SRS_KEY); }

/* {st:'new'|'due'|'wait', b, t} */
function srsInfo(e, now){
  if (!e) return {st:'new', b:-1, t:0};
  if (e.m) return {st:'done', b:e.b, t:e.t};
  return {st:e.t <= now ? 'due' : 'wait', b:e.b, t:e.t};
}
/* "5 分钟后", "3 小时后", "明天", "6 天后" */
function srsWhen(t, now){
  const d = t - now;
  if (d <= 0) return '现在';
  if (d < SRS_HOUR) return Math.max(1, Math.round(d / SRS_MIN)) + ' 分钟后';
  if (d < SRS_DAY) return Math.round(d / SRS_HOUR) + ' 小时后';
  const days = Math.round(d / SRS_DAY);
  if (days === 1) return '明天';
  if (days < 60) return days + ' 天后';
  return Math.round(days / 30) + ' 个月后';
}
function srsStageText(e, now){
  if (!e) return '未开始';
  if (e.m) return '已完全掌握，不再出现';
  return '间隔 ' + SRS_LABELS[e.b] + ' · ' + (e.t <= now ? '该复习了' : '下次 ' + srsWhen(e.t, now));
}

/* ---------- my words: expressions the learner marked in an article themself (select text → 加入生词) ----------
   MINE_KEY (per learner): {v:1, w:{"<slug>:<id>": {t, o, ctx, czh, zh, n, a, u, d}}}
   id = "u" + a few base-36 characters; t = the text as selected; ctx = the article sentence it came from, o = where t starts in ctx;
   czh = the sentence's Chinese; zh = the meaning the learner wrote; n = an optional note; a = added, u = last edited (ms);
   d = deleted (ms): kept as a tombstone so that a delete survives merging with an older copy from another device.
   A word becomes an ordinary vocabulary entry (mineWord) and reviews under the SRS key "<slug>:<id>" like any other. */
const MINE_KEY = 'wk-mine-v1';
const MINE_RE = /^[a-z0-9][a-z0-9-]{0,79}:u[a-z0-9]{2,16}$/;
function mineStr(x, n){ return typeof x === 'string' ? x.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : ''; }
function mineClean(d){
  const out = {v:1, w:{}};
  if (!d || typeof d !== 'object' || !d.w || typeof d.w !== 'object') return out;
  Object.keys(d.w).forEach(function(k){
    const e = d.w[k];
    if (!MINE_RE.test(k) || !e || typeof e !== 'object') return;
    const t = mineStr(e.t, 80).trim(), ctx = mineStr(e.ctx, 600);
    if (!t || !ctx) return;
    let o = Math.floor(srsNum(e.o));
    if (ctx.substr(o, t.length) !== t) o = ctx.indexOf(t);
    if (o < 0) return;
    const x = {t:t, o:o, ctx:ctx, czh:mineStr(e.czh, 600), zh:mineStr(e.zh, 200).trim(), n:mineStr(e.n, 400).trim(), a:srsNum(e.a)};
    if (srsNum(e.u)) x.u = srsNum(e.u);
    if (srsNum(e.d)) x.d = srsNum(e.d);
    out.w[k] = x;
  });
  return out;
}
/* per word the copy changed last wins (added, edited or deleted) */
function mineMerge(a, b){
  a = mineClean(a); b = mineClean(b);
  const out = {v:1, w:{}};
  function stamp(e){ return Math.max(e.a, e.u || 0, e.d || 0); }
  Object.keys(a.w).forEach(function(k){ out.w[k] = a.w[k]; });
  Object.keys(b.w).forEach(function(k){ if (!out.w[k] || stamp(b.w[k]) > stamp(out.w[k])) out.w[k] = b.w[k]; });
  return out;
}
function mineLoad(){ return mineClean(lsGet(MINE_KEY)); }
function mineSave(m){ lsSet(MINE_KEY, m); }
/* the live (not deleted) words of one article, oldest first: [[key, entry]] */
function mineOf(slug){
  const w = mineLoad().w;
  return Object.keys(w).filter(function(k){ return k.split(':')[0] === slug && !w[k].d; })
    .map(function(k){ return [k, w[k]]; }).sort(function(x, y){ return x[1].a - y[1].a; });
}
/* an entry -> a vocabulary word in the shape the reader, the quiz kit and the review page use */
function mineWord(key, e){
  const id = key.split(':')[1];
  const before = e.ctx.slice(0, e.o), after = e.ctx.slice(e.o + e.t.length);
  const lower = e.t.toLowerCase();
  return {id:id, mine:true, expr:e.t, zh:e.zh || '（还没写中文意思）', core:e.t, forms:lower === e.t ? [e.t] : [e.t, lower], syn:[], m:[e.t],
    note:e.n, ctx:e.ctx, ex:[{en:before + '[[' + e.t + ']]' + after, zh:e.czh || ''}],
    cloze:{before:before, ans:e.t, after:after, hint:e.zh || '', szh:e.czh || ''}};
}
function mineAdd(slug, x){
  const m = mineLoad();
  let key;
  do { key = slug + ':u' + Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 4); } while (m.w[key]);
  m.w[key] = {t:x.t, o:x.o, ctx:x.ctx, czh:x.czh || '', zh:x.zh || '', n:x.n || '', a:Date.now()};
  mineSave(m);
  return key;
}
function mineEdit(key, patch){
  const m = mineLoad(), e = m.w[key];
  if (!e) return;
  if (typeof patch.zh === 'string') e.zh = patch.zh.trim().slice(0, 200);
  if (typeof patch.n === 'string') e.n = patch.n.trim().slice(0, 400);
  e.u = Date.now();
  mineSave(m);
}
function mineDel(key){
  const m = mineLoad(), e = m.w[key];
  if (!e) return;
  e.d = Date.now();
  mineSave(m);
}
