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
  const st = {a:null, end:0, btn:null, raf:0, text:''};
  const audios = {};
  let beforePlay = null;
  function done(){
    cancelAnimationFrame(st.raf);
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
    a.addEventListener('pause', function(){ if (st.a === a && a.currentTime < st.end) done(); });
    audios[src] = a;
    return a;
  }
  function tick(){
    const a = st.a;
    if (!a || a.paused) return;
    if (a.currentTime >= st.end){ a.pause(); done(); return; }
    st.raf = requestAnimationFrame(tick);
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
    if (btn) btn.classList.add('on');
    a.playbackRate = rate || 1;
    try { a.preservesPitch = true; a.webkitPreservesPitch = true; } catch(e){}
    const start = Math.max(0, t[0] - 0.1);
    const go = function(){ a.currentTime = start; };
    if (a.readyState >= 1) go(); else a.addEventListener('loadedmetadata', go, {once:true});
    const pr = a.play();
    if (pr && pr.catch) pr.catch(function(){ done(); });
    cancelAnimationFrame(st.raf);
    st.raf = requestAnimationFrame(tick);
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
