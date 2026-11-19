/* ============================================================
   GREENFIELD LIVE — 연결 설정
   이 파일만 수정해서 push하면 배포본 전체에 반영됩니다.

   1) url : Supabase > Project Settings > API > Project URL
            ★ 반드시 호스트만. 뒤에 경로(/rest/v1, /auth/v1 등)나
              슬래시를 붙이면 "Invalid path specified in request URL" 오류가 납니다.
   2) key : 같은 화면의 anon public(= publishable) 키

   service_role / secret 키는 절대 넣지 마세요.
   ============================================================ */
window.GF_CONFIG = {
  url: 'https://oikfycmgymlsvbhhwgpo.supabase.co',
  key: 'sb_publishable_A97ZLP3X-UktI4RKRZNzVg_NWtSAc6d'
};
