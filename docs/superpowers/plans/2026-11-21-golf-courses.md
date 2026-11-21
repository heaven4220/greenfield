# 골프장 등록 기능 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 회원이 공용 골프장 목록에서 코스를 고르거나 새로 추가해 라운드를 열 수 있고, 관리자가 그 목록을 수정·통합할 수 있게 한다.

**Architecture:** `gf_courses` 테이블을 추가하고 쓰기는 전부 SECURITY DEFINER RPC로만 한다(기존 스키마 관례). `gf_rounds`에 `course_id`를 붙여 집계 기준을 텍스트에서 FK로 옮기되, 기존 `course` 텍스트는 라운드 당시 이름 스냅샷으로 남긴다. 클라이언트는 단일 `index.html` 안의 인라인 스크립트다.

**Tech Stack:** PostgreSQL 16 (Supabase), supabase-js v2 (CDN), 바닐라 JS 단일 HTML, GitHub Pages

**Spec:** `docs/superpowers/specs/2026-11-21-golf-courses-design.md`

## Global Constraints

- DB 쓰기는 전부 `security definer set search_path = public, pg_temp` 함수로. 클라이언트 직접 INSERT/UPDATE 금지
- 모든 DDL/함수는 재실행 가능해야 한다 (`create table if not exists`, `create or replace`, `drop ... if exists`). 사용자가 SQL Editor에 통째로 붙여넣어 실행하고, 두 번 실행할 수 있다
- 마이그레이션은 `supabase/migrations/2026-11-21-courses.sql` 한 파일에 누적한다. `supabase/schema.sql`도 같은 내용으로 갱신해 신규 설치 시 일치시킨다
- 사용자 대상 문구는 전부 한국어
- 골프장 `region` 값은 `북부` / `중부` / `남부` / `기타` 네 가지뿐
- `par` 체크 27~80, `holes`는 9/18/27/36/54
- 클라이언트의 `PAR` 상수(홀별 파 배열)는 건드리지 않는다
- 로컬 테스트는 이 컨테이너의 PostgreSQL 16을 쓴다. Supabase의 `auth` 스키마는 테스트 하네스에서 흉내 낸다

## Review Focus

사양이 함축하지만 어느 태스크의 기본 테스트도 건드리지 않는 입력들. 각 줄의 테스트를 담당 태스크에 넣었다.

- 두 회원이 같은 이름을 거의 동시에 추가 → unique 위반이 사용자에게 오류로 튀면 안 되고 기존 행이 반환돼야 한다 (Task 2)
- 이름 앞뒤 공백·중복 공백·대소문자만 다른 입력 → 같은 골프장으로 묶여야 한다 (Task 1)
- `status`가 `hidden`/`merged`인 코스로 라운드 열기 시도 → 서버가 거부해야 한다. UI만 막으면 우회된다 (Task 4)
- 자기 자신으로 통합(`p_from = p_into`) → 거부해야 한다. 통과시키면 `merged_into`가 자기를 가리켜 목록에서 사라진다 (Task 3)
- 관리자가 아닌 회원이 `gf_update_course`를 직접 호출 → 거부해야 한다. 앱 UI를 거치지 않는 경로다 (Task 3)

---

### Task 1: `gf_courses` 테이블과 시드 데이터

**Files:**
- Create: `supabase/migrations/2026-11-21-courses.sql`
- Create: `test/sql/harness.sql`
- Create: `test/sql/run.sh`
- Create: `test/sql/01_courses_table.sql`
- Modify: `supabase/schema.sql` (gf_profiles 블록 뒤에 같은 DDL 추가)

**Interfaces:**
- Produces: 테이블 `public.gf_courses(id uuid, name text, name_key text, region text, par int, holes int, status text, merged_into uuid, created_by uuid, created_at timestamptz)`. `authenticated`에 `select` 권한. 이후 모든 태스크가 이 테이블을 쓴다.

- [ ] **Step 1: 테스트 하네스를 만든다**

`test/sql/harness.sql` — Supabase 환경을 흉내 낸다. `auth` 스키마, `auth.users(id uuid primary key)`, 현재 사용자를 세션 변수에서 읽는 `auth.uid()`, 그리고 `anon`/`authenticated` 롤.

