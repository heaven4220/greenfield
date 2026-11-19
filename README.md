# GREENFIELD 2.0 — 운영용 (Supabase + GitHub Pages)

동호회 전용 리더보드를 **공개 가입형 랭킹 앱**으로. 데모 데이터는 없습니다. 모든 회원·라운드·핸디는 Supabase에 저장되고, 규칙은 DB 함수가 강제합니다.

## 이번 버전에서 달라진 점

| 항목 | 2.0 |
|---|---|
| 가입 | Supabase Auth 이메일 인증 (비밀번호 로그인) |
| 회원번호 | DB 트리거가 `G26-000101` 형식으로 자동 발급 |
| 핸디 | **서버 계산**. 클라이언트는 핸디를 쓸 수 없음(컬럼 권한 차단) |
| 라운드 확정 | 전원 18홀 + 동반자 2명 승인 → `gf_confirm_round()`만 가능 |
| 점수 수정 | 확정된 라운드는 DB가 거부 |
| 랭킹 | `gf_leaderboard()` — 핸디순, 루키 구분 |

## 설치

1. **Supabase** → New project (Region: Seoul)
2. **SQL Editor** → `supabase/schema.sql` 전체 실행
3. **Project Settings → API Keys** → Project URL + 공개 키(`anon` / `publishable`) 복사
4. `config.js` 에 두 값 입력
5. GitHub 저장소(Public)에 파일 전체 업로드
6. **Settings → Pages → Source** 선택 — 둘 중 하나로만 통일합니다.
   - `GitHub Actions` → 포함된 `.github/workflows/pages.yml`이 배포 (권장)
   - `Deploy from a branch → main / (root)` → 이 경우 `.github/workflows/pages.yml`은 삭제
7. **Supabase → Authentication → URL Configuration**
   - Site URL: `https://<아이디>.github.io/<저장소>/`
   - Redirect URLs에도 같은 주소 추가 (안 하면 인증 메일 링크가 localhost로 갑니다)
8. 1~2분 뒤 `https://<아이디>.github.io/<저장소>/` → 폰에서 **홈 화면에 추가**

## 문제 해결

| 증상 | 원인 / 조치 |
|---|---|
| `Invalid path specified in request URL` | `config.js`의 `url`에 경로가 붙어 있음. 호스트만 남기세요 (`https://xxxx.supabase.co`) |
| `Invalid API key` | `key`가 anon/publishable 키가 아니거나 잘린 상태 |
| 인증 메일 링크가 localhost로 감 | Supabase → Authentication → URL Configuration의 Site URL 미설정 |
| config.js를 고쳤는데 폰에서 그대로 | 서비스워커 캐시. 홈 화면 아이콘 삭제 후 재설치하거나 브라우저에서 새로고침 (v3부터 config.js는 캐시하지 않습니다) |

> `service_role` / `secret` 키는 절대 넣지 마세요. 앱에는 공개 키만 들어갑니다.

## 핸디 규칙 (서버 구현)

- 차등(diff) = 그로스 − 파
- **확정 3라운드 미만**: 신고 핸디 유지 (공식 산정 보류)
- 3라운드 이상: 최근 20라운드 중 베스트 N 평균
  (3~4R→1개, 5~8R→2개, 9~11R→3개, 12~14R→4개, 15~16R→5개, 17~18R→6개, 19R→7개, 20R+→8개)
- **1라운드 변동 상한 ±3.0** (샌드배깅·급변 방지)
- 5라운드 확정 시 `rookie` → `active` (전체 랭킹 진입)

## 라운드 규칙 (서버 강제)

- 4인 1조, 코드 4자리
- 주최자는 승인 불가, 나머저 참가자 중 **2명** 승인 필요
- 전원 18홀 입력 완료 전에는 확정 불가
- 확정은 `status='live'` 조건부로 1회만 (중복 정산 차단)

## 데이터

| 테이블 | 역할 |
|---|---|
| `gf_profiles` | 회원 (member_no, hcp, status, rounds) |
| `gf_rounds` | 라운드 (code, course, status) |
| `gf_round_players` | 참가자 · 승인시각 |
| `gf_scores` | 홀별 스코어 (Realtime) |
| `gf_round_results` | 확정된 라운드 결과 (diff 원장) |
| `gf_handicap_log` | 핸디 변동 이력 |

## 업데이트

`index.html` 수정 → commit → 1~2분 뒤 배포. `config.js`는 건드릴 필요 없습니다.

## 남은 과제 (권장 순서)

1. **관리자 콘솔** — 신고/이의 처리, 라운드 무효화(`status='void'`), 회원 정지
2. **코스 데이터** — 지금은 파 72 고정 배열. 코스별 파·CR·슬로프를 테이블로
3. **카카오 초대 링크** — `?join=CODE`로 바로 입장
4. **시즌·업적** — 기존 앱의 그린재킷/라이벌을 `gf_handicap_log` 기반으로
