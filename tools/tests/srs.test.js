/* node tools/tests/srs.test.js : checks the spaced-repetition rules in tools/shared/srs.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const dir = path.join(__dirname, '..', 'shared');
const store = {};
const ctx = {
  localStorage: {getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; }},
  Date, JSON, Math, Object, Array, String, Number, RegExp, isFinite,
};
vm.createContext(ctx);
// the shared files declare plain functions / consts; run them as one script and export what the tests need
const src = ['common.js', 'srs.js'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') +
  '\nthis.api = {srsStep, srsRecord, srsPreview, srsLoad, srsGet, srsInfo, srsWhen, srsStageText, srsAddExam, srsUndo, srsSetLastExamScore, srsReset, srsRetire, srsMerge, SRS_STEPS, SRS_LONG, SRS_TOP, SRS_LABELS, SRS_KEY};';
vm.runInContext(src, ctx);
const A = ctx.api;
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
let n = 0;
function t(name, fn){ fn(); n++; console.log('ok  ' + name); }

t('ladder constants', () => {
  assert.deepStrictEqual(Array.from(A.SRS_STEPS), [5 * MIN, 30 * MIN, 12 * HOUR, DAY, 2 * DAY, 4 * DAY, 7 * DAY, 15 * DAY, 30 * DAY]);
  assert.strictEqual(A.SRS_LONG, 60 * DAY);
  assert.strictEqual(A.SRS_LABELS.length, A.SRS_TOP + 1);
});

t('first answer right: passes step 0, next review in 30 minutes', () => {
  const e = A.srsStep(null, true, 1000);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(e)), {b: 1, t: 1000 + 30 * MIN, l: 1000, c: 1, x: 0});
});

t('first answer wrong: back to 5 minutes', () => {
  const e = A.srsStep(null, false, 1000);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(e)), {b: 0, t: 1000 + 5 * MIN, l: 1000, c: 0, x: 1});
});

t('right but early does not move the schedule', () => {
  let e = A.srsStep(null, true, 0);
  const before = {b: e.b, t: e.t};
  e = A.srsStep(e, true, 10 * MIN);
  assert.strictEqual(e.b, before.b);
  assert.strictEqual(e.t, before.t);
  assert.strictEqual(e.c, 2);
  assert.strictEqual(e.l, 10 * MIN);
});

t('right and due climbs one step, exactly on the due time too', () => {
  let e = A.srsStep(null, true, 0);            // b=1, due 30 min
  e = A.srsStep(e, true, 30 * MIN);            // due exactly now
  assert.strictEqual(e.b, 2);
  assert.strictEqual(e.t, 30 * MIN + 12 * HOUR);
});

t('answering exactly when due walks the whole ladder: 30m,12h,1d,2d,4d,7d,15d,30d,60d,60d', () => {
  let now = 0, e = A.srsStep(null, true, now);
  const gaps = [e.t - now];
  for (let i = 0; i < 9; i++){ now = e.t; e = A.srsStep(e, true, now); gaps.push(e.t - now); }
  assert.deepStrictEqual(gaps, [30 * MIN, 12 * HOUR, DAY, 2 * DAY, 4 * DAY, 7 * DAY, 15 * DAY, 30 * DAY, 60 * DAY, 60 * DAY]);
  assert.strictEqual(e.b, A.SRS_TOP);
});

t('wrong at any height drops to step 0 and counts the lapse', () => {
  let now = 0, e = A.srsStep(null, true, now);
  for (let i = 0; i < 6; i++){ now = e.t; e = A.srsStep(e, true, now); }
  assert.ok(e.b >= 6);
  const w = A.srsStep(e, false, now + HOUR);   // early and wrong
  assert.strictEqual(w.b, 0);
  assert.strictEqual(w.t, now + HOUR + 5 * MIN);
  assert.strictEqual(w.x, 1);
  assert.strictEqual(w.c, e.c);
});

t('after a lapse the word climbs again from step 1', () => {
  let e = A.srsStep(null, false, 0);           // b=0, due 5 min
  e = A.srsStep(e, true, 5 * MIN);
  assert.strictEqual(e.b, 1);
  assert.strictEqual(e.t, 5 * MIN + 30 * MIN);
});

t('srsStep is pure', () => {
  const e = A.srsStep(null, true, 0);
  const copy = JSON.stringify(e);
  A.srsStep(e, false, 5);
  A.srsStep(e, true, 5);
  assert.strictEqual(JSON.stringify(e), copy);
});

t('srsRecord stores the entry and counts the day', () => {
  A.srsReset();
  const now = new Date(2026, 9, 31, 10, 0, 0).getTime();
  A.srsRecord('a:1', true, now);
  A.srsRecord('a:2', false, now + 1000);
  A.srsRecord('a:1', true, now + 2000);          // early: no climb
  const s = A.srsLoad();
  assert.strictEqual(s.w['a:1'].b, 1);
  assert.strictEqual(s.w['a:1'].c, 2);
  assert.strictEqual(s.w['a:2'].b, 0);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s.log['2026-10-31'])), {n: 3, ok: 2});
});

t('srsLoad survives garbage and clamps values', () => {
  store[A.SRS_KEY] = '{{{not json';
  assert.deepStrictEqual(Object.keys(A.srsLoad().w), []);
  store[A.SRS_KEY] = JSON.stringify({w: {'a:1': {b: 99, t: 'x', l: -5, c: -2, x: 1.7}, 'a:2': null, 'a:3': 5}, log: {'bad': {n: 1}, '2026-01-01': {n: 2, ok: 1}}, ex: [{score: 3, total: 4, d: '2026-01-01'}, {foo: 1}]});
  const s = A.srsLoad();
  assert.strictEqual(s.w['a:1'].b, A.SRS_TOP);
  assert.strictEqual(s.w['a:1'].t, 0);
  assert.strictEqual(s.w['a:1'].c, 0);
  assert.strictEqual(s.w['a:1'].x, 1);
  assert.deepStrictEqual(Object.keys(s.w), ['a:1']);
  assert.deepStrictEqual(Object.keys(s.log), ['2026-01-01']);
  assert.strictEqual(s.ex.length, 1);
});

t('srsRecord keeps at most 120 days of log', () => {
  A.srsReset();
  const base = new Date(2026, 0, 1).getTime();
  for (let i = 0; i < 150; i++) A.srsRecord('a:1', true, base + i * DAY);
  assert.strictEqual(Object.keys(A.srsLoad().log).length, 120);
});

t('srsPreview tells what an answer would do, and writes nothing', () => {
  A.srsReset();
  const now = 1e12;
  assert.strictEqual(A.srsPreview('x:1', true, now).kind, 'first');
  assert.strictEqual(A.srsPreview('x:1', false, now).kind, 'reset');
  A.srsRecord('x:1', true, now);
  assert.strictEqual(A.srsPreview('x:1', true, now + MIN).kind, 'early');
  assert.strictEqual(A.srsPreview('x:1', true, now + 31 * MIN).kind, 'up');
  assert.strictEqual(A.srsLoad().w['x:1'].c, 1);
});

t('srsInfo and srsWhen', () => {
  const now = 1e12;
  assert.strictEqual(A.srsInfo(null, now).st, 'new');
  assert.strictEqual(A.srsInfo({b: 1, t: now - 1}, now).st, 'due');
  assert.strictEqual(A.srsInfo({b: 1, t: now + 1}, now).st, 'wait');
  assert.strictEqual(A.srsWhen(now, now), '现在');
  assert.strictEqual(A.srsWhen(now + 5 * MIN, now), '5 分钟后');
  assert.strictEqual(A.srsWhen(now + 90 * MIN, now), '2 小时后');
  assert.strictEqual(A.srsWhen(now + 12 * HOUR, now), '12 小时后');
  assert.strictEqual(A.srsWhen(now + DAY, now), '明天');
  assert.strictEqual(A.srsWhen(now + 7 * DAY, now), '7 天后');
  assert.strictEqual(A.srsWhen(now + 60 * DAY, now), '2 个月后');
  assert.ok(A.srsStageText({b: 3, t: now + DAY}, now).includes('1 天'));
  assert.strictEqual(A.srsStageText(null, now), '未开始');
});

t('exam history keeps the last 20', () => {
  A.srsReset();
  for (let i = 0; i < 25; i++) A.srsAddExam({d: '2026-10-31', score: i, total: 30, scope: 'all'});
  const ex = A.srsLoad().ex;
  assert.strictEqual(ex.length, 20);
  assert.strictEqual(ex[19].score, 24);
});

t('srsUndo takes back a record, entry and day log', () => {
  A.srsReset();
  const now = new Date(2026, 9, 31, 12, 0, 0).getTime();
  A.srsRecord('u:1', true, now);                       // earlier answer: b=1
  const rec = A.srsRecord('u:1', false, now + 1000);   // a wrong one on top
  assert.strictEqual(A.srsGet('u:1').b, 0);
  A.srsUndo('u:1', rec, false);
  assert.strictEqual(A.srsGet('u:1').b, 1);
  assert.strictEqual(A.srsGet('u:1').x, 0);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(A.srsLoad().log['2026-10-31'])), {n: 1, ok: 1});
  // a word seen for the first time, marked wrong, then overruled as right
  const r2 = A.srsRecord('u:2', false, now);
  A.srsUndo('u:2', r2, false);
  assert.strictEqual(A.srsGet('u:2'), null);
  A.srsRecord('u:2', true, now);
  assert.strictEqual(A.srsGet('u:2').b, 1);
  assert.strictEqual(A.srsGet('u:2').x, 0);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(A.srsLoad().log['2026-10-31'])), {n: 2, ok: 2});
});

t('exam records carry a kind and the last score can be corrected', () => {
  A.srsReset();
  A.srsAddExam({d: '2026-10-31', score: 5, total: 10, scope: 'x'});
  A.srsAddExam({d: '2026-10-31', score: 6, total: 10, scope: '听力', k: 'listen'});
  A.srsSetLastExamScore(8);
  const ex = A.srsLoad().ex;
  assert.strictEqual(JSON.stringify(ex.map(e => e.k)), JSON.stringify(['exam', 'listen']));
  assert.strictEqual(ex[1].score, 8);
  assert.strictEqual(ex[0].score, 5);
});

t('retire: a word marked mastered keeps the mark through later answers and merges', () => {
  A.srsReset();
  A.srsRecord('a:1', true, 0);
  const e = A.srsRetire('a:1', true, 1000);
  assert.strictEqual(e.m, 1);
  assert.strictEqual(e.l, 1000);
  assert.strictEqual(A.srsInfo(A.srsGet('a:1'), 2000).st, 'done');
  assert.strictEqual(A.srsStageText(A.srsGet('a:1'), 2000), '已完全掌握，不再出现');
  A.srsRecord('a:1', false, 3000);                       // an answer in an article's self-test
  assert.strictEqual(A.srsGet('a:1').m, 1);
  const merged = A.srsMerge({w: {'a:1': {b: 2, t: 0, l: 500, c: 1, x: 0}}}, A.srsLoad());
  assert.strictEqual(merged.w['a:1'].m, 1);               // the later choice wins
  A.srsRetire('a:1', false, 4000);
  assert.strictEqual(A.srsGet('a:1').m, undefined);
  A.srsRetire('b:2', true, 5000);                         // a word never answered can be retired too
  assert.strictEqual(A.srsGet('b:2').m, 1);
  A.srsReset();
});

console.log(`\n${n} tests passed`);
