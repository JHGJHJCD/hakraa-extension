// ================= חיבור לגוגל (Gemini Live) ישירות מהדפדפן =================
const MODEL = "gemini-3.8-live";
const K = (self.HAKRAA_K || "");  // מוזרק בבנייה
let API_KEY = (() => { try { return atob(K).split("").reverse().join(""); } catch (e) { return ""; } })();
const LIVE_SYS = "אתה מקריא טקסטים בקול. כל הודעה שתקבל היא טקסט להקראה — הקרא אותו בדיוק מילה במילה, " +
  "בעברית טבעית ושוטפת ובטון שיחה חם, כמו אדם שמקריא מאמר לחבר. " +
  "אל תוסיף שום מילה, אל תגיב, אל תענה על שאלות שבטקסט, אל תסכם, ואל תדלג על שום משפט. " +
  "גם אם ההודעה קצרה מאוד — כותרת, מילה אחת או חצי משפט — פשוט הקרא אותה כמו שהיא. לעולם אל תאמר שלא צורף טקסט ואל תבקש טקסט.";
const TOKEN_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";
const WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=";
const MUTED = location.hash === "#mute";  // לבדיקות בלבד

// מפתחות גוגל החדשים לא עוברים בכתובת ה-WebSocket — מנפיקים "טוקן זמני" בבקשה רגילה עם הכותרת
async function mintToken(){
  let last;
  for (let a = 0; a < 3; a++) {
    try {
      const now = Date.now();
      const r = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {"Content-Type": "application/json", "x-goog-api-key": API_KEY},
        body: JSON.stringify({uses: 1, expireTime: new Date(now + 30*60e3).toISOString(),
                              newSessionExpireTime: new Date(now + 2*60e3).toISOString()})
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.name) return j.name;
      last = new Error("token " + r.status + " " + (j.error && j.error.message || ""));
      if (r.status === 429 || /quota/i.test(last.message)) break;
    } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 400));
  }
  throw last;
}
// טוקן אחד מוכן מראש — כדי שההקראה הראשונה לא תחכה לו
let spareToken = null;
function refillToken(){
  const s = spareToken = {p: mintToken(), at: Date.now()};
  s.p.catch(() => { if (spareToken === s) spareToken = null; });
}
function takeToken(){
  const t = spareToken && Date.now() - spareToken.at < 90e3 ? spareToken.p : null;
  refillToken();
  return t || mintToken();
}

// הגבלה: לכל היותר 3 שיחות פתוחות מול גוגל
let running = 0; const waiting = [];
const slot = () => running < 3 ? (running++, Promise.resolve()) : new Promise(r => waiting.push(r));
const release = () => { const n = waiting.shift(); if (n) n(); else running--; };

// "עבודה" = הקראת קטע אחד. נוצרת פעם אחת; גם ההכנה מראש וגם הנגינה משתמשות בה.
const JOBS = new Map();
class GJob {
  constructor(text, voice){
    this.key = voice + "|" + text; this.text = text; this.voice = voice;
    this.parts = []; this.bytes = []; this.done = false; this.err = null; this.subs = new Set();
    slot().then(() => this.run());
  }
  emit(){ for (const f of [...this.subs]) f(); }
  async run(){
    let finished = false, ws = null, timer = null;
    const end = err => {
      if (finished) return; finished = true; clearTimeout(timer); release();
      if (err && !this.parts.length) this.err = err;
      this.done = true; try { ws && ws.close(); } catch (e) {}
      if (this.err) JOBS.delete(this.key);
      this.emit();
    };
    let token;
    try { token = await takeToken(); } catch (e) { return end(e); }
    timer = setTimeout(() => end(new Error("timeout")), 180e3);
    ws = new WebSocket(WS_URL + token);
    ws.binaryType = "arraybuffer";
    const dec = new TextDecoder();
    ws.onopen = () => ws.send(JSON.stringify({setup: {
      model: "models/" + MODEL,
      generationConfig: {responseModalities: ["AUDIO"],
        speechConfig: {voiceConfig: {prebuiltVoiceConfig: {voiceName: this.voice}}}},
      systemInstruction: {parts: [{text: LIVE_SYS}]}
    }}));
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : dec.decode(ev.data)); } catch (e) { return; }
      if (m.setupComplete) ws.send(JSON.stringify({clientContent: {
        turns: [{role: "user", parts: [{text: this.text}]}], turnComplete: true}}));
      const sc = m.serverContent;
      if (sc && sc.modelTurn && sc.modelTurn.parts)
        for (const p of sc.modelTurn.parts) if (p.inlineData && p.inlineData.data) this.push(p.inlineData.data);
      if (sc && sc.turnComplete) end();
    };
    ws.onerror = () => {};
    ws.onclose = ev => end(new Error("סגירה " + ev.code + " " + (ev.reason || "")));
  }
  push(b64){
    const bin = atob(b64), n = bin.length >> 1;
    const u8 = new Uint8Array(n * 2);
    for (let i = 0; i < n * 2; i++) u8[i] = bin.charCodeAt(i);
    const i16 = new Int16Array(u8.buffer), f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = i16[i] / 32768;
    this.bytes.push(u8); this.parts.push(f); this.emit();
  }
  wavUrl(){
    if (this._url) return this._url;
    const len = this.bytes.reduce((a, b) => a + b.length, 0);
    const h = new DataView(new ArrayBuffer(44));
    const s = (o, t) => { for (let i = 0; i < 4; i++) h.setUint8(o + i, t.charCodeAt(i)); };
    s(0, "RIFF"); h.setUint32(4, 36 + len, true); s(8, "WAVE"); s(12, "fmt ");
    h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
    h.setUint32(24, 24000, true); h.setUint32(28, 48000, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
    s(36, "data"); h.setUint32(40, len, true);
    return this._url = URL.createObjectURL(new Blob([h, ...this.bytes], {type: "audio/wav"}));
  }
}
function getJob(text, voice){
  const key = voice + "|" + text;
  let j = JOBS.get(key);
  if (!j) {
    j = new GJob(text, voice); JOBS.set(key, j);
    for (const k of [...JOBS.keys()].slice(0, -30)) if (JOBS.get(k).done) JOBS.delete(k);
  }
  return j;
}

