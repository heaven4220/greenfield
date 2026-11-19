/* ============================================================
   GREENFIELD — 운영용 클라이언트
   인증: Supabase Auth (이메일 확인)
   쓰기: 전부 RPC (핸디·승인·확정은 서버 계산)
   ============================================================ */
const PAR = [4,4,5,3,4,4,3,5,4, 4,3,4,4,5,4,3,5,4];
const CKEY = 'gf.cloud.v2';
const LS = { get(k){ try{return localStorage.getItem(k);}catch(e){return null;} },
             set(k,v){ try{localStorage.setItem(k,v);}catch(e){} },
             del(k){ try{localStorage.removeItem(k);}catch(e){} } };
const $ = (s,r=document)=>r.querySelector(s);
const fmt = n => (Math.round(Number(n)*10)/10).toFixed(1);
const GT = { A:'~10', B:'11–18', C:'19–27', D:'28~' };

function gradeOf(h){ const n=Math.round(Number(h)); return n<=10?'A':n<=18?'B':n<=27?'C':'D'; }
function nextGradeInfo(h){
  h=Number(h); const g=gradeOf(h);
  if(g==='A') return {next:'A',need:0,pct:100,top:true};
  const ceil={B:10.5,C:18.5,D:27.5}[g], floor={B:18.5,C:27.5,D:36.5}[g];
  return { next:{B:'A',C:'B',D:'C'}[g], need:Math.max(0,h-ceil),
           pct:Math.max(4,Math.min(100,(floor-h)/(floor-ceil)*100)) };
}

const A = {
  tab:'home', view:'lobby', cfg:null, sb:null, session:null, profile:null,
  round:null, players:[], scores:[], logs:[], rank:[], rankGrade:null,
  sel:1, busy:false, err:'', authMode:'login', emailSent:false, sum:null,
  conn:'', confirming:false
};

let tTimer;
function toast(m){
  const el=$('#toast'); if(!el) return;
  el.textContent=m; el.classList.add('on');
  clearTimeout(tTimer); tTimer=setTimeout(()=>el.classList.remove('on'),2800);
}

/* ---------------- 인증 ---------------- */
function authMsg(m){
  const s=(m||'').toLowerCase();
  if(s.includes('invalid login')) return '이메일 또는 비밀번호가 맞지 않습니다.';
  if(s.includes('email not confirmed')) return '이메일 인증이 아직 완료되지 않았습니다. 받은 메일의 링크를 눌러주세요.';
  if(s.includes('already registered')) return '이미 가입된 이메일입니다. 로그인해 주세요.';
  if(s.includes('password should be')) return '비밀번호는 6자 이상이어야 합니다.';
  if(s.includes('rate limit')) return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  return m || '오류가 발생했습니다.';
}
async function doAuth(){
  const email=($('#a-email').value||'').trim();
  const pw=($('#a-pw').value||'');
  A.err='';
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { A.err='이메일 형식을 확인해 주세요.'; render(); return; }
  if(pw.length<6) { A.err='비밀번호는 6자 이상이어야 합니다.'; render(); return; }
  A.busy=true; render();
  try{
    if(A.authMode==='signup'){
      const { data, error } = await A.sb.auth.signUp({ email, password:pw });
      if(error) throw error;
      if(!data.session){ A.emailSent=true; A.emailUsed=email; }
      else { A.session=data.session; await loadProfile(); }
    } else {
      const { data, error } = await A.sb.auth.signInWithPassword({ email, password:pw });
      if(error) throw error;
      A.session=data.session; await loadProfile();
    }
  } catch(e){ A.err=authMsg(e.message); }
  A.busy=false; render();
}
async function loadProfile(){
  if(!A.sb || !A.session) return;
  const { data } = await A.sb.from('gf_profiles').select('*').eq('id',A.session.user.id).maybeSingle();
  A.profile = data || null;
  if(A.profile) await loadHistory();
}
async function loadHistory(){
  const { data } = await A.sb.from('gf_round_results')
    .select('gross,diff,created_at,round_id,gf_rounds(course,code,confirmed_at)')
    .eq('user_id', A.session.user.id).order('created_at',{ascending:false}).limit(6);
  A.logs = data || [];
}
async function createProfile(){
  const name=($('#o-name').value||'').trim();
  const region=$('#o-region').value;
  const hcp=parseFloat($('#o-hcp').value);
  A.err='';
  if(name.length<2){ A.err='이름을 2자 이상 입력해 주세요.'; render(); return; }
  if(!(hcp>=0 && hcp<=54)){ A.err='핸디는 0~54 사이로 입력해 주세요.'; render(); return; }
  A.busy=true; render();
  const { error } = await A.sb.from('gf_profiles').insert({ id:A.session.user.id, name, region, hcp });
  A.busy=false;
  if(error){ A.err=authMsg(error.message); render(); return; }
  await loadProfile(); A.tab='home'; render();
  toast('회원번호가 발급되었습니다. 확정 5라운드 전까지는 루키입니다.');
}
async function logout(){
  await A.sb.auth.signOut();
  A.session=null; A.profile=null; A.round=null; A.tab='home'; A.view='lobby'; render();
}

