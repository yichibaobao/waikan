/* ---------- learners: who is studying on this browser (inlined by tools/build.py; needs common.js and srs.js) ----------
   The site is static and has no server, so there are no passwords: a learner is a name that keeps its progress apart from other learners'
   (every localStorage key of a learner is "<key>@<id>", see common.js). The list of learners is stored under WHO_KEY:
     {v:1, cur:"<id>", list:[{id, name, c: created, u: last used}], claimed: bool}
   claimed: progress saved before learners existed (plain wk-* / fk-* keys) goes to the first learner created, once.
   Progress moves between devices as a "progress code" ("WK1." + base64 of a JSON bundle) or as the same JSON in a file. Importing MERGES
   (the newer answer per word wins); it never overwrites. Merge and parse are pure-ish and covered by tools/tests/who.test.js.
   If a new kind of progress is stored in localStorage, it must be a key starting with wk- or fk-; it is then exported, imported and deleted
   with the learner. Anything that is not the SRS key or a UI-preference key is treated as one article's state (see stateClean). */

/* one article's progress: {v:1, vocab:{id:{s,d,m}}, ans:{key:text}, quiz:{score,total,d,k}|null} */
function stateClean(d){
  const out = {v:1, vocab:{}, ans:{}, quiz:null};
  if (!d || typeof d !== 'object') return out;
  if (d.vocab && typeof d.vocab === 'object') Object.keys(d.vocab).forEach(function(k){
    const e = d.vocab[k];
    if (k === '__proto__' || !e || typeof e !== 'object') return;
    const o = {};
    if (e.s === 'learning' || e.s === 'mastered') o.s = e.s;
    if (typeof e.d === 'string') o.d = e.d.slice(0, 10);
    if (typeof e.m === 'string' && e.m) o.m = e.m.slice(0, 400);
    if (o.s || o.m) out.vocab[k] = o;
  });
  if (d.ans && typeof d.ans === 'object') Object.keys(d.ans).forEach(function(k){
    if (k !== '__proto__' && typeof d.ans[k] === 'string' && d.ans[k]) out.ans[k] = d.ans[k].slice(0, 2000);
  });
  if (d.quiz && typeof d.quiz === 'object' && typeof d.quiz.score === 'number' && typeof d.quiz.total === 'number')
    out.quiz = {score:d.quiz.score, total:d.quiz.total, d:String(d.quiz.d || '').slice(0, 10), k:['mcq', 'cloze', 'exs', 'zh', 'dict', 'sent'].indexOf(d.quiz.k) >= 0 ? d.quiz.k : ''};
  return out;
}
/* two copies of one article's progress -> one: per word the copy touched last wins (a status or note only one copy has is kept),
   answers are united (this device's text wins a clash), the later quiz result is kept */
function stateMerge(a, b){
  a = stateClean(a); b = stateClean(b);
  const out = {v:1, vocab:{}, ans:{}, quiz:null};
  Object.keys(a.vocab).forEach(function(k){ out.vocab[k] = a.vocab[k]; });
  Object.keys(b.vocab).forEach(function(k){
    const x = out.vocab[k], y = b.vocab[k];
    if (!x){ out.vocab[k] = y; return; }
    const yNewer = (y.d || '') > (x.d || '');
    const n = yNewer ? y : x, o = yNewer ? x : y;
    const m = {};
    if (n.s || o.s) m.s = n.s || o.s;
    if (n.m || o.m) m.m = n.m || o.m;
    if (n.d || o.d) m.d = n.d || o.d;
    out.vocab[k] = m;
  });
  Object.keys(b.ans).forEach(function(k){ out.ans[k] = b.ans[k]; });
  Object.keys(a.ans).forEach(function(k){ out.ans[k] = a.ans[k]; });
  out.quiz = !a.quiz ? b.quiz : !b.quiz ? a.quiz : (b.quiz.d > a.quiz.d ? b.quiz : a.quiz);
  return out;
}