```sql
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
```

`test/sql/run.sh` — 빈 DB를 만들고 harness → `supabase/schema.sql` → 마이그레이션 → 인자로 받은 테스트 파일 순으로 실행한다. 어느 단계든 실패하면 0이 아닌 코드로 끝난다 (`psql -v ON_ERROR_STOP=1`).

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`test/sql/01_courses_table.sql` — `do $$ ... assert ... $$` 블록으로 쓴다.

```sql
-- name_key 정규화: 공백·대소문자 차이는 같은 골프장
insert into gf_courses (name, region) values ('Montgomery Links', '중부');
do $$ begin
  begin
    insert into gf_courses (name, region) values ('  montgomery   links  ', '중부');
    raise exception '중복이 통과했다';
  exception when unique_violation then null;
  end;
end $$;

-- 시드: 권역별로 최소 1곳 이상, 전부 active
do $$
declare n int;
begin
  select count(*) into n from gf_courses where status = 'active';
  assert n >= 25, '시드 골프장이 부족하다: ' || n;
  assert (select count(distinct region) from gf_courses) >= 3, '권역이 부족하다';
  assert not exists (select 1 from gf_courses where par not between 27 and 80), '파 범위 위반';
  assert not exists (select 1 from gf_courses where holes not in (9,18,27,36,54)), '홀수 위반';
end $$;
```

- [ ] **Step 3: 테스트가 실패하는지 확인한다**

Run: `bash test/sql/run.sh test/sql/01_courses_table.sql`
Expected: FAIL — `relation "gf_courses" does not exist`

- [ ] **Step 4: 마이그레이션에 테이블을 만든다**

`supabase/migrations/2026-11-21-courses.sql`에 `gf_courses`를 추가한다. 컬럼은 사양의 표 그대로. `name_key`는 정규화 함수를 쓰는 생성 컬럼으로 만든다. 함수로 빼는 이유는
`gf_add_course`가 조회할 때 같은 식을 써야 하기 때문이다.

```sql
create or replace function public.gf_name_key(p text) returns text
language sql immutable as
  $$ select lower(regexp_replace(coalesce(p,''), '[^[:alnum:]가-힣]', '', 'g')) $$;
```

```sql
name_key text generated always as (public.gf_name_key(name)) stored unique
```

RLS를 켜고 `authenticated`에 select 정책(`using (true)`)과 `grant select`를 준다. insert/update/delete 권한은 주지 않는다 — 전부 RPC를 거친다.

- [ ] **Step 5: 시드 데이터를 넣는다**

같은 파일에 `insert ... on conflict (name_key) do nothing`으로 넣는다. 재실행 가능해야 한다. 아래 목록을 쓴다. 전부 `par 72`.

| 권역 | 골프장 (홀수) |
|---|---|
| 북부 | 롱비엔 CC (27), 스카이레이크 CC (36), 반트리 CC (18), 하노이 골프클럽 (27), BRG 킹스아일랜드 (36), BRG 레전드힐 (18), 피닉스 CC (54), 스톤밸리 CC (27), 다이라이 CC (27), 땀다오 CC (18), 힐탑밸리 CC (18), 헤론레이크 CC (18), 짱안 CC (18), 로얄 골프클럽 닌빈 (36), 앰버힐스 CC (18), 빈펄 골프 하이퐁 (36), 루비트리 CC (18), 소노펠리체 CC (18), 뚜언쩌우 하롱 CC (18), EPGA 에코파크 (18) |
| 중부 | BRG 다낭 (36), 몽고메리 링크스 (18), 바나힐 CC (18), 라구나 랑코 (18), 빈펄 남호이안 (18), 호이아나 쇼어스 (18), 골든샌즈 후에 (18) |
| 남부 | 탄손넛 CC (36), 투득 CC (36), 롱탄 CC (36), 트윈도브 CC (27), 송베 CC (27), 하모니 CC (18), 동나이 CC (27), 에메랄드 CC (18), 붕따우 파라다이스 (18), 더 블러프 호짬 (18), 빈펄 레만 구찌 (18), 로얄 롱안 (18) |

