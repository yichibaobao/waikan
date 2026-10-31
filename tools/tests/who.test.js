/* node tools/tests/who.test.js : checks the learners / backup logic in tools/shared/who.js (the interface itself is tested in a browser) */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const dir = path.join(__dirname, '..', 'shared');
const J = x => JSON.parse(JSON.stringify(x));
const eq = (a, b, m) => assert.deepStrictEqual(J(a), J(b), m);     // objects made inside the vm have other prototypes; compare as plain JSON
let n = 0;
function t(name, fn){ fn(); n++; console.log('ok  ' + name); }
function boot(store){
  const ctx = {
    localStorage: {getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; },
      get length(){ return Object.keys(store).length; }, key: i => Object.keys(store)[i] === undefined ? null : Object.keys(store)[i]},
    Date, JSON, Math, Object, Array, String, Number, RegExp, isFinite, btoa, atob, console,
  };
  vm.createContext(ctx);
  const src = ['common.js', 'srs.js', 'who.js'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') +
    '\nthis.api = {Who, stateClean, stateMerge, srsMerge, srsClean, srsRecord, srsLoad, lsGet, lsSet, lsDel, pkey, whoReg, getId: () => WHO_ID};';
  vm.runInContext(src, ctx);
  return ctx.api;
}

t('no learner chosen: keys are plain, the picker is needed', () => {
  const store = {}; const A = boot(store);
  assert.strictEqual(A.getId(), '');
  assert.strictEqual(A.Who.ready(), false);
  assert.strictEqual(A.pkey('wk-srs-v1'), 'wk-srs-v1');
});

t('create a learner: saved, becomes current after a reload, keys get its suffix', () => {
  const store = {}; let A = boot(store);
  const r = A.Who.create('  小明  ');
  assert.ok(r.ok); assert.strictEqual(r.name, '小明'); assert.strictEqual(r.existed, false);
  A = boot(store);
  assert.strictEqual(A.getId(), r.id);
  assert.strictEqual(A.Who.ready(), true);
  assert.strictEqual(A.Who.current().name, '小明');
  A.lsSet('wk-x-state', {a: 1});
  assert.ok(('wk-x-state@' + r.id) in store);
  assert.ok(!('wk-x-state' in store));
});

t('names: empty refused, control characters and length cut, same name (any case) is the same learner', () => {
  const store = {}; const A = boot(store);
  assert.strictEqual(A.Who.create('   ').ok, false);
  assert.strictEqual(A.Who.cleanName('a\u0000b\nc  d'), 'abc d');
  assert.strictEqual(A.Who.cleanName('x'.repeat(40)).length, 16);
  const a = A.Who.create('Amy'), b = A.Who.create('amy');
  assert.strictEqual(b.existed, true); assert.strictEqual(a.id, b.id);
  assert.strictEqual(A.Who.list().length, 1);
});

t('two learners keep separate progress on one browser', () => {
  const store = {}; let A = boot(store);
  const a = A.Who.create('甲'); A = boot(store);
  A.srsRecord('s:1', true, 1000); A.lsSet('wk-s-state', {v: 1, vocab: {1: {s: 'mastered', d: '2026-10-01'}}, ans: {}, quiz: null});
  const b = A.Who.create('乙'); A = boot(store);
  assert.notStrictEqual(a.id, b.id);
  assert.strictEqual(Object.keys(A.srsLoad().w).length, 0);
  assert.strictEqual(A.lsGet('wk-s-state'), null);
  A.srsRecord('s:2', false, 2000);
  assert.ok(A.Who.select(a.id)); A = boot(store);
  eq(Object.keys(A.srsLoad().w), ['s:1']);
  assert.strictEqual(A.lsGet('wk-s-state').vocab[1].s, 'mastered');
});

t('progress saved before learners existed goes to the first learner only', () => {
  const store = {'wk-srs-v1': JSON.stringify({v: 1, w: {'s:1': {b: 2, t: 5, l: 4, c: 1, x: 0}}, log: {}, ex: []}), 'fk-state-v1': JSON.stringify({vocab: {}}), 'fk-ui-v1': '{"zh":true}', 'other': 'x'};
  let A = boot(store);
  eq(A.Who.legacyKeys().sort(), ['fk-state-v1', 'fk-ui-v1', 'wk-srs-v1']);
  const first = A.Who.create('我'); A = boot(store);
  eq(Object.keys(A.srsLoad().w), ['s:1']);
  assert.strictEqual(A.lsGet('fk-ui-v1').zh, true);
  const second = A.Who.create('朋友'); A = boot(store);
  assert.strictEqual(Object.keys(A.srsLoad().w).length, 0);
  assert.strictEqual(A.whoReg().claimed, true);
  assert.ok(first.id !== second.id);
  assert.strictEqual(store['other'], 'x');
});