/* ---------------- 랭킹 ---------------- */
async function loadRank(grade){
  const { data, error } = await A.sb.rpc('gf_leaderboard', { p_grade: grade||null, p_limit: 60 });
  if(error){ toast(error.message); return; }
  A.rank = data || [];
}
async function openRank(grade){
  if(grade!==undefined) A.rankGrade=grade;
  A.tab='rank';
  await loadRank(A.rankGrade);
  render();
}

/* ---------------- 라운드 ---------------- */
async function createRound(course){
  A.err=''; A.busy=true; render();
  const { data, error } = await A.sb.rpc('gf_create_round', { p_course: course, p_par: 72 });
  A.busy=false;
  if(error){ A.err=error.message; render(); return; }
  A.round=Array.isArray(data)?data[0]:data;
  A.players=[]; A.scores=[]; A.sel=1; A.sum=null;
  await loadBoard();
  subscribe();
  A.tab='live'; A.view='board'; render();
  toast('라운드를 열었습니다. 코드 '+A.round.code);
}
async function joinRound(code){
  A.err=''; A.busy=true; render();
  const { data, error } = await A.sb.rpc('gf_join_round', { p_code: code });
  A.busy=false;
  if(error){ A.err=error.message; render(); return; }
  A.round=Array.isArray(data)?data[0]:data;
  A.players=[]; A.scores=[]; A.sel=1; A.sum=null;
  await loadBoard();
  subscribe();
  A.tab='live'; A.view='board'; render();
}
async function loadBoard(){
  if(!A.round) return;
  const rid=A.round.id;
  const [pl, sc] = await Promise.all([
    A.sb.from('gf_round_players').select('*').eq('round_id',rid).order('joined_at'),
    A.sb.from('gf_scores').select('*').eq('round_id',rid)
  ]);
  A.players = pl.data || [];
  A.scores  = sc.data || [];
  A.sel = nextHole();
  render();
  maybeConfirm();
}
function subscribe(){
  if(!A.sb || !A.round) return;
  if(A.ch){ try{ A.sb.removeChannel(A.ch); }catch(e){} }
  const rid=A.round.id; A.conn='wait';
  A.ch = A.sb.channel('gf-'+rid)
    .on('postgres_changes',{event:'*',schema:'public',table:'gf_scores',filter:'round_id=eq.'+rid},()=>loadBoard())
    .on('postgres_changes',{event:'*',schema:'public',table:'gf_round_players',filter:'round_id=eq.'+rid},()=>loadBoard())
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'gf_rounds',filter:'id=eq.'+rid},(p)=>{
      if(p.new && p.new.status==='confirmed' && A.round.status!=='confirmed'){
        A.round.status='confirmed'; render();
      }
    })
    .subscribe(st=>{ A.conn = st==='SUBSCRIBED'?'on':(st==='CHANNEL_ERROR'||st==='TIMED_OUT')?'off':'wait'; render(); });
}

const meId = () => A.session ? A.session.user.id : null;
const scoresOf = uid => A.scores.filter(s=>s.user_id===uid).sort((a,b)=>a.hole-b.hole);
const thru = uid => scoresOf(uid).length;
const grossOf = uid => scoresOf(uid).reduce((a,s)=>a+s.strokes,0);
const toParOf = uid => scoresOf(uid).reduce((a,s)=>a+s.strokes-s.par,0);
const scored = (uid,h) => A.scores.find(s=>s.user_id===uid && s.hole===h);
const parFmt = n => n===0?'E':n>0?'+'+n:'−'+Math.abs(n);
function nextHole(){
  const uid=meId(); if(!uid) return 1;
  for(let h=1;h<=18;h++) if(!scored(uid,h)) return h;
  return 19;
}
function liveSel(h){ A.sel=h; render(); }
async function submitScore(delta){
  if(!A.round || A.round.status!=='live') return;
  const h=A.sel; if(h>18) return;
  const strokes=PAR[h-1]+delta;
  const { error } = await A.sb.rpc('gf_submit_score',{ p_round:A.round.id, p_hole:h, p_strokes:strokes });
  if(error){ toast(error.message); return; }
  await loadBoard();
  toast(h+'번홀 '+strokes+'타 · 동기화');
}
async function approveRound(){
  const { data, error } = await A.sb.rpc('gf_approve',{ p_round:A.round.id });
  if(error){ toast(error.message); return; }
  await loadBoard();
  toast('승인했습니다. 현재 '+data+'/2');
}
function okApprovals(){
  if(!A.round) return 0;
  return A.players.filter(p=>p.user_id!==A.round.host_id && p.approved_at).length;
}
function allDone(){ return A.players.length>=2 && A.players.every(p=>thru(p.user_id)>=18); }
async function maybeConfirm(){
  if(!A.round || A.round.status!=='live' || A.confirming) return;
  if(okApprovals()<2 || !allDone()) return;
  A.confirming=true;
  try{
    const { data, error } = await A.sb.rpc('gf_confirm_round',{ p_round:A.round.id });
    if(error) throw error;
    const mine=(data && data.players || []).find(p=>p.user_id===meId());
    A.round.status='confirmed';
    A.sum = mine ? { ...mine, course:A.round.course, code:A.round.code } : null;
    await loadProfile();
    A.tab='live'; A.view='sum'; render();
  }catch(e){ /* 조건 미충족은 조용히 무시 */ }
  A.confirming=false;
}