`supabase/schema.sql`에도 같은 DDL과 시드를 넣는다.

- [ ] **Step 6: 테스트 통과를 확인한다**

Run: `bash test/sql/run.sh test/sql/01_courses_table.sql`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add supabase/migrations supabase/schema.sql test/sql
git commit -m "feat: gf_courses 테이블과 베트남 골프장 시드"
```

---

### Task 2: `gf_add_course` RPC

**Files:**
- Modify: `supabase/migrations/2026-11-21-courses.sql`
- Modify: `supabase/schema.sql`
- Create: `test/sql/02_add_course.sql`

**Interfaces:**
- Consumes: Task 1의 `gf_courses`
- Produces: `public.gf_add_course(p_name text, p_region text default '기타', p_par int default 72, p_holes int default 18) returns public.gf_courses`. `authenticated`에 execute 권한. 클라이언트는 `A.sb.rpc('gf_add_course', {p_name, p_region, p_par, p_holes})`로 부른다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/sql/02_add_course.sql`. 테스트 회원 두 명(일반, 정지)을 `auth.users` + `gf_profiles`에 넣고 `set_config('test.uid', ...)`로 전환해가며 검증한다.

```sql
-- 신규 추가
assert (select name from gf_add_course('테스트 골프장', '북부', 71, 18)) = '테스트 골프장';
-- 같은 이름을 다시: 오류가 아니라 기존 행 반환, 행 수는 그대로
assert (select id from gf_add_course('테스트 골프장')) = v_first_id;
assert (select count(*) from gf_courses where name_key = '테스트골프장') = 1;
-- Review Focus: 동시 추가 (unique_violation 경로)
--   같은 트랜잭션에서 먼저 insert 한 뒤 호출해도 기존 행이 돌아와야 한다
-- 프로필 없는 사용자
assert_raises('프로필을 먼저 만들어 주세요');
-- 정지 회원
assert_raises('이용이 제한된 계정입니다');
-- 하루 10개 제한: 10개까지 되고 11번째가 거부
assert_raises('하루에 추가할 수 있는 골프장 수를 넘었습니다');
-- 잘못된 권역은 '기타'로 떨어진다
assert (select region from gf_add_course('권역없음', '경기')) = '기타';
```

- [ ] **Step 2: 실패 확인**

Run: `bash test/sql/run.sh test/sql/02_add_course.sql`
Expected: FAIL — `function gf_add_course(...) does not exist`

- [ ] **Step 3: `gf_add_course`를 구현한다**

`security definer`. 순서: `auth.uid()` 확인 → `gf_profiles` 조회(없으면 예외) → `status = 'suspended'`면 예외 → 관리자가 아니면 하루 10개 제한 확인(`created_by = v_uid and created_at >= now() - interval '1 day'`) → `region`이 허용값이 아니면 `'기타'` → insert.

중복 처리는 두 겹이다. insert 전에 `name_key`로 조회해 있으면 그 행을 반환하고, insert가 `unique_violation`을 던지면 잡아서 다시 조회해 반환한다. 앞의 조회만으로는 동시 삽입을 막지 못한다.

조회에는 Task 1의 `public.gf_name_key(p_name)`을 쓴다. 생성 컬럼과 같은 함수라 판정이 어긋나지 않는다.

- [ ] **Step 4: 통과 확인**

Run: `bash test/sql/run.sh test/sql/02_add_course.sql`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add supabase test/sql
git commit -m "feat: gf_add_course RPC"
```

---

### Task 3: 관리자 플래그와 코스 수정·통합 RPC

**Files:**
- Modify: `supabase/migrations/2026-11-21-courses.sql`
- Modify: `supabase/schema.sql`
- Create: `test/sql/03_admin_course.sql`

**Interfaces:**
- Consumes: Task 1의 `gf_courses`
- Produces:
  - `gf_profiles.is_admin boolean not null default false`
  - `gf_rounds.course_id uuid references public.gf_courses(id)` — 통합이 과거
    라운드를 옮겨야 하므로 이 컬럼은 여기서 만든다. 이 컬럼을 쓰는
    `gf_create_round` 교체는 Task 4다
  - `public.gf_update_course(p_id uuid, p_name text default null, p_region text default null, p_par int default null, p_holes int default null, p_status text default null) returns public.gf_courses`
  - `public.gf_merge_course(p_from uuid, p_into uuid) returns public.gf_courses`
  - 둘 다 `authenticated`에 execute 권한 (내부에서 관리자 확인)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/sql/03_admin_course.sql`

