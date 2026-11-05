/* ---------- quiz kit: one renderer per question type, shared by the reader and the review page ----------
   Kit.make(item, o) returns the question card (a DOM element).
     item = {type, key, id, v, k, dir, clips}
        type   'mcq' | 'cloze' | 'exs' | 'zh' | 'dict' | 'sent'
        key    "<slug>:<word id>" (the spaced-repetition key)       id  the word id within its article
        v      the word: {id, expr, zh, core, forms, syn, note, m, ctx, ex:[{en, zh}], cloze:{before, ans, after, hint, szh}}
        k      which example sentence (exs, sent, dict); dict: -1 = the word itself
        dir    mcq only: 'e2z' (English expression -> pick the meaning) or 'z2e' (meaning -> pick the expression)
        sent   dict only: {en, zh, src, t} a sentence of the article instead of a word (then v and key may be null)
        clips  {src, t:{key:[start, end]}} or null (no audio for this article)
     o = {index, total, last, tag, label (replaces the type name in the header),
          defer (dict only: no feedback, the answer goes straight to onAnswer + onNext),
          hideTarget (sent only: do not say which expression to use; a hint button reveals it),
          pool()            -> [{expr, zh}] words that may serve as wrong options (mcq)
          extra(item, res)  -> a node shown at the bottom of the feedback (or null)
          onAnswer(res)     the answer is in (res.ok may still flip once through the "my answer is fine" button)
          onChange(res)     optional: res.ok was flipped by that button
          isLast()          optional: is this the last question? (read when the button label is set; `last` is the static version)
          onNext()          the learner pressed "next"}
   res = {id, key, type, ok, given, k}.
   Kit.freeze(card) -> a read-only copy of an answered card (what was typed or picked, and the feedback);
   Kit.pager(box, hist, live, o) puts the live card in box with "‹ 上一题" to look back through hist (frozen cards);
   live = null browses hist alone (after the last question), o.close = back to the results. */
