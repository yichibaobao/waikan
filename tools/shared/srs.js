/* ---------- spaced repetition on the Ebbinghaus ladder (inlined by tools/build.py) ----------
   Everything lives in this browser's localStorage under SRS_KEY, shape
     {v:1, w:{"<slug>:<word id>": {b, t, l, c, x}}, log:{"YYYY-MM-DD": {n, ok}}, ex:[{d, score, total, scope, k}]}   (k: "exam" = 总考, "listen" = 听力考试)
   b = steps of the ladder passed (0..9)   t = when it is due next (ms)   l = last answered (ms)
   c / x = how many times answered right / wrong.
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
function srsLoad(){
  const d = lsGet(SRS_KEY);
  const out = {v:1, w:{}, log:{}, ex:[]};
  if (!d || typeof d !== 'object') return out;
  if (d.w && typeof d.w === 'object') Object.keys(d.w).forEach(function(k){
    const e = d.w[k];
    if (!e || typeof e !== 'object') return;
    const b = Math.max(0, Math.min(SRS_TOP, Math.floor(srsNum(e.b))));
    out.w[k] = {b:b, t:srsNum(e.t), l:srsNum(e.l), c:Math.max(0, Math.floor(srsNum(e.c))), x:Math.max(0, Math.floor(srsNum(e.x)))};
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
function srsSave(s){ lsSet(SRS_KEY, s); }
function srsGet(key){ return srsLoad().w[key] || null; }

/* pure: the entry after one answer (e = null when the word has never been answered) */
function srsStep(e, ok, now){
  const first = !e;
  const n = first ? {b:0, t:0, l:0, c:0, x:0} : {b:e.b, t:e.t, l:e.l, c:e.c, x:e.x};
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
function srsReset(){ try { localStorage.removeItem(SRS_KEY); } catch(e){} }

/* {st:'new'|'due'|'wait', b, t} */
function srsInfo(e, now){
  if (!e) return {st:'new', b:-1, t:0};
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
  return '间隔 ' + SRS_LABELS[e.b] + ' · ' + (e.t <= now ? '该复习了' : '下次 ' + srsWhen(e.t, now));
}