```sql
-- Review Focus: 비관리자가 직접 호출 → 거부
assert_raises('관리자만 할 수 있습니다');  -- gf_update_course
assert_raises('관리자만 할 수 있습니다');  -- gf_merge_course
-- 관리자 수정: null은 유지, 준 값만 변경
assert (select par from gf_update_course(v_id, p_par => 71)) = 71;
assert (select name from gf_courses where id = v_id) = '원래이름';
-- 숨김
assert (select status from gf_update_course(v_id, p_status => 'hidden')) = 'hidden';
-- 통합: from이 merged로 바뀌고 라운드의 course_id가 into로 옮겨진다
assert (select status from gf_merge_course(v_from, v_into)) = 'merged';
assert (select count(*) from gf_rounds where course_id = v_from) = 0;
assert (select count(*) from gf_rounds where course_id = v_into) = 1;
-- Review Focus: 자기 자신으로 통합 → 거부
assert_raises('같은 골프장으로는 통합할 수 없습니다');
-- 없는 id → 거부
assert_raises('골프장을 찾을 수 없습니다');
```

- [ ] **Step 2: 실패 확인**

Run: `bash test/sql/run.sh test/sql/03_admin_course.sql`
Expected: FAIL — `column "is_admin" does not exist`

- [ ] **Step 3: `is_admin`과 `course_id` 컬럼을 추가한다**

```sql
alter table public.gf_profiles add column if not exists is_admin boolean not null default false;
alter table public.gf_rounds   add column if not exists course_id uuid references public.gf_courses(id);
```

기존 컬럼 단위 권한(`grant insert (id,name,region,hcp)`, `grant update (name,region)`)이 이미 이 컬럼을 막고 있다. 권한 문을 다시 실행해 그대로인지만 확인한다 — 새 컬럼이 생겼다고 권한이 넓어지지는 않지만, 마이그레이션에 명시해 두면 나중에 읽는 사람이 헷갈리지 않는다.

- [ ] **Step 4: 두 RPC를 구현한다**

공통으로 `auth.uid()`의 `gf_profiles.is_admin`을 확인하고 아니면 `관리자만 할 수 있습니다` 예외.

`gf_update_course`는 `coalesce(p_x, 기존값)` 방식으로 갱신한다. `p_status`는 `active`/`hidden`만 허용한다 — `merged`는 `gf_merge_course`를 통해서만 설정된다.

`gf_merge_course`는 `p_from = p_into`면 예외, 둘 중 하나라도 없으면 예외. `gf_rounds.course_id`를 `p_into`로 옮긴 뒤 `p_from`을 `status='merged', merged_into=p_into`로 바꾼다.

- [ ] **Step 5: 통과 확인**

Run: `bash test/sql/run.sh test/sql/03_admin_course.sql`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add supabase test/sql
git commit -m "feat: is_admin 플래그와 코스 수정·통합 RPC"
```

---

### Task 4: `gf_rounds.course_id`와 `gf_create_round` 시그니처 변경

**Files:**
- Modify: `supabase/migrations/2026-11-21-courses.sql`
- Modify: `supabase/schema.sql`
- Create: `test/sql/04_create_round.sql`

**Interfaces:**
- Consumes: Task 1의 `gf_courses`
- Consumes: Task 3의 `gf_rounds.course_id`
- Produces:
  - `public.gf_create_round(p_course_id uuid) returns public.gf_rounds` — 기존 `(text,int)` 버전은 제거
  - 클라이언트는 `A.sb.rpc('gf_create_round', {p_course_id})`로 부른다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/sql/04_create_round.sql`