t('switching: leave() asks for the picker again, select() restores a learner', () => {
  const store = {}; let A = boot(store);
  const a = A.Who.create('甲'); A = boot(store);
  assert.ok(A.Who.leave()); A = boot(store);
  assert.strictEqual(A.Who.ready(), false);
  assert.ok(A.Who.select(a.id)); A = boot(store);
  assert.strictEqual(A.Who.ready(), true);
  assert.strictEqual(A.Who.select('nope'), false);
});

t('remove deletes only that learner\'s keys', () => {
  const store = {}; let A = boot(store);
  const a = A.Who.create('甲'); A = boot(store); A.srsRecord('s:1', true, 1);
  const b = A.Who.create('乙'); A = boot(store); A.srsRecord('s:2', true, 1);
  A.Who.remove(b.id); A = boot(store);
  assert.strictEqual(A.Who.ready(), false);
  eq(A.Who.list().map(p => p.name), ['甲']);
  assert.ok(!Object.keys(store).some(k => k.endsWith('@' + b.id)));
  assert.ok(Object.keys(store).some(k => k.endsWith('@' + a.id)));
});

t('registry from a damaged store is sanitized', () => {
  const store = {'wk-who-v1': JSON.stringify({cur: 'ghost', list: [{id: 'ab', name: 'short id'}, {id: 'u12345', name: '  '}, {id: 'u12345x', name: 'ok'}, {id: 'u12345x', name: 'dup'}, 5]})};
  const A = boot(store);
  eq(A.Who.list().map(p => p.name), ['ok']);
  assert.strictEqual(A.getId(), '');
  assert.strictEqual(boot({'wk-who-v1': '{not json'}).Who.list().length, 0);
});