const Kit = (function(){
  const TYPE_NAME = {mcq:'选择题', cloze:'文章填空', exs:'例句填空', zh:'中译' + XS + '词汇', dict:'听写', sent:'中译' + XS + '整句'};
  const UNIT = LANG === 'ko' ? ' 个字' : ' 个字母';
  const ONES = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
  const TENS = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];

  function markTerms(text, terms){
    const ts = (terms || []).slice().sort(function(a, b){ return b.length - a.length; });
    if (!ts.length) return [document.createTextNode(text)];
    const re = termRe(ts, 'gi');
    const out = [];
    let last = 0, m;
    while ((m = re.exec(text))){
      if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
      out.push(h('mark', {class:'vw'}, m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(document.createTextNode(text.slice(last)));
    return out;
  }
  /* an example sentence as a cloze: the [[target]] becomes the blank */
  function exCloze(v, k){
    const x = v.ex[k];
    const m = /^([\s\S]*?)\[\[(.+?)\]\]([\s\S]*)$/.exec(x.en);
    return {before:m[1], ans:m[2], after:m[3].replace(/\[\[|\]\]/g, ''), hint:v.zh, szh:x.zh};
  }
  function numWords(n){
    if (n < 20) return ONES[n];
    if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
    return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + numWords(n % 100) : '');
  }
  /* 2019 -> twenty nineteen, 1984 -> nineteen eighty four (the way a speaker reads a year) */
  function yearWords(t){
    if (!/^\d{4}$/.test(t)) return null;
    const n = Number(t);
    if (!((n >= 1100 && n <= 1999) || (n >= 2010 && n <= 2099)) || n % 100 < 10) return null;
    return numWords(Math.floor(n / 100)).split(' ').concat(numWords(n % 100).split(' '));
  }
  /* words of a sentence for comparing dictation: no case, no punctuation, no apostrophes, small numbers spelled out */
  function toks(s){
    const out = [];
    String(s).toLowerCase().replace(/[’‘']/g, '').split(/[^a-z0-9\uac00-\ud7a3]+/).forEach(function(t){
      if (!t) return;
      if (/^\d{1,3}$/.test(t)) numWords(Number(t)).split(' ').forEach(function(w){ out.push(w); });
      else if (yearWords(t)) yearWords(t).forEach(function(w){ out.push(w); });
      else out.push(t);
    });
    return out;
  }
  function lcsHits(a, b){
    const n = a.length, m = b.length;
    const dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ha = new Array(n).fill(false), hb = new Array(m).fill(false);
    let i = 0, j = 0;
    while (i < n && j < m){
      if (a[i] === b[j]){ ha[i] = hb[j] = true; i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    return {ha:ha, hb:hb};
  }
  /* the text with the words that are not in `hits` underlined */
  function chunkDiff(text, hits){
    const out = [];
    let pos = 0;
    text.split(/\s+/).filter(Boolean).forEach(function(chunk){
      const n = toks(chunk).length;
      let miss = false;
      for (let k = 0; k < n; k++) if (!hits[pos + k]) miss = true;
      pos += n;
      if (out.length) out.push(' ');
      out.push(miss ? h('span', {class:'miss-t'}, chunk) : chunk);
    });
    return out;
  }

  /* ---- pieces every question uses ---- */
  function head(o, type){
    const bar = h('div', {class:'pbar'}, h('i'));
    bar.style.setProperty('--p', (o.index / o.total * 100) + '%');
    return h('div', {class:'q-head'}, h('span', {class:'eyebrow'}, '第 ' + (o.index + 1) + ' 题 / ' + o.total + '　' + (o.label || TYPE_NAME[type]) + (o.tag ? '　' + o.tag : '')), bar);
  }
  function inputAttrs(extra){
    return Object.assign({type:'text', id:'q-input', autocomplete:'off', autocapitalize:'off', autocorrect:'off', spellcheck:'false'}, extra);
  }
  function nextLabel(o){ return (o.isLast ? o.isLast() : o.last) ? '看成绩' : '下一题'; }
  function speakLine(item, v){
    return h('p', null, clipBtn(item.clips, 'w' + v.id, v.core), item.clips ? ' ' : null, h('b', null, v.expr), '　', v.zh);
  }
  function extraBox(item, res, o){
    const box = h('div', {class:'fb-x'});
    box.refresh = function(){
      box.replaceChildren();
      const n = o.extra ? o.extra(item, res) : null;
      if (n) box.append(n);
    };
    return box;
  }
  function newRes(item, type){ return {id:item.id, key:item.key || null, type:type, ok:false, given:'', k:item.k}; }

  /* ---- fill the blank: the sentence is the article's (cloze) or one of the word's examples (exs) ---- */
  function clozeQ(item, o, c, type){
    const v = item.v, res = newRes(item, type);
    const inp = h('input', inputAttrs({class:'q-input', 'aria-label':'填入缺失的单词'}));
    inp.style.width = Math.max(6, c.ans.length + 2) + 'ch';
    const fb = h('div', {class:'fb', hidden:true, 'aria-live':'polite'});
    const main = h('button', {type:'button', class:'btn pri'}, '检查');
    const peek = h('button', {type:'button', class:'btn'}, '提示首字母');
    const ex = extraBox(item, res, o);
    let checked = false;
    const card = h('div', {class:'card'},
      head(o, type),
      h('p', {class:'q-sent'}, c.before, inp, c.after),
      h('p', {class:'q-hint'}, c.hint + '　', h('span', {class:'mono'}, c.ans.length + UNIT)),
      fb,
      h('div', {class:'row'}, main, peek)
    );
    peek.addEventListener('click', function(){ inp.placeholder = c.ans.charAt(0); inp.focus(); });
    function check(){
      const val = norm(inp.value);
      if (!val){ inp.focus(); return; }
      const ok = val === norm(c.ans);
      checked = true;
      res.ok = ok; res.given = inp.value.trim();
      o.onAnswer(res);
      inp.readOnly = true;
      inp.classList.add(ok ? 'ok' : 'bad');
      fb.className = 'fb ' + (ok ? 'ok' : 'bad');
      fb.hidden = false;
      fb.replaceChildren(
        h('p', {class:'fb-t'}, ok ? '正确' : ['不对，答案是 ', h('b', null, c.ans)]),
        h('p', null, c.szh),
        speakLine(item, v),
        ex
      );
      ex.refresh();
      peek.hidden = true;
      main.textContent = nextLabel(o);
      main.focus();
    }
    main.addEventListener('click', function(){ if (checked) o.onNext(); else check(); });
    inp.addEventListener('keydown', function(e){ if (e.key === 'Enter'){ e.preventDefault(); main.click(); } });
    return card;
  }

  /* ---- Chinese -> the English expression, typed ---- */
  function zhQ(item, o){
    const v = item.v, res = newRes(item, 'zh');
    const words = v.core.split(' ');
    const inp = h('input', inputAttrs({class:'q-input q-wide', 'aria-label':'写出对应的' + XL + '表达'}));
    const fb = h('div', {class:'fb', hidden:true, 'aria-live':'polite'});
    const main = h('button', {type:'button', class:'btn pri'}, '检查');
    const peek = h('button', {type:'button', class:'btn'}, '提示首字母');
    const ex = extraBox(item, res, o);
    let checked = false;
    const card = h('div', {class:'card'},
      head(o, 'zh'),
      h('p', {class:'q-zh'}, v.zh),
      h('p', {class:'q-line'}, inp),
      h('p', {class:'q-hint'}, words.length + ' 个词：', h('span', {class:'mono'}, words.map(function(w){ return w.length; }).join(' + ') + UNIT)),
      fb,
      h('div', {class:'row'}, main, peek)
    );
    peek.addEventListener('click', function(){ inp.placeholder = v.core.charAt(0) + '…'; inp.focus(); });
    function check(){
      const val = norm(inp.value);
      if (!val){ inp.focus(); return; }
      const own = v.forms.map(norm).indexOf(val) >= 0;
      const ok = own || v.syn.map(norm).indexOf(val) >= 0;
      checked = true;
      res.ok = ok; res.given = inp.value.trim();
      o.onAnswer(res);
      inp.readOnly = true;
      inp.classList.add(ok ? 'ok' : 'bad');
      fb.className = 'fb ' + (ok ? 'ok' : 'bad');
      fb.hidden = false;
      const headP = h('p', {class:'fb-t'}, ok ? '正确' : ['不对，参考答案是 ', h('b', null, v.expr)]);
      const kids = [headP];
      if (ok && !own) kids.push(h('p', null, '你写的是近义表达，文章里用的是 ', h('b', null, v.core), '。'));
      if (!ok){
        const alt = h('button', {type:'button', class:'btn sm'}, '我写的也对（近义词）');
        alt.addEventListener('click', function(){
          res.ok = true;
          fb.className = 'fb ok';
          inp.classList.remove('bad'); inp.classList.add('ok');
          headP.replaceChildren('已按你的判断算对。参考答案是 ', h('b', null, v.expr));
          alt.remove();
          ex.refresh();
          if (o.onChange) o.onChange(res);
          main.textContent = nextLabel(o);
          main.focus();
        });
        kids.push(h('div', {class:'fb-s'}, alt));
      }
      kids.push(speakLine(item, v));
      kids.push(h('p', {class:'w-ctx'}, markTerms(v.ctx, v.m)));
      kids.push(ex);
      fb.replaceChildren.apply(fb, kids);
      ex.refresh();
      peek.hidden = true;
      main.textContent = nextLabel(o);
      main.focus();
    }
    main.addEventListener('click', function(){ if (checked) o.onNext(); else check(); });
    inp.addEventListener('keydown', function(e){ if (e.key === 'Enter'){ e.preventDefault(); main.click(); } });
    return card;
  }

  /* ---- Chinese sentence -> the whole English sentence, graded by the learner ---- */
  function sentRe(v){
    const alts = v.forms.map(function(f){
      return f.toLowerCase().split(/[^a-z\uac00-\ud7a3]+/).filter(Boolean).map(esc).join('[^A-Za-z\\uac00-\\ud7a3]+');
    });
    return new RegExp('(?:^|[^A-Za-z\\uac00-\\ud7a3])(?:' + alts.join('|') + ')(?![A-Za-z])', 'i');
  }
  function sentQ(item, o){
    const v = item.v, x = v.ex[item.k], res = newRes(item, 'sent');
    const hide = !!o.hideTarget;
    const ta = h('textarea', inputAttrs({class:'q-area', rows:3, maxlength:400, placeholder:'把这句话写成' + XL, 'aria-label':'写出整句' + XL}));
    const hintP = h('p', {class:'q-hint'});
    const fb = h('div', {class:'fb', hidden:true, 'aria-live':'polite'});
    const main = h('button', {type:'button', class:'btn pri'}, '核对');
    const peek = h('button', {type:'button', class:'btn'}, hide ? '提示：要用的表达' : '提示：这个表达的意思');
    const ex = extraBox(item, res, o);
    let stage = 0;      /* 0 writing, 1 compared with the reference, 2 graded */
    const card = h('div', {class:'card'},
      head(o, 'sent'),
      h('p', {class:'q-zh'}, x.zh),
      hide ? h('p', {class:'q-tgt'}, h('span', {class:'meta'}, '翻译成' + XL + '，用上一个学过的表达。'))
           : h('p', {class:'q-tgt'}, h('span', {class:'meta'}, '请用上'), h('b', null, v.expr)),
      hintP,
      ta,
      fb,
      h('div', {class:'row'}, main, peek)
    );
    peek.addEventListener('click', function(){ hintP.textContent = v.expr + '：' + v.zh; peek.hidden = true; ta.focus(); });
    function check(){
      const val = ta.value.trim();
      if (!val){ ta.focus(); return; }
      const used = sentRe(v).test(val);
      ta.readOnly = true;
      fb.className = 'fb ' + (used ? 'ok' : 'bad');
      fb.hidden = false;
      const verdict = h('p', {class:'fb-t'}, '对照参考句，自己判断：时态、搭配、拼写有没有问题。意思对、表达自然就算写对。');
      const gradeRow = h('div', {class:'row'},
        h('button', {type:'button', class:'btn pri', onclick:function(){ grade(true); }}, '我写对了'),
        h('button', {type:'button', class:'btn', onclick:function(){ grade(false); }}, '还要再练'));
      function grade(ok){
        res.ok = ok; res.given = ta.value.trim();
        o.onAnswer(res);
        stage = 2;
        fb.className = 'fb ' + (ok ? 'ok' : 'bad');
        verdict.textContent = ok ? '你判定：写对了' : '你判定：还要再练';
        gradeRow.replaceWith(ex);
        ex.refresh();
        main.textContent = nextLabel(o);
        main.hidden = false;
        main.focus();
      }
      fb.replaceChildren(
        h('p', {class:'fb-t'}, used ? '用到了 ' + v.expr : '没看到 ' + v.expr + '（词形变化也算）'),
        h('p', null, clipBtn(item.clips, 'e' + v.id + '_' + item.k, exPlain(x.en)), item.clips ? ' ' : null, '参考句：', exNodes(x.en)),
        hide ? h('p', {class:'meta'}, v.expr + '：' + v.zh) : '',
        verdict,
        gradeRow
      );
      stage = 1;
      main.hidden = true;
      peek.hidden = true;
    }
    main.addEventListener('click', function(){ if (stage === 2) o.onNext(); else if (stage === 0) check(); });
    ta.addEventListener('keydown', function(e){ if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); main.click(); } });
    return card;
  }

  /* ---- multiple choice: meaning of an expression (e2z), or the expression for a meaning (z2e) ---- */
  function mcqQ(item, o){
    const v = item.v, res = newRes(item, 'mcq');
    const dir = item.dir === 'z2e' ? 'z2e' : 'e2z';
    const right = dir === 'e2z' ? v.zh : v.expr;
    const seen = {};
    seen[right] = true;
    const wrong = [];
    shuffle((o.pool ? o.pool() : []).slice()).forEach(function(p){
      const t = dir === 'e2z' ? p.zh : p.expr;
      if (t && !seen[t] && wrong.length < 3){ seen[t] = true; wrong.push(t); }
    });
    const texts = shuffle([right].concat(wrong));
    const ex = extraBox(item, res, o);
    const fb = h('div', {class:'fb', hidden:true, 'aria-live':'polite'});
    const main = h('button', {type:'button', class:'btn pri', hidden:true}, nextLabel(o));
    let answered = false;
    const btns = texts.map(function(t, i){
      return h('button', {type:'button', class:'mc-b', onclick:function(){ pick(i); }}, h('span', {class:'n'}, String(i + 1)), h('span', null, t));
    });
    const ask = dir === 'e2z'
      ? [h('p', {class:'q-ask'}, '这个表达在句子里是什么意思？'),
         h('p', {class:'q-big'}, v.expr, item.clips ? ' ' : null, clipBtn(item.clips, 'w' + v.id, v.core)),
         h('p', {class:'q-ctx'}, markTerms(v.ctx, v.m))]
      : [h('p', {class:'q-ask'}, '选出对应的' + XL + '表达'),
         h('p', {class:'q-zh'}, v.zh)];
    const card = h('div', {class:'card'},
      head(o, 'mcq'),
      ask,
      h('div', {class:'mc', role:'group', 'aria-label':'选项'}, btns),
      fb,
      h('div', {class:'row'}, main)
    );
    function pick(i){
      if (answered) return;
      answered = true;
      const ok = texts[i] === right;
      res.ok = ok; res.given = texts[i];
      o.onAnswer(res);
      btns.forEach(function(b, j){
        b.disabled = true;
        if (texts[j] === right) b.classList.add('ok');
        else if (j === i) b.classList.add('bad');
      });
      fb.className = 'fb ' + (ok ? 'ok' : 'bad');
      fb.hidden = false;
      const kids = [h('p', {class:'fb-t'}, ok ? '正确' : ['不对，答案是 ', h('b', null, right)]), speakLine(item, v)];
      if (v.note) kids.push(h('p', {class:'w-note'}, v.note));
      kids.push(h('p', {class:'w-ctx'}, markTerms(v.ctx, v.m)));
      kids.push(ex);
      fb.replaceChildren.apply(fb, kids);
      ex.refresh();
      main.textContent = nextLabel(o);
      main.hidden = false;
      main.focus();
    }
    main.addEventListener('click', function(){ o.onNext(); });
    function onKey(e){
      if (!card.isConnected){ document.removeEventListener('keydown', onKey); return; }
      if (card.offsetParent === null) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const n = Number(e.key);
      if (!answered && n >= 1 && n <= btns.length){ e.preventDefault(); pick(n - 1); }
    }
    document.addEventListener('keydown', onKey);
    return card;
  }

  /* ---- dictation: listen, then type a word, an example sentence, or (item.sent) a sentence of the article ----
     item.sent = {en, zh, src, t}: the sentence and where its audio is.   o.defer: no feedback after the answer, the
     host shows everything at the end (listening exam); the answer is passed on through onAnswer + onNext. */
  function dictQ(item, o){
    const v = item.v, S = item.sent, res = newRes(item, 'dict');
    const isWord = !S && (item.k == null || item.k < 0);
    const x = !S && !isWord ? v.ex[item.k] : null;
    const ref = S ? S.en : isWord ? v.core : exPlain(x.en);
    const zhText = S ? S.zh : isWord ? v.zh : x.zh;
    const key = S ? null : isWord ? 'w' + v.id : 'e' + v.id + '_' + item.k;
    const src = S ? S.src : item.clips ? item.clips.src : null;
    const clipT = S ? S.t : item.clips && key ? item.clips.t[key] : null;
    res.ref = ref; res.zh = zhText; res.src = src; res.t = clipT; res.kind = S ? 's' : isWord ? 'w' : 'e';
    const defer = !!o.defer;
    const playB = h('button', {type:'button', class:'btn pri play'}, '播放');
    const slowB = h('button', {type:'button', class:'btn play'}, '慢速播放');
    playB.insertAdjacentHTML('afterbegin', SPK_SVG);
    playB.addEventListener('click', function(){ Clip.play(src, clipT, playB, ref, 1); });
    slowB.addEventListener('click', function(){ Clip.play(src, clipT, slowB, ref, 0.7); });
    const field = isWord
      ? h('input', inputAttrs({class:'q-input q-wide', 'aria-label':'写出听到的表达'}))
      : h('textarea', inputAttrs({class:'q-area', rows:3, maxlength:500, placeholder:'把听到的整句写下来', 'aria-label':'写出听到的整句'}));
    const hintP = h('p', {class:'q-hint'}, isWord ? '一个' + XL + '表达，写法要和听到的一致。' : (LANG === 'ko' ? '标点和空格不影响判分。' : '大小写和标点不影响判分，数字写 30 或 thirty 都行。') + (defer ? '' : '电脑上按 Ctrl+Enter 提交。'));
    const fb = h('div', {class:'fb', hidden:true, 'aria-live':'polite'});
    const lastQ = function(){ return o.isLast ? o.isLast() : !!o.last; };
    const main = h('button', {type:'button', class:'btn pri'}, defer ? (lastQ() ? '交卷' : '提交，下一题') : '检查');
    const peek = defer ? null : h('button', {type:'button', class:'btn'}, '提示：中文意思');
    const ex = extraBox(item, res, o);
    let checked = false;
    const card = h('div', {class:'card'},
      head(o, 'dict'),
      h('p', {class:'q-ask'}, isWord ? '听发音，写出这个表达。' : '听一句话，把整句写下来。'),
      h('div', {class:'dict-btns'}, playB, slowB),
      isWord ? h('p', {class:'q-line'}, field) : field,
      hintP,
      fb,
      h('div', {class:'row'}, main, peek)
    );
    if (peek) peek.addEventListener('click', function(){ hintP.textContent = '意思：' + zhText; peek.hidden = true; field.focus(); });
    function check(){
      const val = field.value.trim();
      if (!norm(val) && !/\d/.test(val)){ field.focus(); return; }
      let ok, diffKids = [];
      if (isWord){
        ok = v.forms.map(norm).indexOf(norm(val)) >= 0;
      } else {
        const a = toks(ref), b = toks(val), d = lcsHits(a, b);
        ok = a.length === b.length && d.ha.every(Boolean);
        if (!ok) diffKids = [
          h('p', {class:'df'}, h('span', {class:'df-l'}, '标准答案（有出入的词划了线）'), chunkDiff(ref, d.ha)),
          h('p', {class:'df'}, h('span', {class:'df-l'}, '你写的'), chunkDiff(val, d.hb))
        ];
      }
      checked = true;
      res.ok = ok; res.given = val;
      o.onAnswer(res);
      if (defer){ o.onNext(); return; }
      field.readOnly = true;
      if (isWord) field.classList.add(ok ? 'ok' : 'bad');
      fb.className = 'fb ' + (ok ? 'ok' : 'bad');
      fb.hidden = false;
      const headP = h('p', {class:'fb-t'}, ok ? '正确' : (isWord ? ['不对，听到的是 ', h('b', null, v.expr)] : '有出入，对照一下'));
      const kids = [headP];
      if (!ok){
        kids.push.apply(kids, diffKids);
        const alt = h('button', {type:'button', class:'btn sm'}, '只是小失误，算我对');
        alt.addEventListener('click', function(){
          res.ok = true;
          fb.className = 'fb ok';
          if (isWord){ field.classList.remove('bad'); field.classList.add('ok'); }
          headP.replaceChildren('已按你的判断算对。');
          alt.remove();
          ex.refresh();
          if (o.onChange) o.onChange(res);
          main.textContent = nextLabel(o);
          main.focus();
        });
        kids.push(h('div', {class:'fb-s'}, alt));
      }
      if (isWord) kids.push(speakLine(item, v));
      else if (S){
        const sb = spkEl('播放这一句', function(){ Clip.play(src, clipT, sb, ref, 1); });
        kids.push(h('p', null, sb, ' ', ref), h('p', {class:'meta'}, zhText));
      } else kids.push(h('p', null, clipBtn(item.clips, key, ref), item.clips ? ' ' : null, exNodes(x.en)), h('p', {class:'meta'}, x.zh));
      kids.push(ex);
      fb.replaceChildren.apply(fb, kids);
      ex.refresh();
      if (peek) peek.hidden = true;
      main.textContent = nextLabel(o);
      main.focus();
    }
    main.addEventListener('click', function(){ if (checked) o.onNext(); else check(); });
    field.addEventListener('keydown', function(e){
      if (e.key === 'Enter' && (isWord || e.ctrlKey || e.metaKey)){ e.preventDefault(); main.click(); }
    });
    /* play once as soon as the question appears (this runs inside the click that opened it, so browsers allow it) */
    if (o.autoplay !== false) Clip.play(src, clipT, playB, ref, 1);
    return card;
  }

  function make(item, o){
    switch (item.type){
      case 'cloze': return clozeQ(item, o, item.v.cloze, 'cloze');
      case 'exs': return clozeQ(item, o, exCloze(item.v, item.k), 'exs');
      case 'zh': return zhQ(item, o);
      case 'sent': return sentQ(item, o);
      case 'mcq': return mcqQ(item, o);
      case 'dict': return dictQ(item, o);
    }
    throw new Error('unknown question type ' + item.type);
  }
  /* ---- looking back at answered questions ---- */
  function freeze(card){
    const c = card.cloneNode(true);           /* inputs and textareas keep what was typed */
    c.classList.add('q-past');
    $$(':scope > .row', c).forEach(function(r){ r.hidden = true; });
    $$('[id]', c).forEach(function(el){ el.removeAttribute('id'); });
    $$('button', c).forEach(function(b){ b.disabled = true; });
    $$('input, textarea', c).forEach(function(f){ f.readOnly = true; });
    return c;
  }
  function pager(box, hist, live, o){
    let pos = live ? hist.length : 0;
    const prev = h('button', {type:'button', class:'btn sm'}, '‹ 上一题');
    const nxt = h('button', {type:'button', class:'btn sm'}, '下一题 ›');
    const lab = h('span', {class:'meta'});
    const back = live ? h('button', {type:'button', class:'btn sm pri'}, '回到当前题')
      : h('button', {type:'button', class:'btn sm pri', onclick:function(){ if (o && o.close) o.close(); }}, '返回成绩');
    const bar = h('div', {class:'q-nav'}, prev, nxt, lab, back);
    const liveBox = h('div', null, live);
    const past = h('div');
    function show(){
      const atLive = !!live && pos === hist.length;
      liveBox.hidden = !atLive;
      past.replaceChildren();
      if (!atLive) past.append(hist[pos]);
      prev.disabled = pos === 0;
      nxt.hidden = atLive;
      nxt.disabled = !live && pos >= hist.length - 1;
      back.hidden = atLive;
      lab.textContent = atLive ? '' : '第 ' + (pos + 1) + ' 题（已作答，只能查看）';
      bar.hidden = atLive && !hist.length;
      if (atLive) focus(live);
    }
    prev.addEventListener('click', function(){ if (pos > 0){ pos--; show(); } });
    nxt.addEventListener('click', function(){ pos++; show(); });
    if (live) back.addEventListener('click', function(){ pos = hist.length; show(); });
    box.replaceChildren(bar, liveBox, past);
    show();
  }
  function focus(card){
    const f = $('#q-input', card);
    if (f) f.focus({preventScroll:true});
  }
  /* which question to ask a word that is on step b of the ladder: recognise -> fill in -> spell -> hear -> write */
  function typeForStage(b, hasClips){
    if (b <= 0) return {type:'mcq', dir:'e2z'};
    if (b === 1) return {type:'mcq', dir:'z2e'};
    if (b === 2) return {type:'exs'};
    if (b === 3) return {type:'cloze'};
    if (b <= 5) return {type:'zh'};
    if (b <= 7) return hasClips ? {type:'dict'} : {type:'zh'};
    return {type:'sent'};
  }
  return {TYPE_NAME:TYPE_NAME, make:make, focus:focus, freeze:freeze, pager:pager, markTerms:markTerms, exCloze:exCloze, toks:toks, lcsHits:lcsHits, chunkDiff:chunkDiff, typeForStage:typeForStage};
})();