```sql
-- 코스에서 par·holes·이름이 채워진다
v_round := gf_create_round(v_course_id);
assert v_round.par = 71;            -- 코스의 par가 71일 때
assert v_round.course = '테스트 골프장';
assert v_round.course_id = v_course_id;
-- Review Focus: 숨김/통합 코스로는 열 수 없다
assert_raises('선택할 수 없는 골프장입니다');  -- status='hidden'
assert_raises('선택할 수 없는 골프장입니다');  -- status='merged'
-- 없는 코스
assert_raises('골프장을 찾을 수 없습니다');
-- 옛 시그니처는 사라졌다
assert (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='gf_create_round') = 1;
```

- [ ] **Step 2: 실패 확인**

Run: `bash test/sql/run.sh test/sql/04_create_round.sql`
Expected: FAIL — `function gf_create_round(uuid) does not exist`

- [ ] **Step 3: 함수를 교체한다**

`drop function if exists public.gf_create_round(text, int);` 후 `gf_create_round(p_course_id uuid)`를 만든다. 기존 본문(코드 생성 루프, 프로필 확인, 호스트 등록)은 그대로 두고, 코스 조회를 앞에 붙여 `course`/`course_id`/`par`/`holes`를 코스에서 채운다. `status <> 'active'`면 예외.

`grant execute on function public.gf_create_round(uuid) to authenticated;`

- [ ] **Step 4: 통과 확인**

Run: `bash test/sql/run.sh test/sql/04_create_round.sql`
Expected: PASS

- [ ] **Step 5: 전체 SQL 테스트를 한 번에 돌린다**

Run: `for f in test/sql/0*.sql; do bash test/sql/run.sh $f || exit 1; done`
Expected: 전부 PASS.

- [ ] **Step 6: 커밋**

```bash
git add supabase test/sql
git commit -m "feat: 라운드에 course_id 연결, 파를 코스에서 가져오도록 변경"
```

---

### Task 5: 클라이언트 — 코스 목록·검색·추가

**Files:**
- Modify: `index.html` (인라인 스크립트)
- Create: `test/js/courses.test.js`
- Create: `test/js/extract.js`