// ================= קולות =================
const VOICES = {gf: ["Sulafat", "f"], gf2: ["Aoede", "f"], gm: ["Achird", "m"], gm2: ["Charon", "m"]};
let googleDownUntil = 0;
const selVoice = () => $("voice").value;
const useGoogle = () => !!VOICES[selVoice()] && Date.now() >= googleDownUntil && !!API_KEY;
const gender = () => VOICES[selVoice()] ? VOICES[selVoice()][1] : selVoice();
const chunkMax = () => useGoogle() ? 700 : 280;

// קול המחשב (גיבוי): מעדיפים את הקולות הטבעיים של מיקרוסופט (הילה/אברי) שיש בדפדפן Edge
function pickVoice(en){
  const all = speechSynthesis.getVoices();
  const langOk = v => en ? /^en/i.test(v.lang) : /^(he|iw)/i.test(v.lang);
  const list = all.filter(langOk);
  if (!list.length) return null;
  const want = gender() === "m" ? (en ? /guy|andrew|christopher|david|male/i : /avri|asaf|male/i)
                                : (en ? /jenny|aria|zira|female/i : /hila|female/i);
  const score = v => (want.test(v.name) ? 2 : 0) + (/natural|online/i.test(v.name) ? 1 : 0);
  return list.sort((a, b) => score(b) - score(a))[0];
}
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => {};

function googleFailed(err){
  if (Date.now() < googleDownUntil) return;
  const msg = String(err && err.message || err);
  const daily = /quota|exceeded|1011|429/i.test(msg);
  googleDownUntil = Date.now() + (daily ? 10 * 60 : 60) * 1000;
  console.warn("google failed:", msg);
  $("note").textContent = daily ? "⚠ הגעת למכסה של גוגל — ממשיך בקול המחשב, וינסה שוב את גוגל בעוד 10 דקות"
                                : "⚠ הקול של גוגל לא זמין כרגע — ממשיך בינתיים בקול המחשב (ינסה שוב בעוד דקה)";
}

// ================= כללי =================
const $ = id => document.getElementById(id);
const txt = $("txt"), reader = $("reader"), statusEl = $("status");
const audio = new Audio();
audio.muted = MUTED;

let chunks = [], idx = 0;
let playing = false, active = false;
let mode = "";          // "audio" | "stream" | "tts"
let playToken = 0;

const store = {
  get(k, d){ try{ const v = localStorage.getItem("hakraa_"+k); return v===null? d : JSON.parse(v);}catch(e){return d;} },
  set(k, v){ try{ localStorage.setItem("hakraa_"+k, JSON.stringify(v)); }catch(e){} }
};
txt.value = store.get("text", "");
$("voice").value = store.get("voice2", "gf");
$("rate").value = store.get("rate", 0);
updateRateLbl();