t('a browser that cannot store gets no picker', () => {
  const ctx = {localStorage: {getItem: () => null, setItem: () => { throw new Error('denied'); }, removeItem: () => {}, length: 0, key: () => null}, Date, JSON, Math, Object, Array, String, Number, RegExp, isFinite, btoa, atob};
  vm.createContext(ctx);
  vm.runInContext(['common.js', 'srs.js', 'who.js'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') + '\nthis.W = Who;', ctx);
  assert.strictEqual(ctx.W.canStore(), false);
  assert.strictEqual(ctx.W.ready(), true);
  assert.strictEqual(ctx.W.create('x').ok, false);
});

/* ---------- merging ---------- */
const E = (b, t, l, c, x) => ({b, t, l, c, x});
t('srsMerge: per word the copy answered last wins, the day tally is not doubled, results are united once', () => {
  const A = boot({});
  const a = {v: 1, w: {x: E(3, 100, 50, 3, 0), y: E(1, 10, 5, 1, 0), z: E(2, 7, 7, 2, 1)}, log: {'2026-10-30': {n: 10, ok: 8}, '2026-10-31': {n: 4, ok: 4}}, ex: [{d: '2026-10-30', score: 5, total: 10, scope: 'a', k: 'exam'}]};
  const b = {v: 1, w: {x: E(5, 900, 80, 5, 0), y: E(0, 3, 2, 0, 1), w: E(1, 1, 1, 1, 0), z: E(4, 8, 7, 3, 1)}, log: {'2026-10-30': {n: 10, ok: 8}, '2026-10-31': {n: 6, ok: 5}}, ex: [{d: '2026-10-30', score: 5, total: 10, scope: 'a', k: 'exam'}, {d: '2026-10-29', score: 9, total: 10, scope: 'b', k: 'listen'}]};
  const m = J(A.srsMerge(a, b));
  assert.strictEqual(m.w.x.b, 5);               // b answered later
  assert.strictEqual(m.w.y.b, 1);               // a answered later
  assert.ok(m.w.w);                             // only in b
  assert.strictEqual(m.w.z.b, 4);               // same time: more answers wins
  eq(m.log['2026-10-30'], {n: 10, ok: 8});
  eq(m.log['2026-10-31'], {n: 6, ok: 5});
  assert.strictEqual(m.ex.length, 2);
  eq(m.ex.map(e => e.d), ['2026-10-29', '2026-10-30']);
  eq(J(A.srsMerge(a, a)), J(A.srsClean(a)));   // merging a copy with itself changes nothing
  eq(A.srsMerge(null, b).w, A.srsClean(b).w); eq(A.srsMerge(null, b).log, A.srsClean(b).log);
});

t('srsMerge keeps the 20 newest results and ignores hostile keys', () => {
  const A = boot({});
  const ex = Array.from({length: 15}, (_, i) => ({d: '2026-09-' + String(i + 10), score: 1, total: 2, scope: 's' + i, k: 'exam'}));
  const ex2 = Array.from({length: 15}, (_, i) => ({d: '2026-10-' + String(i + 10), score: 1, total: 2, scope: 't' + i, k: 'listen'}));
  assert.strictEqual(A.srsMerge({ex}, {ex: ex2}).ex.length, 20);
  const evil = JSON.parse('{"w":{"__proto__":{"b":9,"t":1,"l":1,"c":1,"x":0},"s:1":{"b":99,"t":"x","l":-5,"c":1.9,"x":-2}}}');
  const m = A.srsClean(evil);
  assert.strictEqual(Object.keys(m.w).join(), 's:1');
  eq(J(m.w['s:1']), {b: 9, t: 0, l: -5, c: 1, x: 0});
  assert.strictEqual(({}).b, undefined);
});

t('stateMerge: newer word copy wins but notes and statuses only one copy has are kept; answers united; later quiz kept', () => {
  const A = boot({});
  const a = {vocab: {1: {s: 'learning', d: '2026-10-20', m: 'my note'}, 2: {s: 'mastered', d: '2026-10-25'}, 3: {s: 'learning', d: '2026-10-01'}}, ans: {q1: 'mine', q2: 'only a'}, quiz: {score: 20, total: 38, d: '2026-10-20', k: 'mcq'}};
  const b = {vocab: {1: {s: 'mastered', d: '2026-10-28'}, 2: {s: 'learning', d: '2026-10-02', m: 'older note'}, 4: {s: 'mastered', d: '2026-10-03'}}, ans: {q1: 'theirs', q3: 'only b'}, quiz: {score: 30, total: 38, d: '2026-10-28', k: 'dict'}};
  const m = J(A.stateMerge(a, b));
  eq(m.vocab[1], {s: 'mastered', m: 'my note', d: '2026-10-28'});
  eq(m.vocab[2], {s: 'mastered', m: 'older note', d: '2026-10-25'});
  assert.ok(m.vocab[3] && m.vocab[4]);
  eq(m.ans, {q1: 'mine', q2: 'only a', q3: 'only b'});
  assert.strictEqual(m.quiz.d, '2026-10-28');
  eq(J(A.stateMerge(a, a)), J(A.stateClean(a)));
  assert.strictEqual(A.stateMerge(null, null).quiz, null);
});

/* ---------- backup code ---------- */
function learner(store, name){ let A = boot(store); const r = A.Who.create(name); A = boot(store); return {A, id: r.id}; }

t('export -> code -> parse round trip, including Chinese text', () => {
  const store = {}; const {A, id} = learner(store, '甲');
  A.srsRecord('s:1', true, 1000);
  A.lsSet('fk-state-v1', {v: 1, vocab: {7: {s: 'mastered', d: '2026-10-01', m: '随身物品，常用复数'}}, ans: {t1: '我的造句 — “quotes” & emoji 🙂'}, quiz: null});
  A.lsSet('fk-ui-v1', {zh: true, rate: 1.3});
  const code = A.Who.toCode(A.Who.bundle(id));
  assert.ok(code.startsWith('WK1.'));
  assert.ok(/^[A-Za-z0-9+\/=.]+$/.test(code), 'code is one plain token');
  const p = A.Who.parse(code);
  assert.ok(p.ok); assert.strictEqual(p.name, '甲');
  eq(Object.keys(p.data).sort(), ['fk-state-v1', 'fk-ui-v1', 'wk-srs-v1']);
  assert.strictEqual(p.data['fk-state-v1'].ans.t1, '我的造句 — “quotes” & emoji 🙂');
});

t('parse tolerates chat noise around the code, line breaks inside it and the raw JSON file', () => {
  const store = {}; const {A, id} = learner(store, 'Amy');
  A.srsRecord('s:1', true, 1000);
  const b = A.Who.bundle(id), code = A.Who.toCode(b);
  assert.ok(A.Who.parse('我的进度：\n' + code + '\n（来自微信）').ok);
  assert.ok(A.Who.parse('here is my code ' + code + ' thanks').ok);
  assert.ok(A.Who.parse(code.replace(/(.{40})/g, '$1\n')).ok);
  assert.ok(A.Who.parse(JSON.stringify(b)).ok);
  assert.ok(A.Who.parse('  ' + code + '  ').ok);
});

t('parse refuses things that are not a progress code', () => {
  const A = boot({});
  [['', /粘贴/], ['hello', /没有找到/], ['WK1.@@@', /读不出来/], ['WK1.' + Buffer.from('not json').toString('base64'), /读不出来/],
   ['{"a":1}', /不是本站/], ['{bad', /读不出来/], [JSON.stringify({app: 'waikan', data: []}), /不是本站/],
   [JSON.stringify({app: 'other', data: {'wk-srs-v1': {}}}), /不是本站/],
   [JSON.stringify({app: 'waikan', data: {'wk-who-v1': {cur: 'x'}, 'evil': {}, 'wk-s-state': 5, 'wk-t-state': [1]}}), /没有可导入/]]
    .forEach(([text, re]) => { const r = A.Who.parse(text); assert.strictEqual(r.ok, false, text); assert.ok(re.test(r.err), text + ' -> ' + r.err); });
  assert.strictEqual(A.Who.parse('x'.repeat(2100000)).ok, false);
  const r = A.Who.parse(JSON.stringify({app: 'waikan', name: 'n', data: {'wk-srs-v1': {w: {}}, 'wk-who-v1': {cur: 'x'}, 'evil': {}, 'fk-state-v1': {}}}));
  eq(Object.keys(r.data).sort(), ['fk-state-v1', 'wk-srs-v1']);   // the registry and unknown keys are dropped
});

t('import into another browser: a new learner gets the progress; importing twice changes nothing', () => {
  const s1 = {}; const one = learner(s1, '甲');
  one.A.srsRecord('s:1', true, 1000); one.A.srsRecord('s:2', false, 2000);
  one.A.lsSet('wk-s-state', {v: 1, vocab: {1: {s: 'mastered', d: '2026-10-01'}}, ans: {}, quiz: {score: 3, total: 4, d: '2026-10-02', k: 'mcq'}});
  const code = one.A.Who.toCode(one.A.Who.bundle(one.id));

  const s2 = {}; let B = boot(s2);
  const p = B.Who.parse(code);
  const r = B.Who.create(p.name);
  const m1 = B.Who.mergeData(r.id, p.data);
  eq(m1, {words: 2, articles: 1});
  B = boot(s2);
  const snap = () => JSON.stringify([B.srsLoad(), B.lsGet('wk-s-state')]);
  const once = snap();
  eq(Object.keys(B.srsLoad().w).sort(), ['s:1', 's:2']);
  assert.strictEqual(B.lsGet('wk-s-state').quiz.score, 3);
  B.Who.mergeData(r.id, B.Who.parse(code).data);
  assert.strictEqual(snap(), once);
});

t('import merges into existing progress and never lowers it', () => {
  const s1 = {}; const old = learner(s1, '甲');
  old.A.srsRecord('s:1', true, 1000);                     // answered once, long ago
  const code = old.A.Who.toCode(old.A.Who.bundle(old.id));
  const s2 = {}; const nu = learner(s2, '甲');
  nu.A.srsRecord('s:1', true, 5000); nu.A.srsRecord('s:1', true, 5000 + 40 * 60000);   // later and further up the ladder
  nu.A.srsRecord('s:9', true, 7000);
  nu.A.lsSet('fk-ui-v1', {zh: false, rate: 1.5});
  const before = nu.A.srsLoad().w['s:1'];
  const p = nu.A.Who.parse(code);
  p.data['fk-ui-v1'] = {zh: true, rate: 0.7, theme: 'x'.repeat(100), nested: {a: 1}};
  nu.A.Who.mergeData(nu.id, p.data);
  const A = boot(s2);
  eq(J(A.srsLoad().w['s:1']), J(before));
  assert.ok(A.srsLoad().w['s:9']);
  eq(J(A.lsGet('fk-ui-v1')), {zh: false, rate: 1.5});   // this device's preferences win; junk fields are dropped
});

t('summary describes a learner', () => {
  const store = {}; const {A, id} = learner(store, '甲');
  assert.strictEqual(A.Who.summary(id), '还没开始学');
  A.srsRecord('s:1', true, Date.now());
  A.lsSet('wk-s-state', {vocab: {1: {s: 'mastered', d: '2026-10-01'}, 2: {s: 'learning', d: '2026-10-01'}}});
  assert.strictEqual(A.Who.summary(id), '已掌握\u00a01\u00a0个词 · 复习计划\u00a01\u00a0个词 · 上次学习：今天');
});

console.log('\n' + n + ' tests passed');
