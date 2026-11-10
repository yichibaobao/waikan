/* ---------- speaker buttons and the clip player (inlined by tools/build.py) ----------
   A "clip" is a slice [start, end] of an MP3 sprite (clips.mp3 of one article). One Audio element per sprite file;
   only one clip plays at a time. If the sprite is missing or fails to load, the browser's own speech synthesis reads the text. */
const SPK_SVG = '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 4V5L7 9H3z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
function spkEl(label, onclick){
  const b = h('button', {type:'button', class:'spk', 'aria-label':label, title:label, onclick:onclick});
  b.innerHTML = SPK_SVG;
  return b;
}
const Clip = (function(){
  /* tok: which play() the timer belongs to; ready: the jump to the clip's start has happened (until then currentTime may still
     report the old position, and a clip later in the file than the new one would look finished at once) */
  const st = {a:null, start:0, end:0, btn:null, timer:0, text:'', tok:0, ready:false, t0:0};
  const audios = {};
  let beforePlay = null;
  function done(){
    clearTimeout(st.timer);
    st.tok++;
    if (st.btn){ st.btn.classList.remove('on'); st.btn = null; }
  }
  function fallback(text){
    try {
      if (!('speechSynthesis' in window) || !text) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = {en:'en-GB', ko:'ko-KR', ja:'ja-JP', yue:'zh-HK'}[LANG]; u.rate = 0.9;
      speechSynthesis.speak(u);
    } catch(e){}
  }
  function audio(src){
    if (audios[src]) return audios[src];
    const a = new Audio();
    a.preload = 'auto';
    a.src = src;
    a.addEventListener('error', function(){ if (st.a === a){ const t = st.text; done(); fallback(t); } });
    a.addEventListener('ended', function(){ if (st.a === a) done(); });
    a.addEventListener('pause', function(){ if (st.a === a && st.ready && a.currentTime < st.end) done(); });
    audios[src] = a;
    return a;
  }
  /* a timer rather than requestAnimationFrame: it keeps running when the page is in the background */
  function tick(tok){
    if (tok !== st.tok) return;
    const a = st.a;
    if (!a) return;
    const c = a.currentTime;
    /* some browsers skip 'seeked'; a position inside the clip (or a long wait) also means the jump is done */
    if (!st.ready && !a.seeking && ((c >= st.start - 0.05 && c < st.end) || Date.now() - st.t0 > 1500)) st.ready = true;
    if (st.ready && (c >= st.end || a.ended)){ a.pause(); done(); return; }
    if (st.ready && a.paused) return;
    st.timer = setTimeout(function(){ tick(tok); }, 30);
  }
  /* play one clip; clicking the same button again stops it. rate: 1 (default) or e.g. 0.7 */
  function play(src, t, btn, text, rate){
    if (!t || !src){ if (beforePlay) beforePlay(); done(); fallback(text); return; }
    if (beforePlay) beforePlay();
    const a = audio(src);
    const wasOn = !!btn && st.btn === btn && st.a === a && !a.paused;
    done();
    if (st.a && st.a !== a && !st.a.paused) st.a.pause();
    if (wasOn){ a.pause(); return; }
    st.a = a; st.btn = btn || null; st.text = text;
    st.end = t[1] + 0.15;
    const tok = st.tok;
    st.ready = false; st.t0 = Date.now();
    if (btn) btn.classList.add('on');
    a.playbackRate = rate || 1;
    try { a.preservesPitch = true; a.webkitPreservesPitch = true; } catch(e){}
    const start = st.start = Math.max(0, t[0] - 0.1);
    const go = function(){
      a.addEventListener('seeked', function(){ if (tok === st.tok) st.ready = true; }, {once:true});
      a.currentTime = start;
    };
    if (a.readyState >= 1) go(); else a.addEventListener('loadedmetadata', go, {once:true});
    const pr = a.play();
    if (pr && pr.catch) pr.catch(function(){ if (tok === st.tok) done(); });
    tick(tok);
  }
  function stop(){
    if (st.a && !st.a.paused) st.a.pause();
    done();
  }
  return {play:play, stop:stop, onBeforePlay:function(fn){ beforePlay = fn; }};
})();
/* speaker button for one word / example of an article: clips = {src, t:{key:[start,end]}} */
function clipBtn(clips, key, text){
  if (!clips) return null;
  const b = spkEl('播放发音', function(){ Clip.play(clips.src, clips.t[key], b, text); });
  return b;
}