/* ---------------- 렌더 ---------------- */
const ICO = {
  home:'<svg viewBox="0 0 24 24"><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/></svg>',
  rank:'<svg viewBox="0 0 24 24"><path d="M5 20V10M12 20V4M19 20v-7"/></svg>',
  live:'<svg viewBox="0 0 24 24"><path d="M3 12h3.2l2.3-6 3.6 12 2.4-6H21"/></svg>',
  me:'<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.6"/><path d="M4.8 20c.7-3.9 3.5-6 7.2-6s6.5 2.1 7.2 6"/></svg>',
  back:'<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>'
};
function screenName(){
  if(!A.sb) return 'needconfig';
  if(A.emailSent) return 'sent';
  if(!A.session) return 'auth';
  if(!A.profile) return 'onboard';
  if(A.tab==='rank') return 'rank';
  if(A.tab==='me') return 'me';
  if(A.tab==='live') return A.view==='board'?'board':A.view==='sum'?'sum':'lobby';
  return 'home';
}
function render(){
  const sc=screenName();
  const loggedIn = !!A.session && !!A.profile;
  const bar=$('#appbar'), tabs=$('#tabbar'), scr=$('#screen');
  if(!scr) return;

  if(['auth','sent','onboard','needconfig'].includes(sc)){
    bar.style.display='none'; tabs.style.display='none';
  } else {
    bar.style.display='flex'; tabs.style.display='grid';
    bar.innerHTML=appbar(sc); tabs.innerHTML=tabbar();
  }
  const changed=scr.dataset.sc!==sc, keep=scr.scrollTop;
  scr.dataset.sc=sc;
  scr.innerHTML=({needconfig:viewNeedConfig,auth:viewAuth,sent:viewSent,onboard:viewOnboard,
    home:viewHome,rank:viewRank,lobby:viewLobby,board:viewBoard,sum:viewSum,me:viewMe})[sc]();
  scr.scrollTop = changed?0:keep;
}
function appbar(sc){
  const t={home:'내 등급',rank:'전국 랭킹',lobby:'라이브 라운드',board:'라이브 스코어',sum:'라운드 확정',me:'내 정보'}[sc]||'';
  return `<div style="flex:1">
      <div class="ttl">GREENFIELD · ${t}</div>
      <div class="who"><span class="nm">${A.profile.name}</span><span class="no">${A.profile.member_no}</span></div>
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      ${A.round&&A.round.status==='live'?`<span class="sync ${A.conn==='on'?'on':'wait'}"><i></i>${A.conn==='on'?'SYNC':'연결'}</span>`:''}
      <button class="ic" onclick="openRank()" aria-label="랭킹">${ICO.rank}</button>
    </div>`;
}
function tabbar(){
  const items=[['home','홈',ICO.home],['rank','랭킹',ICO.rank],['live','라이브',ICO.live],['me','내 정보',ICO.me]];
  return items.map(([k,l,i])=>`<button class="${A.tab===k?'on':''}" onclick="goTab('${k}')">${i}<span>${l}</span></button>`).join('');
}
function goTab(k){
  A.tab=k;
  if(k==='rank'){ openRank(); return; }
  render();
}