// ---------- חלוקה למשפטים ----------
// ---------- ניקוי טקסט (Markdown, ציורי קווים, אימוג'י, הפניות) ----------
// טקסט שהועתק מצ'אט מגיע עם סימני עיצוב ושרטוטים. המודל של גוגל "מתבלבל" מהם:
// מדלג שורות, או עונה "לא צירפת טקסט" על קטע שיש בו רק סמלים.
function cleanText(s){
  s = s.replace(/\r/g, "")
    .replace(/\(\s*(\[[^\]]*\]\[[^\]]*\]\s*)+\)/g, "")          // ([Home Assistant][1])
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")                    // [טקסט][1]
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")                   // [טקסט](קישור)
    .replace(/^\s*\[[^\]]+\]:.*$/gm, "")                         // [1]: https://...
    .replace(/https?:\/\/\S+/g, "");
  const out = [];
  let inCode = false;
  for (let line of s.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { inCode = !inCode; out.push(""); continue; }
    if (/^\s*([-*_=]\s*){3,}$/.test(line)) { out.push(""); continue; }  // קו מפריד
    line = line
      .replace(/[\p{Extended_Pictographic}\u200D\uFE0F\u20E3]/gu, " ")  // אימוג'י
      .replace(/[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF]/g, " ")        // קווים, חיצים ▼
      .replace(/\s*[\u2190-\u21FF\u27F0-\u27FF\u2900-\u297F]\s*/g, ", ") // חיצים → ←
      .replace(/^\s{0,3}#{1,6}\s*/, "")                                  // כותרות
      .replace(/^\s*>+\s?/, "")                                          // ציטוט
      .replace(/^\s*[-*+•]\s+/, "")                                      // תבליט
      .replace(/(\*\*|__|\*|`)/g, "")                                    // מודגש/נטוי/קוד
      .replace(/\s*\|\s*/g, ", ");                                       // טבלה / "A | B"
    if (inCode) {
      // שרטוט: רק המילים נשארות, מופרדות בפסיקים
      line = line.replace(/[\\/]/g, " ").replace(/(^|\s)[xX](?=\s|$)/g, " ");
      line = line.split(/\s{2,}|,\s*/).map(w => w.trim()).filter(w => /\p{L}/u.test(w)).join(", ");
    }
    line = line.replace(/\s+/g, " ").replace(/^[\s,]+|[\s,]+$/g, "").trim();
    if (!/\p{L}/u.test(line)) { out.push(""); continue; }  // שורה בלי אף אות — לא מקריאים
    // שורה בלי סימן סוף (כותרת / פריט ברשימה / שורה בשרטוט) — מוסיפים נקודה, כדי שלא תתחבר לבאה
    if (!/[.!?׃:;…,"'״”’)\]]$/.test(line)) line += ".";
    out.push(line);
  }
  return out.join("\n");
}

function splitText(s){
  s = cleanText(s).replace(/[ \t]+/g, " ").trim();
  const parts = [];
  let carry = "";  // קטע בלי אותיות (למשל "1.") מוצמד לבא — לבד המודל עונה "לא צורף טקסט"
  for (const para of s.split(/\n+/)) {
    const p = para.trim(); if (!p) continue;
    // חותכים רק בסימן סוף שאחריו רווח — כך "USB 2.0" ו-"3.x" לא נחתכים באמצע
    for (let t of p.split(/(?<=[.!?׃:;…]["'״”’)\]]*)\s+/)) {
      t = t.trim(); if (!t) continue;
      if (!/\p{L}{2}/u.test(t)) { carry = carry ? carry + " " + t : t; continue; }
      parts.push(carry ? carry + " " + t : t); carry = "";
    }
  }
  if (carry) { if (parts.length) parts[parts.length-1] += " " + carry; else parts.push(carry); }
  const out = [];
  for (const t of parts) {
    if (t.length <= 260) { out.push(t); continue; }
    let buf = "";
    for (const piece of t.split(/(?<=[,،])\s+/)) {
      if ((buf + " " + piece).length > 220 && buf) { out.push(buf.trim()); buf = piece; }
      else buf = buf ? buf + " " + piece : piece;
    }
    if (buf) out.push(buf.trim());
  }
  const merged = [];
  for (const t of out) {
    const last = merged[merged.length-1];
    const ok = merged.length === 1 ? last.length < 15 : (last + " " + t).length <= chunkMax();
    // שפה שונה = קטע נפרד (קול אנגלי) — רק כשזה קטע אנגלי של ממש, לא מונח קצר כמו "Coordinator" בתוך מאמר עברי
    const sameLang = last && isEnglish(last) === isEnglish(t) || t.length < 60 || (last && isEnglish(last) && last.length < 60);
    if (last && sameLang && ok) merged[merged.length-1] = last + " " + t;
    else merged.push(t);
  }
  if (merged.length && merged[0].length > 90) {
    const f = merged[0];
    let cut = f.slice(40, 90).search(/[,،]\s/);
    cut = cut >= 0 ? 40 + cut + 1 : f.indexOf(" ", 70);
    if (cut > 0) merged.splice(0, 1, f.slice(0, cut).trim(), f.slice(cut).trim());
  }
  return merged;
}
function isEnglish(t){
  const he = (t.match(/[֐-׿]/g)||[]).length;
  const en = (t.match(/[A-Za-z]/g)||[]).length;
  return en > he * 2 && en > 3;
}
function rateVal(){ return parseInt($("rate").value, 10); }

function prefetch(from){
  if (!useGoogle()) return;
  for (let j = from; j < Math.min(chunks.length, from + 2); j++) getJob(chunks[j].text, VOICES[selVoice()][0]);
}

// ---------- תצוגה ----------
function buildReader(){
  reader.innerHTML = "";
  chunks.forEach((c, i) => {
    const sp = document.createElement("span");
    sp.textContent = c.text + " ";
    sp.onclick = () => jump(i);
    c.el = sp; reader.appendChild(sp);
  });
}
function showReader(on){
  reader.style.display = on ? "block" : "none";
  $("editBox").style.display = on ? "none" : "block";
}
function mark(){
  chunks.forEach((c, i) => { c.el.classList.toggle("cur", i === idx); c.el.classList.toggle("done", i < idx); });
  const cur = chunks[idx];
  if (cur) {
    const r = cur.el.getBoundingClientRect(), rr = reader.getBoundingClientRect();
    if (r.top < rr.top || r.bottom > rr.bottom) cur.el.scrollIntoView({block: "center", behavior: "smooth"});
  }
  $("prog").style.width = chunks.length ? (idx / chunks.length * 100) + "%" : "0";
}
function setStatus(s){ statusEl.textContent = s; }
function updateButtons(){
  $("btnPlay").textContent = !active ? "▶ הקרא" : (playing ? "⏸ השהה" : "▶ המשך");
  $("btnStop").disabled = $("btnPrev").disabled = $("btnNext").disabled = !active;
}

// ---------- ניגון ----------
let actx = null, streamGain = null, streamUnsub = null;
function ensureCtx(){
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)({sampleRate: 24000});
  return actx;
}
function stopOutputs(){
  audio.pause();
  if (streamUnsub) { streamUnsub(); streamUnsub = null; }
  if (streamGain) { try { streamGain.disconnect(); } catch (e) {} streamGain = null; }
  if (window.speechSynthesis) speechSynthesis.cancel();
}

// קול גוגל שעוד נוצר — מנגנים כל חתיכה ברגע שהיא מגיעה
function playStream(job, token){
  const ctx = ensureCtx(); ctx.resume();
  const g = ctx.createGain(); g.gain.value = MUTED ? 0 : 1; g.connect(ctx.destination); streamGain = g;
  let pos = 0, t = ctx.currentTime + 0.3, last = null, closed = false;
  const pump = () => {
    if (token !== playToken || closed) return;
    while (pos < job.parts.length) {
      const f = job.parts[pos++];
      const b = ctx.createBuffer(1, f.length, 24000); b.copyToChannel(f, 0);
      const s = ctx.createBufferSource(); s.buffer = b; s.connect(g);
      if (t < ctx.currentTime + 0.02) t = ctx.currentTime + 0.15;
      s.start(t); t += b.duration; last = s;
    }
    if (job.done) {
      closed = true; job.subs.delete(pump);
      if (job.err) { googleFailed(job.err); playFrom(idx); return; }
      if (last) last.onended = () => { if (token === playToken && playing) playFrom(idx + 1); };
      else playFrom(idx + 1);
    }
  };
  job.subs.add(pump);
  streamUnsub = () => job.subs.delete(pump);
  pump();
}

function playTTS(i, token){
  if (!window.speechSynthesis) { setStatus("⚠ אין בדפדפן הזה קול מחשב. נסה לפתוח את הקובץ ב-Microsoft Edge."); return; }
  const t = chunks[i].text, en = isEnglish(t);
  const u = new SpeechSynthesisUtterance(t);
  u.lang = en ? "en-US" : "he-IL";
  const v = pickVoice(en);
  if (v) u.voice = v;
  else if (!en) setStatus("⚠ אין קול עברי במחשב הזה — פתח את הקובץ ב-Microsoft Edge");
  u.rate = 1 + rateVal() / 100;
  u.volume = MUTED ? 0 : 1;
  u.onend = () => { if (token === playToken && playing) playFrom(i + 1); };
  u.onerror = e => { if (e.error === "not-allowed" && token === playToken) { stop(); setStatus("לחץ ▶ כדי להתחיל"); } };
  speechSynthesis.speak(u);
}

async function playFrom(i){
  if (i < 0) i = 0;
  if (i >= chunks.length) { finish(); return; }
  const token = ++playToken;
  stopOutputs();
  idx = i; store.set("pos", idx);
  playing = true; active = true; updateButtons(); mark();
  if (useGoogle()) {
    const job = getJob(chunks[i].text, VOICES[selVoice()][0]);
    prefetch(i + 1);
    if (job.done && job.err) { googleFailed(job.err); return playFrom(i); }
    if (job.done) {
      mode = "audio"; audio.src = job.wavUrl(); applyRate();
      try { await audio.play(); } catch (e) { if (e.name === "NotAllowedError") setStatus("לחץ ▶ כדי להתחיל"); }
    } else {
      mode = "stream"; setStatus("טוען…"); playStream(job, token);
    }
    if (token !== playToken) return;
    setStatus(`קטע ${idx+1} מתוך ${chunks.length} · קול גוגל`);
    $("note").textContent = "";
  } else {
    mode = "tts"; playTTS(i, token);
    setStatus(`קטע ${idx+1} מתוך ${chunks.length} · קול המחשב`);
  }
}

// מהירות בקול גוגל = מהירות הנגן (בלי לשנות את גובה הקול)
function applyRate(){ audio.preservesPitch = true; audio.playbackRate = 1 + rateVal() / 100; }

audio.addEventListener("ended", () => { if (playing && mode === "audio") playFrom(idx + 1); });

function finish(){
  playToken++; playing = false; active = false; idx = 0; store.set("pos", 0);
  updateButtons(); mark(); $("prog").style.width = "100%";
  setStatus("✔ ההקראה הסתיימה");
}
function start(fromIdx){
  const s = txt.value.trim();
  if (!s) { setStatus("אין טקסט להקראה — הדבק מאמר קודם."); return; }
  store.set("text", txt.value);
  const nc = splitText(s).map(t => ({text: t}));
  const same = nc.length === chunks.length && nc.every((c,i)=>c.text===chunks[i].text);
  if (!same) { chunks = nc; buildReader(); }
  showReader(true);
  ensureCtx().resume();
  playFrom(fromIdx ?? 0);
}
function togglePlay(){
  if (!active) { start(0); return; }
  if (playing) {
    playing = false;
    if (mode === "audio") audio.pause();
    else if (mode === "stream" && actx) actx.suspend();
    else if (mode === "tts") speechSynthesis.pause();
    setStatus("מושהה");
  } else {
    playing = true;
    if (mode === "audio" && audio.src && !audio.ended && audio.currentTime > 0) audio.play();
    else if (mode === "stream" && actx) actx.resume();
    else if (mode === "tts" && speechSynthesis.paused) speechSynthesis.resume();
    else playFrom(idx);
    setStatus(`קטע ${idx+1} מתוך ${chunks.length}`);
  }
  updateButtons();
}
function stop(){
  playToken++; playing = false; active = false; stopOutputs();
  if (actx) actx.resume();
  updateButtons(); setStatus("נעצר");
}
function jump(i){
  if (!chunks.length) return;
  playFrom(Math.max(0, Math.min(chunks.length - 1, i)));
}

// ---------- כפתורים ----------
$("btnPlay").onclick = togglePlay;
$("btnStop").onclick = stop;
$("btnPrev").onclick = () => jump(idx - 1);
$("btnNext").onclick = () => jump(idx + 1);
$("btnEdit").onclick = () => { stop(); showReader(false); txt.focus(); };
$("btnPaste").onclick = async () => {
  ensureCtx().resume();
  try {
    const t = await navigator.clipboard.readText();
    if (t && t.trim()) txt.value = t;
  } catch (e) { /* אין הרשאה ללוח — משתמשים במה שבתיבה */ }
  stop(); start(0);
};
// מתחילים להכין את תחילת הקול כבר כשמדביקים
let warmTimer;
txt.addEventListener("input", () => {
  store.set("text", txt.value);
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    if (active || !txt.value.trim()) return;
    chunks = splitText(txt.value).map(t => ({text: t})); buildReader(); prefetch(0);
  }, 300);
});

function updateRateLbl(){ $("rateLbl").textContent = "×" + (1 + rateVal()/100).toFixed(2).replace(/0$/,""); }
function settingsChanged(){
  store.set("voice2", $("voice").value); store.set("rate", rateVal()); updateRateLbl();
  if (this === $("rate")) {
    if (mode === "audio") applyRate();
    else if (mode === "tts" && active && playing) playFrom(idx);
    return;
  }
  if (chunks.length) {
    // גודל הקטעים שונה בין הקולות — לחלק מחדש ולהמשיך מאותו מקום בטקסט
    const offset = chunks.slice(0, idx).reduce((a, c) => a + c.text.length + 1, 0);
    chunks = splitText(txt.value).map(t => ({text: t})); buildReader();
    let acc = 0, ni = 0;
    while (ni < chunks.length - 1 && acc + chunks[ni].text.length < offset) { acc += chunks[ni].text.length + 1; ni++; }
    idx = ni; if (active) mark();
  }
  if (active && playing) playFrom(idx); else if (active) prefetch(idx);
}
$("voice").onchange = settingsChanged;
$("rate").onchange = settingsChanged;
$("rate").oninput = updateRateLbl;

document.addEventListener("keydown", e => {
  if (e.target === txt || e.target.id === "keyInput") return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (e.code === "ArrowRight" && active) { e.preventDefault(); jump(idx - 1); }
  else if (e.code === "ArrowLeft" && active) { e.preventDefault(); jump(idx + 1); }
  else if (e.code === "Escape") stop();
});
if ("mediaSession" in navigator) {
  navigator.mediaSession.metadata = new MediaMetadata({title: "הקראה"});
  navigator.mediaSession.setActionHandler("play", () => { if (!playing) togglePlay(); });
  navigator.mediaSession.setActionHandler("pause", () => { if (playing) togglePlay(); });
  navigator.mediaSession.setActionHandler("previoustrack", () => jump(idx - 1));
  navigator.mediaSession.setActionHandler("nexttrack", () => jump(idx + 1));
}

// ================= תוסף דפדפן =================
// אותו קוד רץ גם כתוסף (build_extension.py): הטקסט מגיע מהדף שסומן, דרך chrome.storage.session
const EXT = typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id);
let lastPending = 0;
async function takePending(){
  const {pending} = await chrome.storage.session.get("pending");
  if (!pending || pending.t === lastPending) return;
  lastPending = pending.t;
  await chrome.storage.session.remove("pending");
  txt.value = pending.text;
  stop(); start(0);
  // אם הדפדפן לא מרשה להשמיע בלי לחיצה — מחכים ללחיצה במקום "לנגן" בשקט
  setTimeout(() => {
    if (mode !== "tts" && actx && actx.state !== "running") { stop(); setStatus("לחץ ▶ כדי להתחיל"); }
  }, 800);
}
async function initExt(){
  const st = await chrome.storage.local.get("apiKey");
  if (st.apiKey) API_KEY = st.apiKey;
  $("keyBox").style.display = "block";
  const state = () => { $("keyState").textContent = API_KEY ? "" : " — כדי לשמוע את הקול הטבעי של גוגל צריך להזין מפתח"; };
  state();
  $("keyToggle").onclick = () => { const f = $("keyForm"); f.style.display = f.style.display === "none" ? "block" : "none"; };
  $("keySave").onclick = async () => {
    const v = $("keyInput").value.trim();
    if (!v) return;
    await chrome.storage.local.set({apiKey: v});
    API_KEY = v; googleDownUntil = 0; $("keyInput").value = ""; $("keyForm").style.display = "none";
    $("voice").value = "gf"; store.set("voice2", "gf"); state(); refillToken();
    setStatus("✔ המפתח נשמר");
  };
  chrome.storage.onChanged.addListener((c, area) => { if (area === "session" && c.pending && c.pending.newValue) takePending(); });
}

function boot(){
  if (!API_KEY) $("voice").value = "f";
  else refillToken();  // להכין טוקן ראשון כבר עכשיו
  updateButtons();
}
if (EXT) initExt().then(() => { boot(); takePending(); });
else boot();
