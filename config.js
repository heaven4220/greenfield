/* ============================================================
   GREENFIELD LIVE — 연결 설정
   이 파일만 수정해서 push하면 배포본 전체에 반영됩니다.

   1) url : Supabase > Project Settings > API > Project URL
            ★ 반드시 호스트만. 뒤에 경로(/rest/v1, /auth/v1 등)나
              슬래시를 붙이면 "Invalid path specified in request URL" 오류가 납니다.
              O  https://abcdefghijklmnop.supabase.co
              X  https://abcdefghijklmnop.supabase.co/rest/v1
              X  https://supabase.com/dashboard/project/abcdefghijklmnop
   2) key : 같은 화면의 anon public(= publishable) 키

   비워두면 앱은 '설정 필요' 화면으로 뜹니다.
   service_role / secret 키는 절대 넣지 마세요.
   ============================================================ */
window.GF_CONFIG = {
  url: '',
  key: ''
};