**Interfaces:**
- Consumes: `gf_add_course`, `gf_create_round(p_course_id)`, `gf_courses` select
- Produces: 전역 상태 `A.courses` (배열), `A.courseSel` (선택된 코스 객체), 함수 `loadCourses()`, `filterCourses(list, q)`, `groupCourses(list)`, `pickCourse(id)`, `addCourse()`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/js/extract.js`는 `index.html`에서 마지막 `<script>` 블록을 꺼내 vm 컨텍스트에서 실행하고 전역을 돌려준다 (이 저장소에서 이미 쓰던 방식).

`test/js/courses.test.js` — 순수 함수만 검증한다. DOM과 네트워크는 건드리지 않는다.

```js
// 검색: 공백·대소문자 무시, 부분 일치
assert.deepEqual(filterCourses(L, ' 몽고 ').map(c=>c.name), ['몽고메리 링크스']);
// 빈 검색어는 전체
assert.equal(filterCourses(L, '').length, L.length);
// hidden/merged는 목록에서 빠진다
assert.ok(!filterCourses(L, '').some(c => c.status !== 'active'));
// 권역 그룹: 북부→중부→남부→기타 순서, 빈 권역은 생략
assert.deepEqual(groupCourses(L).map(g=>g[0]), ['북부','중부','남부']);
```

- [ ] **Step 2: 실패 확인**

Run: `node test/js/courses.test.js`
Expected: FAIL — `filterCourses is not defined`

- [ ] **Step 3: 상태와 순수 함수를 구현한다**

`A`에 `courses:[]`, `courseSel:null`, `courseQ:''`, `courseAdding:false`를 넣는다.
`loadCourses()`는 `A.sb.from('gf_courses').select('*').eq('status','active').order('region').order('name')`로 받아 `A.courses`에 넣는다. 로그인 후(`loadProfile` 끝)와 코스 추가 후에 부른다.
`filterCourses(list, q)`, `groupCourses(list)`는 순수 함수로 둔다 — 그래야 위 테스트가 DOM 없이 돈다.

- [ ] **Step 4: 통과 확인**

Run: `node test/js/courses.test.js`
Expected: PASS

- [ ] **Step 5: 코스 선택 화면을 교체한다**

`index.html`의 하드코딩된 4개 버튼 블록(`['베어즈베스트 청라',...]`)을 제거하고 다음으로 바꾼다.

- 검색 입력 (`oninput`으로 `A.courseQ` 갱신 후 목록만 다시 그린다)
- "최근 친 골프장" — `A.logs`의 `gf_rounds.course_id`에서 중복 제거해 최대 3개를 맨 위에
- 권역별 목록. 각 항목에 `파 72 · 18홀` 부기
- 하단 `+ 골프장 추가` → 폼(이름, 권역 select, 파 number 기본 72, 홀수 select 기본 18) → `gf_add_course` 호출 → 성공 시 `loadCourses()` 후 그 코스를 선택 상태로

`createRound()`는 `A.courseSel.id`를 `p_course_id`로 넘긴다. `p_par`는 보내지 않는다. 코스 미선택이면 `골프장을 선택해 주세요` 오류.

- [ ] **Step 6: 문법과 렌더링을 확인한다**

Run: `node test/js/extract.js --check && node test/js/courses.test.js`
Expected: 문법 OK, 테스트 PASS

- [ ] **Step 7: 커밋**

```bash
git add index.html test/js
git commit -m "feat: 골프장 검색·선택·추가 화면"
```

---

### Task 6: 클라이언트 — 관리자 편집

**Files:**
- Modify: `index.html`
- Modify: `test/js/courses.test.js`

**Interfaces:**
- Consumes: `gf_update_course`, `gf_merge_course`, `A.profile.is_admin`
- Produces: `isAdmin()`, `editCourse(id)`, `saveCourse()`, `mergeCourse()`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```js
// is_admin이 아니면 편집 버튼 마크업이 없다
A.profile = { is_admin: false };
assert.ok(!courseRow(C).includes('data-edit'));
A.profile = { is_admin: true };
assert.ok(courseRow(C).includes('data-edit'));
// 프로필이 없을 때도 터지지 않는다
A.profile = null;
assert.ok(!courseRow(C).includes('data-edit'));
```

- [ ] **Step 2: 실패 확인**

Run: `node test/js/courses.test.js`
Expected: FAIL — `courseRow is not defined`

- [ ] **Step 3: 구현한다**

`isAdmin()`은 `!!(A.profile && A.profile.is_admin)`. `courseRow(c)`가 한 항목의 마크업을 만들고 관리자일 때만 편집 버튼을 넣는다.

편집 폼은 추가 폼과 같은 필드에 `숨김` 토글과 `다른 골프장으로 통합`(select) 을 더한다. 저장은 `gf_update_course`, 통합은 `gf_merge_course`를 부르고 둘 다 끝나면 `loadCourses()`.

- [ ] **Step 4: 통과 확인**

Run: `node test/js/courses.test.js`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add index.html test/js
git commit -m "feat: 관리자 코스 편집·통합"
```

---

### Task 7: 배포 안내와 전체 검증

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-11-21-golf-courses-design.md` (상태를 완료로)

**Interfaces:**
- Consumes: 앞의 모든 태스크

- [ ] **Step 1: 빈 DB에 마이그레이션 전체를 두 번 실행한다**

Run: `bash test/sql/run.sh --migration-twice`
Expected: 두 번째 실행도 오류 없이 끝난다 (재실행 가능성 확인)

- [ ] **Step 2: 전체 테스트를 돌린다**

Run: `for f in test/sql/0*.sql; do bash test/sql/run.sh $f || exit 1; done && node test/js/courses.test.js`
Expected: 전부 PASS

- [ ] **Step 3: README에 배포 순서를 쓴다**

SQL 먼저, 앱 나중. 그리고 첫 관리자 지정 방법:
`update public.gf_profiles set is_admin = true where id = '<auth.users의 id>';`
순서를 어기면 새 앱이 없는 함수를 불러 라운드 열기가 실패한다는 점을 명시한다.

- [ ] **Step 4: 커밋하고 푸시한다**

```bash
git add README.md docs
git commit -m "docs: 골프장 기능 배포 순서"
git push origin main
```