/* ---------------- 화면 ---------------- */
function viewNeedConfig(){
  return `<div class="setup">
    <div class="eyebrow">SETUP REQUIRED</div>
    <h2 class="h1" style="margin-top:8px">백엔드 연결이 필요합니다</h2>
    <p class="muted" style="margin:10px 0 18px">저장소의 <b>config.js</b>에 Supabase URL과 공개 키를 넣으면 바로 동작합니다. 아래에 임시로 넣고 테스트할 수도 있습니다(이 브라우저에만 저장).</p>
    <div class="card">
      <label class="fld"><span>Project URL</span><input id="c-url" placeholder="https://xxxx.supabase.co" autocomplete="off"></label>
      <label class="fld" style="margin-bottom:6px"><span>공개 키 (Publishable / anon)</span><input id="c-key" placeholder="sb_publishable_... 또는 eyJhbGciOi..." autocomplete="off"></label>
      <button class="btn" style="margin-top:12px" onclick="saveCfg()">연결하기</button>
      <div class="inline-note">SQL 스키마(supabase/schema.sql)를 먼저 실행해야 로그인이 됩니다.</div>
    </div>
    <div class="card">
      <div class="eyebrow">순서</div>
      <ol class="steps" style="margin-top:10px">
        <li>Supabase 프로젝트 생성</li>
        <li>SQL Editor에서 <b>supabase/schema.sql</b> 실행</li>
        <li>Project Settings → API Keys에서 URL·공개 키 복사</li>
        <li>config.js에 붙여넣고 GitHub에 push</li>
      </ol>
    </div>
  </div>`;
}
function saveCfg(){
  const url=($('#c-url').value||'').trim().replace(/\/+$/,'');
  const key=($('#c-key').value||'').trim();
  if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)){ toast('URL 형식을 확인해 주세요.'); return; }
  if(key.length<20){ toast('공개 키를 정확히 붙여넣어 주세요.'); return; }
  LS.set(CKEY, JSON.stringify({url,key}));
  A.cfg={url,key};
  A.sb=window.supabase.createClient(url,key);
  A.sb.auth.getSession().then(({data})=>{ A.session=data.session; if(A.session) return loadProfile(); }).then(()=>render());
  A.sb.auth.onAuthStateChange((_e,s)=>{ A.session=s; if(s) loadProfile().then(render); else render(); });
  render();
}
function viewAuth(){
  const up=A.authMode==='signup';
  return `<div class="signup">
    <div class="wm" style="font-family:'Barlow Condensed',sans-serif;letter-spacing:.3em;font-size:14px;color:var(--sub)">GREENFIELD</div>
    <h2 class="step-title" style="margin-top:18px">${up?'회원가입':'로그인'}</h2>
    <p class="step-sub">${up?'이메일 확인 링크를 보내드립니다. 확인 후 회원번호가 발급됩니다.':'가입한 이메일로 로그인하세요.'}</p>
    <label class="fld"><span>이메일</span><input id="a-email" inputmode="email" autocomplete="email" placeholder="name@example.com"></label>
    <label class="fld"><span>비밀번호</span><input id="a-pw" type="password" autocomplete="${up?'new-password':'current-password'}" placeholder="6자 이상"></label>
    <div class="err ${A.err?'on':''}">${A.err||''}</div>
    <button class="btn" style="margin-top:14px" ${A.busy?'disabled':''} onclick="doAuth()">${A.busy?'처리 중…':up?'가입하고 인증메일 받기':'로그인'}</button>
    <div style="text-align:center;margin-top:14px">
      <button class="link" onclick="A.authMode='${up?'login':'signup'}';A.err='';render()">${up?'이미 계정이 있나요? 로그인':'처음이신가요? 회원가입'}</button>
    </div>
  </div>`;
}
function viewSent(){
  return `<div class="signup">
    <div class="eyebrow">VERIFY EMAIL</div>
    <h2 class="step-title" style="margin-top:12px">메일을 확인해 주세요</h2>
    <p class="step-sub"><b>${A.emailUsed||''}</b> 로 인증 링크를 보냈습니다. 링크를 누르면 인증이 완료되고, 다시 로그인하면 회원번호가 발급됩니다.</p>
    <div class="card paper">
      <div class="kv"><span>메일이 안 보이나요?</span><b>스팸함 확인</b></div>
      <div class="kv"><span>인증 링크 만료</span><b>24시간</b></div>
    </div>
    <button class="btn" style="margin-top:16px" onclick="A.emailSent=false;A.authMode='login';render()">로그인 화면으로</button>
  </div>`;
}
function viewOnboard(){
  return `<div class="signup">
    <div class="eyebrow">MEMBER PROFILE</div>
    <h2 class="step-title" style="margin-top:12px">프로필 만들기</h2>
    <p class="step-sub">이름과 신고 핸디로 회원번호가 자동 발급됩니다. 확정 5라운드 전까지는 루키 보드에만 표시됩니다.</p>
    <label class="fld"><span>이름</span><input id="o-name" value="" placeholder="실명" autocomplete="name"></label>
    <label class="fld"><span>지역</span>
      <select id="o-region">${['서울','경기','인천','부산','대전','대구','광주','강원','제주','충북','경남','전북'].map(r=>`<option>${r}</option>`).join('')}</select>
    </label>
    <label class="fld"><span>신고 핸디 (0~54)</span><input id="o-hcp" type="number" step="0.1" value="27" inputmode="decimal"></label>
    <div class="err ${A.err?'on':''}">${A.err||''}</div>
    <button class="btn" style="margin-top:12px" ${A.busy?'disabled':''} onclick="createProfile()">회원번호 받기</button>
  </div>`;
}
function viewHome(){
  const p=A.profile, g=gradeOf(p.hcp), n=nextGradeInfo(p.hcp);
  return `<div class="hero-grade">
    <div class="row1">
      <div class="gl"><div class="letter c${g}">${g}</div>
        <div class="subj">핸디 ${GT[g]}<br>${g==='A'?'싱글':g==='B'?'안정권':g==='C'?'성장 구간':'입문·복귀'}</div></div>
      <div class="hc"><div class="v">${fmt(p.hcp)}</div><div class="l">HANDICAP</div></div>
    </div>
    <div class="no2">${p.member_no} · ${p.region} · ${p.status==='active'?'정회원':'루키'}</div>
  </div>
  <div class="promo-band">
    <div class="top"><b>${n.top?'최상위 등급 유지':n.next+'등급까지 '+fmt(n.need)}</b><span>${Math.round(n.pct)}%</span></div>
    <div class="track"><i style="width:${n.pct}%"></i></div>
    <div class="note">${p.status==='active'?'핸디는 확정 라운드의 베스트 8 평균으로 서버에서 계산됩니다.':'확정 라운드 5회가 쌓이면 정회원이 되고 전체 랭킹에 들어갑니다.'}</div>
  </div>
  <div class="stat3">
    <div><div class="k">확정 라운드</div><div class="v">${p.rounds}<small>R</small></div></div>
    <div><div class="k">현재 핸디</div><div class="v">${fmt(p.hcp)}</div></div>
    <div><div class="k">등급</div><div class="v" style="font-size:22px">${g}</div></div>
  </div>
  ${A.round&&A.round.status==='live'?`<div class="live-slim" onclick="A.tab='live';A.view='board';render()">
      <span class="live-pill"><i></i>LIVE</span>
      <div><b>${A.round.course} · ${thru(meId())}홀</b><span>코드 ${A.round.code} · 보드 열기</span></div></div>`:''}
  <div class="sec">
    <div class="sec-h"><h3>최근 라운드</h3></div>
    ${A.logs.length?A.logs.map(l=>{
      const d=new Date(l.created_at), g0=gradeOf(Number(l.diff));
      return `<div class="rrow">
        <div class="dt"><b>${d.getDate()}</b><span>${d.getMonth()+1}월</span></div>
        <div class="body"><b>${l.gf_rounds?l.gf_rounds.course:'라운드'}</b><span>그로스 ${l.gross} · 파대비 ${parFmt(Number(l.diff))}</span></div>
        <div class="sc"><b>${l.gross}</b><span>${g0}등급</span></div>
      </div>`;}).join(''):'<p class="muted" style="padding:8px 0">아직 확정된 라운드가 없습니다.</p>'}
    <button class="btn" style="margin-top:14px" onclick="A.tab='live';A.view='lobby';render()">라운드 열기 · 코드로 참여</button>
  </div>`;
}
function viewRank(){
  const tabs=[['ALL','전체'],['A','A'],['B','B'],['C','C'],['D','D']];
  const rows=A.rank||[];
  const myIdx=rows.findIndex(r=>r.user_id===meId());
  return `<div class="rank-head">
    <div class="h"><h2>전국 랭킹</h2><span class="season">${A.rankGrade||'ALL'} · ${rows.length}명</span></div>
    <p>핸디 → 확정 라운드 순. 루키(확정 5회 미만)는 별도 표시됩니다.</p>
  </div>
  <div class="tabs-scroll">${tabs.map(([k,l])=>`<button class="${(A.rankGrade||'ALL')===k?'on':''}" onclick="openRank('${k==='ALL'?'':k}')">${l}</button>`).join('')}</div>
  <div class="rank-list" style="padding-top:8px">
    ${rows.length?rows.map(r=>`<div class="rk ${r.user_id===meId()?'me':''}">
      <div class="pos ${Number(r.rank)<=3?'top':''}">${r.rank}</div>
      <div>
        <div class="nm"><span class="g ${r.grade}">${r.grade}</span>${r.name}${r.user_id===meId()?' <span class="chip gold" style="padding:1px 6px;font-size:9px">나</span>':''}</div>
        <div class="mt"><span>${r.region}</span><span>${r.rounds}R</span>${r.status==='rookie'?'<span>루키</span>':''}</div>
      </div>
      <div class="hc">${fmt(r.hcp)}<span>핸디</span></div>
    </div>`).join(''):'<p class="muted" style="padding:18px 0">아직 집계된 회원이 없습니다.</p>'}
  </div>
  <div class="myrank" style="position:sticky;bottom:0">
    <div class="pos">${myIdx>=0?myIdx+1:'—'}<small>위</small></div>
    <div class="who"><b>${A.profile.name} · ${gradeOf(A.profile.hcp)}등급</b>핸디 ${fmt(A.profile.hcp)} · ${A.profile.rounds}R</div>
    <button class="go" onclick="openRank()">새로고침</button>
  </div>`;
}
function viewLobby(){
  if(A.round && A.round.status==='live'){
    return `<div class="lobby">
      <div class="eyebrow">ROUND IN PROGRESS</div>
      <h2 class="h1" style="margin-top:8px">${A.round.course}</h2>
      <div class="coderow" style="margin-top:16px"><b>${A.round.code}</b><span>조원에게<br>불러주세요</span>
        <button onclick="copyCode('${A.round.code}')">복사</button></div>
      <div class="lpanel">
        <h3>참여 ${A.players.length}/4</h3>
        <p>같은 코드로 들어오면 실시간으로 추가됩니다.</p>
        ${A.players.map(p=>`<div class="who2">
          <div class="av">${p.name[0]}</div>
          <div class="n">${p.name}${p.user_id===meId()?' (나)':''}<small>핸디 ${fmt(p.hcp_at)} · ${p.user_id===A.round.host_id?'주최자':'참여'}</small></div>
          <div class="st ${p.approved_at?'ok':''}">${p.approved_at?'승인':'—'}</div>
        </div>`).join('')}
      </div>
      <button class="btn" onclick="A.view='board';render()">라이브 보드 열기</button>
      <button class="btn ghost" style="margin-top:10px" onclick="leaveRound()">라운드 나가기</button>
    </div>`;
  }
  return `<div class="lobby">
    <div class="eyebrow">START A ROUND</div>
    <h2 class="h1" style="margin-top:8px">같은 조, 같은 보드</h2>
    ${A.err?`<div class="err2 on" style="margin-top:14px">${A.err}</div>`:''}
    <div class="lpanel" style="margin-top:18px">
      <h3>새 라운드 열기</h3>
      <p>4자리 코드가 발급되고 내가 주최자가 됩니다.</p>
      <div class="pick-row" style="margin-bottom:12px">
        ${['베어즈베스트 청라','남서울CC','스카이72 오션','부여CC'].map((c,i)=>`<button class="pick ${i===0?'on':''}" onclick="pickCourse('${c}',this)">${c}<small>파72 · 18홀</small></button>`).join('')}
      </div>
      <button class="btn" ${A.busy?'disabled':''} onclick="createRound(window.__course||'베어즈베스트 청라')">${A.busy?'여는 중…':'라운드 열기'}</button>
    </div>
    <div class="lpanel">
      <h3>코드로 참여</h3>
      <p>조원에게 받은 4자리 코드.</p>
      <div class="codesheet">${[0,1,2,3].map(i=>`<input id="c${i}" maxlength="1" oninput="codeNext(${i})" aria-label="코드">`).join('')}</div>
      <button class="btn ghost" style="margin-top:10px" onclick="joinByInput()">참여하기</button>
    </div>
  </div>`;
}
function pickCourse(name, el){
  window.__course=name;
  Array.prototype.forEach.call(el.parentNode.children,c=>c.classList.remove('on'));
  el.classList.add('on');
}
function codeNext(i){
  const el=$('#c'+i); el.value=(el.value||'').toUpperCase();
  if(el.value && i<3) $('#c'+(i+1)).focus();
}
function joinByInput(){
  const c=[0,1,2,3].map(i=>($('#c'+i).value||'').toUpperCase()).join('');
  if(c.length!==4){ A.err='4자리 코드를 입력하세요.'; render(); return; }
  joinRound(c);
}
function copyCode(c){
  try{ navigator.clipboard.writeText(c); toast('코드 '+c+' 복사'); }catch(e){ toast('코드: '+c); }
}
function leaveRound(){
  if(A.ch&&A.sb){ try{ A.sb.removeChannel(A.ch); }catch(e){} }
  A.ch=null; A.round=null; A.players=[]; A.scores=[]; A.view='lobby'; render();
}
function viewBoard(){
  if(!A.round) return '<div class="lobby"><p class="muted">진행 중인 라운드가 없습니다.</p></div>';
  const uid=meId(), t=thru(uid), tp=toParOf(uid), g=grossOf(uid);
  const order=A.players.map(p=>({p,tp:toParOf(p.user_id),t:thru(p.user_id)}))
    .sort((a,b)=>(a.t-a.tp)-(b.t-b.tp)||b.t-a.t);
  const myPos=order.findIndex(o=>o.p.user_id===uid)+1;
  const h=A.sel>18?18:A.sel, par=PAR[h-1], done=t>=18;
  const ok=okApprovals(), isHost=A.round.host_id===uid, myP=A.players.find(p=>p.user_id===uid);
  return `<div class="live-hd">
    <div class="live-top"><span class="live-pill"><i></i>LIVE</span>
      <span class="num" style="font-family:'Barlow Condensed';letter-spacing:.14em">${A.round.code}</span>
      <span>${A.players.length}명 · ${t}/18</span><span style="margin-left:auto">${A.conn==='on'?'SYNC':'…'}</span></div>
    <div class="live-course">${A.round.course}</div>
    <div class="live-meta">파${A.round.par} · 18홀 · ${A.profile.name}</div>
    <div class="my-live"><div class="big">${parFmt(tp)}</div>
      <div class="side"><b>${g}타 · ${t}홀</b>조 내 ${myPos}위 / ${A.players.length}명</div></div>
  </div>
  <div class="lb"><div class="lb-cap"><span>조 리더보드</span><span>파 대비 · THRU</span></div>
    ${order.map((o,i)=>`<div class="r ${o.p.user_id===uid?'me':''}">
      <div class="p">${i+1}</div>
      <div><div class="nm">${o.p.name}${o.p.user_id===uid?' <span class="chip gold" style="padding:0 5px;font-size:8.5px">나</span>':''}<small>${fmt(o.p.hcp_at)}</small></div>
        <div class="chips-mini">${scoresOf(o.p.user_id).slice(-4).map(s=>`<i class="${s.strokes<s.par?'b':s.strokes>s.par?'d':''}">${s.strokes}</i>`).join('')}</div></div>
      <div class="to ${o.t-o.tp<0?'u':''}">${parFmt(o.t-o.tp)}<span>${o.t}홀</span></div>
    </div>`).join('')}</div>
  <div class="entry">
    <div class="entry-h"><b>${done?'18홀 완료':h+'번홀 · 파'+par}</b><span>${done?'승인 대기':'탭하면 즉시 동기화'}</span></div>
    ${done?'<div class="warn" style="margin-top:2px">내 입력은 끝났습니다. 전원 18홀 + 승인 2명이면 확정됩니다.</div>':`<div class="keys" style="margin-top:2px">
      <button onclick="submitScore(-1)">버디<small>−1</small></button>
      <button class="pri" onclick="submitScore(0)">파<small>기준</small></button>
      <button onclick="submitScore(1)">보기<small>+1</small></button>
      <button onclick="submitScore(2)">더블<small>+2</small></button></div>`}
    <div class="hstrip" style="margin-top:12px">${PAR.map((p0,i)=>{
      const s=scored(uid,i+1), hh=i+1;
      const cls=[hh===h?'sel':'',s?'done':'',s&&s.strokes<p0?'bd':''].join(' ');
      return `<button class="${cls}" onclick="liveSel(${hh})">${s?s.strokes:hh}</button>`;
    }).join('')}</div>
    <div class="entry-f"><span>이 홀 입력 ${A.players.filter(p=>scored(p.user_id,h)).length}/${A.players.length}</span><span>지난 홀은 번호 탭</span></div>
  </div>
  <div class="appr" style="margin:12px 18px 0">
    <div class="hd"><b>동반자 승인</b><span class="${ok>=2?'ok':''}">${ok} / 2</span></div>
    ${A.players.map(p=>{
      const mine=p.user_id===uid, host=p.user_id===A.round.host_id, ap=p.approved_at;
      return `<div class="p"><div class="av">${p.name[0]}</div>
        <div class="nm">${p.name}${mine?' (나)':''}<small>${host?'주최자':(ap?'승인 완료':'대기')}</small></div>
        ${host?'<span class="st">—</span>':ap?'<span class="st ok">승인</span>':
          mine?'<button onclick="approveRound()">내가 승인</button>':'<span class="st">대기</span>'}
      </div>`;}).join('')}
  </div>
  <div style="padding:14px 18px 24px">
    <button class="btn ghost" onclick="copyCode('${A.round.code}')">코드 ${A.round.code} 공유</button>
    <div class="inline-note" style="text-align:center">${isHost?'내가 주최자입니다.':'조원으로 참여 중입니다.'} 전원 18홀 + 승인 2명이면 자동 확정됩니다.</div>
  </div>`;
}
function viewSum(){
  const s=A.sum;
  if(!s) return `<div class="lobby"><p class="muted">확정 정보를 불러오지 못했습니다.</p>
    <button class="btn ghost" style="margin-top:12px" onclick="A.view='lobby';render()">돌아가기</button></div>`;
  const up=!!s.promoted;
  return `<div class="promo-banner">
    ${up?`<div class="confetti">${Array.from({length:12}).map((_,i)=>`<i style="left:${(i*8.3)%100}%; animation-delay:${(i%6)*.2}s"></i>`).join('')}</div>`:''}
    <div class="eyebrow">${up?'PROMOTED':'ROUND CONFIRMED'}</div>
    <div class="arrow">${up?`${s.grade_before||'—'} <span>→</span> ${s.grade}`:'확정'}</div>
    <h2>${up?s.grade+'등급으로 승급했습니다':'라운드가 확정되었습니다'}</h2>
    <div class="delta"><span class="b">${fmt(s.before)}</span><span class="a">${fmt(s.after)}</span><span class="u">핸디</span></div>
    <p>${s.course} · 그로스 ${s.gross}타 · 코드 ${s.code}<br>동반자 2명 승인 · 서버에서 재계산</p>
  </div>
  <div class="stat3" style="margin:18px 18px 0">
    <div><div class="k">그로스</div><div class="v">${s.gross}</div></div>
    <div><div class="k">파 대비</div><div class="v">${parFmt(s.gross-72)}</div></div>
    <div><div class="k">새 핸디</div><div class="v">${fmt(s.after)}</div></div>
  </div>
  <div style="padding:18px">
    <button class="btn" onclick="openRank('${s.grade}')">${s.grade}등급 랭킹 보기</button>
    <button class="btn ghost" style="margin-top:10px" onclick="leaveRound();A.tab='live';render()">새 라운드</button>
  </div>`;
}
function viewMe(){
  const p=A.profile;
  return `<div class="me-hd">
    <div class="nm">${p.name}</div>
    <div class="meta">${p.member_no} · ${p.region} · ${gradeOf(p.hcp)}등급</div>
    <div style="display:flex;gap:18px;margin-top:16px;font-size:11px;color:#9FB3A7">
      <span>핸디 <b style="color:var(--paper);font-size:13px">${fmt(p.hcp)}</b></span>
      <span>확정 <b style="color:var(--paper);font-size:13px">${p.rounds}R</b></span>
      <span>${p.status==='active'?'정회원':'루키'}</span>
    </div>
  </div>
  <div class="sec" style="margin-top:20px"><div class="sec-h"><h3>등급 기준</h3></div></div>
  <div style="margin:0 18px" class="card">
    <table class="rule-table"><tr><th>등급</th><th>핸디</th><th>인원</th></tr>
      ${['A','B','C','D'].map(k=>`<tr style="${gradeOf(p.hcp)===k?'background:rgba(201,169,97,.09)':''}">
        <td><span class="badge-grade" style="background:${{A:'#C9A961',B:'#3E7F62',C:'#5C7A9E',D:'#96866E'}[k]}">${k}</span>${GT[k]}</td>
        <td>${k==='A'?'10 이하':k==='B'?'11–18':k==='C'?'19–27':'28 이상'}</td>
        <td>${A.rank.filter(r=>r.grade===k).length||'-'}</td></tr>`).join('')}
    </table>
  </div>
  <div class="sec" style="margin-top:22px"><div class="sec-h"><h3>핸디 이력</h3><span style="font-size:10px;color:var(--sub)">서버 기록</span></div></div>
  <div class="list">
    ${A.logs&&A.logs.length?A.logs.slice(0,4).map(l=>`<div style="display:flex;padding:13px 16px;border-bottom:1px solid var(--line);align-items:center">
      <div style="flex:1"><div style="font-size:12.5px;font-weight:600">${l.gf_rounds?l.gf_rounds.course:'라운드'}</div>
      <div style="font-size:10.5px;color:var(--sub);margin-top:2px">${new Date(l.created_at).toLocaleDateString('ko-KR')} · ${l.gross}타</div></div>
      <div style="font-family:'Barlow Condensed';font-size:13px;color:var(--sub)">${parFmt(Number(l.diff))}</div>
    </div>`).join(''):'<div style="padding:14px 16px;font-size:12px;color:var(--sub)">아직 기록이 없습니다.</div>'}
  </div>
  <div class="sec" style="margin-top:22px"><div class="sec-h"><h3>계정</h3></div></div>
  <div class="list">
    <button onclick="toast('로그인 이메일: '+(A.session?A.session.user.email:''))"><span class="k">로그인 계정</span><span class="v">${A.session?A.session.user.email:''}</span></button>
    <button onclick="toast('라운드는 전원 18홀 + 승인 2명이면 확정됩니다.')"><span class="k">확정 규칙</span><span class="v">승인 2명</span></button>
    <button onclick="logout()"><span class="k" style="color:var(--red)">로그아웃</span></button>
  </div>
  <div style="padding:20px 18px;text-align:center;font-size:10px;color:var(--sub)">GREENFIELD 2.0 · Supabase Realtime</div>`;
}

/* ---------------- boot ---------------- */
(function boot(){
  const g=window.GF_CONFIG||{};
  A.cfg = (g.url&&g.key) ? {url:g.url,key:g.key} : (LS.get(CKEY)?JSON.parse(LS.get(CKEY)):null);
  if(A.cfg && window.supabase){
    A.sb = window.supabase.createClient(A.cfg.url, A.cfg.key);
    A.sb.auth.getSession().then(({data})=>{
      A.session=data.session;
      return A.session ? loadProfile() : null;
    }).then(()=>render());
    A.sb.auth.onAuthStateChange((_e,s)=>{
      A.session=s;
      if(s) loadProfile().then(render); else render();
    });
  }
  render();
  if('serviceWorker' in navigator && location.protocol==='https:'){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
})();