const Who = (function(){
  const KEEP = /^(wk|fk)-[A-Za-z0-9._-]{1,80}$/;     /* what a learner's progress keys look like */
  const UI_KEYS = ['fk-ui-v1', 'wk-review-ui-v1'];
  const PREFIX = 'WK1.';
  const MAXLEN = 2000000;
  const DAY = 86400000;

  function canStore(){
    try { localStorage.setItem('wk-probe', '1'); localStorage.removeItem('wk-probe'); return true; } catch(e){ return false; }
  }
  function saveReg(reg){ try { localStorage.setItem(WHO_KEY, JSON.stringify(reg)); return true; } catch(e){ return false; } }
  function newId(reg){
    let id;
    do { id = 'u' + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6); } while (reg.list.some(function(p){ return p.id === id; }));
    return id;
  }
  function cleanName(s){ return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16); }
  function byName(reg, name){
    const n = name.toLowerCase();
    return reg.list.filter(function(p){ return p.name.toLowerCase() === n; })[0] || null;
  }
  function list(){ return whoReg().list; }
  function current(){ return whoReg().list.filter(function(p){ return p.id === WHO_ID; })[0] || null; }
  /* a browser that cannot store anything (some private modes) gets no picker: nothing could be saved for anyone anyway */
  function ready(){ return !!WHO_ID || !canStore(); }

  function allKeys(){
    const out = [];
    try { for (let i = 0; i < localStorage.length; i++){ const k = localStorage.key(i); if (k) out.push(k); } } catch(e){}
    return out;
  }
  function keysOf(id){
    const suf = '@' + id;
    return allKeys().filter(function(k){ return k.length > suf.length && k.slice(-suf.length) === suf; })
      .map(function(k){ return k.slice(0, -suf.length); })
      .filter(function(b){ return KEEP.test(b) && b !== WHO_KEY; });
  }
  function legacyKeys(){ return allKeys().filter(function(k){ return KEEP.test(k) && k !== WHO_KEY; }); }
  function claim(id){
    legacyKeys().forEach(function(k){
      try { const v = localStorage.getItem(k); if (v != null && localStorage.getItem(k + '@' + id) == null) localStorage.setItem(k + '@' + id, v); } catch(e){}
    });
  }
  function readKey(k, id){ try { return JSON.parse(localStorage.getItem(k + '@' + id) || 'null'); } catch(e){ return null; } }

  /* ---- learners ---- */
  function create(name){
    name = cleanName(name);
    if (!name) return {ok:false, err:'请先写一个名字。'};
    const reg = whoReg();
    let p = byName(reg, name);
    const existed = !!p;
    if (!p){
      p = {id:newId(reg), name:name, c:Date.now(), u:0};
      reg.list.push(p);
      if (!reg.claimed){ claim(p.id); reg.claimed = true; }
    }
    p.u = Date.now(); reg.cur = p.id;
    if (!saveReg(reg)) return {ok:false, err:'浏览器不让保存数据（可能开了无痕模式），进度存不下来。'};
    return {ok:true, id:p.id, name:p.name, existed:existed};
  }
  function select(id){
    const reg = whoReg();
    const p = reg.list.filter(function(q){ return q.id === id; })[0];
    if (!p) return false;
    p.u = Date.now(); reg.cur = id;
    return saveReg(reg);
  }
  function leave(){ const reg = whoReg(); reg.cur = ''; return saveReg(reg); }
  function remove(id){
    keysOf(id).forEach(function(k){ try { localStorage.removeItem(k + '@' + id); } catch(e){} });
    const reg = whoReg();
    reg.list = reg.list.filter(function(p){ return p.id !== id; });
    if (reg.cur === id) reg.cur = '';
    return saveReg(reg);
  }

  /* ---- backup / restore ---- */
  function b64e(str){
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(_, x){ return String.fromCharCode(parseInt(x, 16)); }));
  }
  function b64d(b){
    const bin = atob(b);
    let p = '';
    for (let i = 0; i < bin.length; i++) p += '%' + ('0' + bin.charCodeAt(i).toString(16)).slice(-2);
    return decodeURIComponent(p);
  }
  function bundle(id){
    const p = whoReg().list.filter(function(q){ return q.id === id; })[0];
    const data = {};
    keysOf(id).forEach(function(k){ const v = readKey(k, id); if (v && typeof v === 'object') data[k] = v; });
    return {app:'waikan', v:1, name:p ? p.name : '', at:new Date().toISOString(), data:data};
  }
  function toCode(b){ return PREFIX + b64e(JSON.stringify(b)); }
  /* text pasted by the learner (a code, possibly with chat noise around it) or the content of an exported file */
  function parse(text){
    text = String(text == null ? '' : text).trim();
    if (!text) return {ok:false, err:'先把进度码粘贴进来，或选一个导出的文件。'};
    if (text.length > MAXLEN) return {ok:false, err:'内容太大，不像是进度码。'};
    let raw = null;
    if (text.charAt(0) === '{'){
      try { raw = JSON.parse(text); } catch(e){ return {ok:false, err:'文件读不出来，可能不完整。'}; }
    } else {
      const i = text.indexOf(PREFIX);
      if (i < 0) return {ok:false, err:'没有找到进度码。完整的进度码以 WK1. 开头。'};
      const rest = text.slice(i + PREFIX.length);
      const run = rest.match(/^[A-Za-z0-9+\/=_\-\s]*/)[0];
      const cands = [run.replace(/\s+/g, ''), (run.trim().split(/\s+/)[0] || '')];
      for (let k = 0; k < cands.length && raw === null; k++){
        try { raw = JSON.parse(b64d(cands[k].replace(/-/g, '+').replace(/_/g, '/'))); } catch(e){ raw = null; }
      }
      if (raw === null) return {ok:false, err:'进度码读不出来，可能复制得不完整，请整串重新复制。'};
    }
    if (!raw || typeof raw !== 'object' || raw.app !== 'waikan' || !raw.data || typeof raw.data !== 'object' || Array.isArray(raw.data))
      return {ok:false, err:'这不是本站导出的进度。'};
    const data = {};
    Object.keys(raw.data).forEach(function(k){
      const v = raw.data[k];
      if (KEEP.test(k) && k !== WHO_KEY && v && typeof v === 'object' && !Array.isArray(v)) data[k] = v;
    });
    if (!Object.keys(data).length) return {ok:false, err:'这份进度里没有可导入的内容。'};
    return {ok:true, name:cleanName(raw.name), data:data};
  }
  function uiClean(d){
    const o = {};
    if (d && typeof d === 'object') Object.keys(d).forEach(function(k){
      const v = d[k];
      if (k !== '__proto__' && (typeof v === 'boolean' || (typeof v === 'number' && isFinite(v)) || (typeof v === 'string' && v.length <= 40))) o[k] = v;
    });
    return o;
  }
  /* merge parsed.data into learner id. {words: words in the imported schedule, articles: article states merged} */
  function mergeData(id, data){
    const out = {words:0, articles:0};
    Object.keys(data).forEach(function(k){
      const cur = readKey(k, id);
      let next;
      if (k === SRS_KEY){ next = srsMerge(cur, data[k]); out.words = Object.keys(srsClean(data[k]).w).length; }
      else if (UI_KEYS.indexOf(k) >= 0) next = Object.assign(uiClean(data[k]), uiClean(cur));
      else { next = stateMerge(cur, data[k]); out.articles++; }
      try { localStorage.setItem(k + '@' + id, JSON.stringify(next)); } catch(e){}
    });
    return out;
  }

  /* ---- what a learner has done so far, for the picker ---- */
  function agoText(t){
    const a = new Date(t), n = new Date();
    const d = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(a.getFullYear(), a.getMonth(), a.getDate())) / DAY);
    return d <= 0 ? '今天' : d === 1 ? '昨天' : d + ' 天前';
  }
  function summary(id){
    const s = srsClean(readKey(SRS_KEY, id));
    let last = 0, mastered = 0;
    Object.keys(s.w).forEach(function(k){ if (s.w[k].l > last) last = s.w[k].l; });
    keysOf(id).forEach(function(k){
      if (k === SRS_KEY || UI_KEYS.indexOf(k) >= 0) return;
      const st = stateClean(readKey(k, id));
      Object.keys(st.vocab).forEach(function(v){ if (st.vocab[v].s === 'mastered') mastered++; });
    });
    const bits = [];
    if (mastered) bits.push('已掌握 ' + mastered + ' 个词');
    const n = Object.keys(s.w).length;
    if (n) bits.push('复习计划 ' + n + ' 个词');
    if (last) bits.push('上次学习：' + agoText(last));
    /* no-break spaces inside a part: the line may only wrap between the parts */
    return bits.length ? bits.map(function(b){ return b.replace(/ /g, '\u00a0'); }).join(' · ') : '还没开始学';
  }

  /* ---------------- interface ---------------- */
  function initial(name){ const c = Array.from(name || '?')[0] || '?'; return c.toUpperCase(); }
  function avatar(name, big){ return h('span', {class:'who-av' + (big ? ' lg' : ''), 'aria-hidden':'true'}, initial(name)); }
  function copyText(ta){
    function legacy(){ try { return Promise.resolve(!!document.execCommand('copy')); } catch(e){ return Promise.resolve(false); } }
    ta.focus(); ta.select();
    try { ta.setSelectionRange(0, ta.value.length); } catch(e){}
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(ta.value).then(function(){ return true; }, legacy);
    return legacy();
  }
  function saveFile(name, text){
    try {
      const url = URL.createObjectURL(new Blob([text], {type:'application/json'}));
      const a = h('a', {href:url, download:name});
      document.body.append(a); a.click(); a.remove();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
      return true;
    } catch(e){ return false; }
  }
  /* replaceChildren that skips the null / false entries of a conditional list (they would otherwise be written as the text "null") */
  function put(el, kids){ el.replaceChildren.apply(el, kids.filter(function(k){ return k != null && k !== false; })); }
  function lock(on){ try { document.documentElement.style.overflow = on ? 'hidden' : ''; } catch(e){} }
  function msgEl(){ return h('p', {class:'who-msg', 'aria-live':'polite'}); }
  function say(el, text, kind){ el.className = 'who-msg' + (kind ? ' ' + kind : ''); el.textContent = text; }

  /* paste area + file picker + button; apply(parsed) -> {ok, msg, done?} */
  function importForm(apply){
    const ta = h('textarea', {class:'who-ta', placeholder:'把进度码粘贴到这里（以 WK1. 开头）', 'aria-label':'进度码', spellcheck:'false', autocomplete:'off', autocapitalize:'off'});
    const msg = msgEl();
    const file = h('input', {type:'file', accept:'.json,.txt,text/plain,application/json', hidden:true});
    file.addEventListener('change', function(){
      const f = file.files && file.files[0];
      if (!f) return;
      if (f.size > MAXLEN){ say(msg, '文件太大，不像是进度文件。', 'err'); return; }
      const r = new FileReader();
      r.onload = function(){ ta.value = String(r.result || ''); say(msg, '文件已读入，点“导入”。', ''); };
      r.onerror = function(){ say(msg, '文件读取失败。', 'err'); };
      r.readAsText(f);
      file.value = '';
    });
    const go = h('button', {type:'button', class:'who-btn pri'}, '导入');
    go.addEventListener('click', function(){
      const p = parse(ta.value);
      if (!p.ok){ say(msg, p.err, 'err'); return; }
      const r = apply(p);
      say(msg, r.msg, r.ok ? 'ok' : 'err');
      if (r.ok) go.disabled = true;
    });
    return {ta:ta, node:h('div', null, ta, h('div', {class:'who-row'}, go, h('button', {type:'button', class:'who-btn', onclick:function(){ file.click(); }}, '选择文件')), msg, file)};
  }
  function importMsg(p, r, name){
    return '已把' + (p.name ? '「' + p.name + '」的' : '') + '进度合并到「' + name + '」：复习计划 ' + r.words + ' 个词，' + r.articles + ' 篇文章。正在刷新……';
  }

  /* the picker shown instead of the page while nobody has been chosen */
  function gate(){
    const reg = whoReg();
    const err = h('p', {class:'who-msg err', role:'alert'});
    const input = h('input', {class:'who-in', type:'text', maxlength:16, placeholder:'你的名字或昵称', autocomplete:'off', autocapitalize:'off', 'aria-label':'名字'});
    const card = h('div', {class:'who-card'});
    const ov = h('div', {class:'who-ov', role:'dialog', 'aria-modal':'true', 'aria-label':'选择学习者'}, card);
    function enter(r){ if (!r.ok){ say(err, r.err, 'err'); return; } location.reload(); }
    function main(){
      const people = reg.list.slice().sort(function(a, b){ return (b.u || 0) - (a.u || 0); });
      const form = h('form', {class:'who-new', onsubmit:function(e){ e.preventDefault(); enter(create(input.value)); }}, input, h('button', {type:'submit', class:'who-btn pri'}, '进入'));
      put(card, [
        h('p', {class:'who-eb'}, 'DAILY CLOSE READING'),
        h('h1', {class:'who-h'}, '外刊精读合集'),
        h('p', {class:'who-sub'}, people.length ? '选你的名字继续学。每个人的进度分开保存。' : '先写一个名字，你的生词、自测和复习进度会存在这个名字下。'),
        people.length ? h('p', {class:'who-sec'}, '这台设备上的学习者') : null,
        people.length ? h('ul', {class:'who-list'}, people.map(function(p){
          return h('li', null, h('button', {type:'button', class:'who-p', onclick:function(){ enter(select(p.id) ? {ok:true} : {ok:false, err:'没能切换，请刷新后重试。'}); }},
            avatar(p.name, true), h('span', null, h('span', {class:'who-pn'}, p.name), h('span', {class:'who-pm'}, summary(p.id)))));
        })) : null,
        h('p', {class:'who-sec'}, people.length ? '换一个人，或新建' : '你的名字'),
        form, err,
        !people.length && legacyKeys().length ? h('p', {class:'who-note'}, '这台设备上已经有一份学习进度，建好名字后它会自动归到这个名字下。') : null,
        h('button', {type:'button', class:'who-link', onclick:importView}, '已有进度码？导入进度'),
        h('p', {class:'who-note'}, '名字只用来把进度分开，不是密码，这台设备上的人都能切换。进度存在这台设备的浏览器里：换手机或清理浏览器数据前，请在右上角头像里“导出进度”备份。')]);
      setTimeout(function(){ try { input.focus({preventScroll:true}); } catch(e){} }, 0);
    }
    function importView(){
      const f = importForm(function(p){
        const r = create(p.name || '我');
        if (!r.ok) return {ok:false, msg:r.err};
        const m = mergeData(r.id, p.data);
        setTimeout(function(){ location.reload(); }, 1300);
        return {ok:true, msg:importMsg(p, m, r.name)};
      });
      put(card, [
        h('p', {class:'who-eb'}, '导入进度'),
        h('h1', {class:'who-h sm'}, '用进度码找回你的进度'),
        h('p', {class:'who-sub'}, '在旧设备上点右上角头像，选“导出进度”，复制进度码（或保存文件），再粘贴到这里。会按进度码里的名字新建账号；这个名字已存在就合并进去。'),
        f.node,
        h('button', {type:'button', class:'who-link', onclick:main}, '‹ 返回')]);
    }
    main();
    lock(true);
    document.body.append(ov);
  }

  /* the sheet behind the account chip */
  function menu(){
    const cur = current();
    if (!cur) return;
    const prev = document.activeElement;
    const card = h('div', {class:'who-card'});
    const ov = h('div', {class:'who-ov sheet', role:'dialog', 'aria-modal':'true', 'aria-label':'账号和进度'}, card);
    function close(){ document.removeEventListener('keydown', onKey); ov.remove(); lock(false); if (prev && prev.focus) prev.focus(); }
    function onKey(e){ if (e.key === 'Escape') close(); }
    ov.addEventListener('click', function(e){ if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey);
    function show(kids){
      put(card, [h('button', {type:'button', class:'who-x', 'aria-label':'关闭', onclick:close}, '×')].concat(kids));
    }
    function mi(t, d, fn, danger){
      return h('button', {type:'button', class:'who-mi' + (danger ? ' dng' : ''), onclick:fn}, h('b', null, t), h('span', null, d));
    }
    function back(){ return h('button', {type:'button', class:'who-link', onclick:home}, '‹ 返回'); }
    function home(){
      show([
        h('div', {class:'who-top'}, avatar(cur.name, true), h('div', null, h('h2', {class:'who-h sm'}, cur.name), h('p', {class:'who-pm'}, summary(cur.id)))),
        h('div', {class:'who-menu'},
          mi('切换账号', '换一个名字，或给另一个人新建账号。', function(){ leave(); location.reload(); }),
          mi('导出进度（备份）', '生成进度码。换手机、清理浏览器数据之前先存一份。', exportView),
          mi('导入进度', '把另一台设备或备份里的进度合并进来。', importView),
          mi('删除这个账号', '只删除这台设备上的这份进度，不影响其他设备。', removeView, true)),
        h('p', {class:'who-note'}, '进度只存在这台设备的浏览器里，不会自动同步到别的设备；要换设备，用“导出进度”和“导入进度”。')]);
    }
    function exportView(){
      const b = bundle(cur.id);
      const ta = h('textarea', {class:'who-ta', readonly:true, 'aria-label':'进度码', spellcheck:'false'});
      ta.value = toCode(b);
      ta.addEventListener('focus', function(){ ta.select(); });
      const msg = msgEl();
      const fname = 'waikan-' + cur.name.replace(/[\\\/:*?"<>|\s]+/g, '_') + '-' + today() + '.json';
      show([
        h('h2', {class:'who-h sm'}, '导出进度'),
        h('p', {class:'who-sub'}, '把这串进度码复制下来，发给自己（比如微信文件传输助手）。在新设备上打开本站，选“已有进度码？导入进度”粘贴即可。'),
        ta,
        h('div', {class:'who-row'},
          h('button', {type:'button', class:'who-btn pri', onclick:function(){ copyText(ta).then(function(ok){ say(msg, ok ? '已复制。' : '没能自动复制，请长按进度码全选后手动复制。', ok ? 'ok' : 'err'); }); }}, '复制进度码'),
          h('button', {type:'button', class:'who-btn', onclick:function(){ say(msg, saveFile(fname, JSON.stringify(b)) ? '已生成文件。' : '这个浏览器不支持保存文件，请用进度码。', ''); }}, '保存为文件')),
        msg, back()]);
    }
    function importView(){
      const f = importForm(function(p){
        const m = mergeData(cur.id, p.data);
        setTimeout(function(){ location.reload(); }, 1300);
        return {ok:true, msg:importMsg(p, m, cur.name)};
      });
      show([
        h('h2', {class:'who-h sm'}, '导入进度'),
        h('p', {class:'who-sub'}, '粘贴进度码（或选导出的文件）。会合并到「' + cur.name + '」：同一个词两边都学过，保留更新的那次；不会覆盖你现在的进度。'),
        f.node, back()]);
    }
    function removeView(){
      show([
        h('h2', {class:'who-h sm'}, '删除「' + cur.name + '」？'),
        h('p', {class:'who-sub'}, '这台设备上这个名字的全部进度（生词状态、造句、自测成绩、复习计划）都会删除，无法恢复。建议先导出进度备份。'),
        h('div', {class:'who-row'},
          h('button', {type:'button', class:'who-btn', onclick:exportView}, '先导出备份'),
          h('button', {type:'button', class:'who-btn dng', onclick:function(){ remove(cur.id); location.reload(); }}, '确认删除')),
        back()]);
    }
    lock(true);
    document.body.append(ov);
    home();
  }

  /* put the account chip into mount; mode 'full' shows the name, 'tiny' only the initial */
  function chip(mount, mode){
    const cur = current();
    if (!cur || !mount) return;
    const b = h('button', {type:'button', class:'who-chip ' + (mode || 'full'), 'aria-label':'当前账号：' + cur.name + '，点击管理账号和进度', title:cur.name},
      avatar(cur.name), mode === 'tiny' ? null : h('span', {class:'who-nm'}, cur.name));
    b.addEventListener('click', menu);
    mount.replaceChildren(b);
  }

  /* call first thing in a page's script: false = the picker is showing, the page must not start */
  function boot(){
    if (!ready()){ gate(); return false; }
    window.addEventListener('storage', function(e){ if (e.key === WHO_KEY && whoReg().cur !== WHO_ID) location.reload(); });
    return true;
  }

  return {boot:boot, ready:ready, canStore:canStore, gate:gate, menu:menu, chip:chip, list:list, current:current, create:create, select:select, leave:leave, remove:remove,
    keysOf:keysOf, legacyKeys:legacyKeys, bundle:bundle, toCode:toCode, parse:parse, mergeData:mergeData, summary:summary, cleanName:cleanName};
})();
