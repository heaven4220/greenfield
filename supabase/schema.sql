-- ============================================================
-- GREENFIELD — 운영용 스키마 (Supabase / Postgres 15+)
-- 실행: Supabase Dashboard → SQL Editor → 전체 붙여넣기 → Run
-- 설계 원칙
--   1) 쓰기는 전부 SECURITY DEFINER 함수로만 (직접 INSERT/UPDATE 차단)
--   2) 핸디는 서버에서 계산 (클라이언트 조작 불가)
--   3) 승인 2명 · 전원 18홀 완료 조건을 DB가 강제
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- 회원 ----------
create table if not exists public.gf_profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  member_no   text unique,
  name        text not null check (char_length(name) between 1 and 20),
  region      text not null default '기타',
  hcp         numeric(4,1) not null default 27.0 check (hcp >= -5 and hcp <= 54),
  status      text not null default 'rookie' check (status in ('rookie','active','suspended')),
  rounds      int  not null default 0,
  created_at  timestamptz not null default now()
);

create sequence if not exists public.gf_member_seq start 101;

create or replace function public.gf_issue_member_no() returns trigger
language plpgsql as $$
begin
  if new.member_no is null then
    new.member_no := 'G' || to_char(now(),'YY') || '-' ||
                     lpad(nextval('public.gf_member_seq')::text, 6, '0');
  end if;
  return new;
end $$;

drop trigger if exists tr_gf_member_no on public.gf_profiles;
create trigger tr_gf_member_no before insert on public.gf_profiles
for each row execute function public.gf_issue_member_no();

-- ---------- 라운드 ----------
create table if not exists public.gf_rounds (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  course       text not null,
  par          int  not null default 72,
  holes        int  not null default 18,
  status       text not null default 'live' check (status in ('live','confirmed','void')),
  host_id      uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  confirmed_at timestamptz
);

create table if not exists public.gf_round_players (
  round_id    uuid not null references public.gf_rounds(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  hcp_at      numeric(4,1) not null default 27,
  approved_at timestamptz,
  joined_at   timestamptz not null default now(),
  primary key (round_id, user_id)
);

create table if not exists public.gf_scores (
  round_id   uuid not null references public.gf_rounds(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  hole       int  not null check (hole between 1 and 18),
  strokes    int  not null check (strokes between 1 and 20),
  par        int  not null default 4,
  updated_at timestamptz not null default now(),
  primary key (round_id, user_id, hole)
);

create table if not exists public.gf_round_results (
  id         bigserial primary key,
  round_id   uuid not null references public.gf_rounds(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  gross      int  not null,
  diff       numeric(5,1) not null,
  created_at timestamptz not null default now(),
  unique (round_id, user_id)
);

create table if not exists public.gf_handicap_log (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  round_id   uuid references public.gf_rounds(id) on delete set null,
  gross      int,
  before_hcp numeric(4,1),
  after_hcp  numeric(4,1),
  grade      text,
  created_at timestamptz not null default now()
);

create index if not exists ix_gf_scores_round   on public.gf_scores(round_id);
create index if not exists ix_gf_players_round  on public.gf_round_players(round_id);
create index if not exists ix_gf_results_user   on public.gf_round_results(user_id, created_at desc);
create index if not exists ix_gf_profiles_hcp   on public.gf_profiles(hcp);

-- ---------- 등급 / 핸디 엔진 ----------
create or replace function public.gf_grade(p_hcp numeric) returns text
language sql immutable as $$
  select case
    when round(p_hcp) <= 10 then 'A'
    when round(p_hcp) <= 18 then 'B'
    when round(p_hcp) <= 27 then 'C'
    else 'D' end
$$;

create or replace function public.gf_pars() returns int[]
language sql immutable as $$
  select array[4,4,5,3,4,4,3,5,4, 4,3,4,4,5,4,3,5,4]::int[]
$$;

-- WHS 방식: 최근 20라운드 중 베스트 N개의 평균 (라운드 수에 따라 N 결정)
create or replace function public.gf_hcp_from(p_diffs numeric[]) returns numeric
language plpgsql immutable as $$
declare
  n int := coalesce(array_length(p_diffs,1),0);
  k int;
  av numeric;
begin
  if n < 3 then return null; end if;   -- 공식 핸디는 확정 3라운드부터
  k := case when n <= 2 then 1 when n <= 4 then 1 when n <= 8 then 2
            when n <= 11 then 3 when n <= 14 then 4 when n <= 16 then 5
            when n <= 18 then 6 when n = 19 then 7 else 8 end;
  select avg(d) into av from (
    select d from unnest(p_diffs) as d order by d asc limit k
  ) t;
  return greatest(0.1, round(av,1));
end $$;

-- ---------- 라운드 개설 / 참여 ----------
create or replace function public.gf_create_round(p_course text, p_par int default 72)
returns public.gf_rounds
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_prof public.gf_profiles;
  v_code text;
  v_round public.gf_rounds;
  i int;
begin
  if v_uid is null then raise exception '로그인이 필요합니다'; end if;
  select * into v_prof from gf_profiles where id = v_uid;
  if not found then raise exception '프로필을 먼저 만들어 주세요'; end if;
  if v_prof.status = 'suspended' then raise exception '이용이 제한된 계정입니다'; end if;

  for i in 1..10 loop
    v_code := upper(substr(replace(replace(encode(gen_random_bytes(4),'base64'),'/',''),'+',''),1,4));
    begin
      insert into gf_rounds (code, course, par, host_id)
      values (v_code, p_course, p_par, v_uid)
      returning * into v_round;
      exit;
    exception when unique_violation then
      if i = 10 then raise exception '코드 생성 실패, 다시 시도해 주세요'; end if;
    end;
  end loop;

  insert into gf_round_players (round_id, user_id, name, hcp_at)
  values (v_round.id, v_uid, v_prof.name, v_prof.hcp);

  return v_round;
end $$;

create or replace function public.gf_join_round(p_code text)
returns public.gf_rounds
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_prof public.gf_profiles;
  v_round public.gf_rounds;
  v_count int;
begin
  if v_uid is null then raise exception '로그인이 필요합니다'; end if;
  select * into v_prof from gf_profiles where id = v_uid;
  if not found then raise exception '프로필을 먼저 만들어 주세요'; end if;

  select * into v_round from gf_rounds where code = upper(trim(p_code)) and status = 'live';
  if not found then raise exception '그 코드로 열린 라운드가 없습니다'; end if;

  if exists (select 1 from gf_round_players where round_id = v_round.id and user_id = v_uid) then
    return v_round;
  end if;

  select count(*) into v_count from gf_round_players where round_id = v_round.id;
  if v_count >= 4 then raise exception '이 조는 이미 4명입니다'; end if;

  insert into gf_round_players (round_id, user_id, name, hcp_at)
  values (v_round.id, v_uid, v_prof.name, v_prof.hcp);

  return v_round;
end $$;

-- ---------- 스코어 입력 ----------
create or replace function public.gf_submit_score(p_round uuid, p_hole int, p_strokes int)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  v_pars int[] := gf_pars();
begin
  if v_uid is null then raise exception '로그인이 필요합니다'; end if;
  if p_hole < 1 or p_hole > 18 then raise exception '홀 번호가 올바르지 않습니다'; end if;
  if p_strokes < 1 or p_strokes > 20 then raise exception '타수가 올바르지 않습니다'; end if;

  select status into v_status from gf_rounds where id = p_round;
  if v_status is null then raise exception '라운드를 찾을 수 없습니다'; end if;
  if v_status <> 'live' then raise exception '확정된 라운드는 수정할 수 없습니다'; end if;
  if not exists (select 1 from gf_round_players where round_id = p_round and user_id = v_uid) then
    raise exception '이 라운드의 참가자가 아닙니다';
  end if;

  insert into gf_scores (round_id, user_id, hole, strokes, par, updated_at)
  values (p_round, v_uid, p_hole, p_strokes, v_pars[p_hole], now())
  on conflict (round_id, user_id, hole)
  do update set strokes = excluded.strokes, updated_at = now();
end $$;

-- ---------- 동반자 승인 ----------
create or replace function public.gf_approve(p_round uuid)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_round public.gf_rounds;
  v_cnt int;
begin
  if v_uid is null then raise exception '로그인이 필요합니다'; end if;
  select * into v_round from gf_rounds where id = p_round;
  if not found then raise exception '라운드를 찾을 수 없습니다'; end if;
  if v_round.status <> 'live' then raise exception '이미 확정된 라운드입니다'; end if;
  if v_uid = v_round.host_id then raise exception '주최자는 승인할 수 없습니다'; end if;
  if not exists (select 1 from gf_round_players where round_id = p_round and user_id = v_uid) then
    raise exception '이 라운드의 참가자가 아닙니다';
  end if;

  update gf_round_players set approved_at = now()
   where round_id = p_round and user_id = v_uid and approved_at is null;

  select count(*) into v_cnt from gf_round_players
   where round_id = p_round and user_id <> v_round.host_id and approved_at is not null;
  return v_cnt;
end $$;

-- ---------- 확정 + 핸디 재계산 (서버에서만) ----------
create or replace function public.gf_confirm_round(p_round uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  r public.gf_rounds;
  pl public.gf_round_players;
  v_appr int;
  v_incomplete int;
  v_gross int;
  v_diff numeric;
  v_diffs numeric[];
  v_before numeric;
  v_after numeric;
  v_result jsonb := '[]'::jsonb;
  v_entry jsonb;
begin
  if v_uid is null then raise exception '로그인이 필요합니다'; end if;

  select * into r from gf_rounds where id = p_round for update;
  if not found then raise exception '라운드를 찾을 수 없습니다'; end if;
  if r.status = 'confirmed' then
    return jsonb_build_object('status','confirmed','already',true);
  end if;

  if not exists (select 1 from gf_round_players where round_id = p_round and user_id = v_uid) then
    raise exception '이 라운드의 참가자가 아닙니다';
  end if;

  select count(*) into v_appr from gf_round_players
   where round_id = p_round and user_id <> r.host_id and approved_at is not null;
  if v_appr < 2 then raise exception '동반자 2명의 승인이 필요합니다 (현재 %)', v_appr; end if;

  select count(*) into v_incomplete from gf_round_players p
   where p.round_id = p_round
     and (select count(*) from gf_scores s where s.round_id = p_round and s.user_id = p.user_id) < r.holes;
  if v_incomplete > 0 then raise exception '전원 18홀 입력이 끝나야 확정할 수 있습니다'; end if;

  for pl in select * from gf_round_players where round_id = p_round loop
    select sum(strokes) into v_gross from gf_scores where round_id = p_round and user_id = pl.user_id;
    v_diff := v_gross - r.par;

    insert into gf_round_results (round_id, user_id, gross, diff)
    values (p_round, pl.user_id, v_gross, v_diff)
    on conflict (round_id, user_id) do nothing;

    select hcp into v_before from gf_profiles where id = pl.user_id;

    select array(select diff from gf_round_results
                  where user_id = pl.user_id order by created_at desc limit 20)
      into v_diffs;

    v_after := gf_hcp_from(v_diffs);
    if v_after is null then
      v_after := v_before;                     -- 3라운드 미만: 신고 핸디 유지
    else
      v_after := greatest(v_before - 3.0, least(v_before + 3.0, v_after));
      v_after := greatest(0.1, round(v_after,1));
    end if;

    update gf_profiles
       set hcp = v_after,
           rounds = rounds + 1,
           status = case when rounds + 1 >= 5 then 'active' else status end
     where id = pl.user_id;

    insert into gf_handicap_log (user_id, round_id, gross, before_hcp, after_hcp, grade)
    values (pl.user_id, p_round, v_gross, v_before, v_after, gf_grade(v_after));

    v_entry := jsonb_build_object(
      'user_id', pl.user_id, 'name', pl.name, 'gross', v_gross,
      'before', v_before, 'after', v_after,
      'grade', gf_grade(v_after), 'grade_before', gf_grade(v_before),
      'promoted', gf_grade(v_after) <> gf_grade(v_before)
    );
    v_result := v_result || jsonb_build_array(v_entry);
  end loop;

  update gf_rounds set status = 'confirmed', confirmed_at = now() where id = p_round;

  return jsonb_build_object('status','confirmed','players',v_result);
end $$;

-- ---------- 랭킹 ----------
create or replace function public.gf_leaderboard(p_grade text default null, p_limit int default 50)
returns table (
  rank bigint, user_id uuid, name text, member_no text, region text,
  hcp numeric, grade text, rounds int, status text
)
language sql stable security definer set search_path = public, pg_temp as $$
  select row_number() over (order by p.hcp asc, p.rounds desc) as rank,
         p.id, p.name, p.member_no, p.region, p.hcp, gf_grade(p.hcp), p.rounds, p.status
    from gf_profiles p
   where p.status <> 'suspended'
     and (p_grade is null or gf_grade(p.hcp) = p_grade)
   order by p.hcp asc, p.rounds desc
   limit greatest(1, least(coalesce(p_limit,50), 200))
$$;

-- ---------- RLS ----------
alter table public.gf_profiles       enable row level security;
alter table public.gf_rounds         enable row level security;
alter table public.gf_round_players  enable row level security;
alter table public.gf_scores         enable row level security;
alter table public.gf_round_results  enable row level security;
alter table public.gf_handicap_log   enable row level security;

drop policy if exists p_prof_read on public.gf_profiles;
drop policy if exists p_prof_ins  on public.gf_profiles;
drop policy if exists p_prof_upd  on public.gf_profiles;
drop policy if exists p_round_read on public.gf_rounds;
drop policy if exists p_play_read on public.gf_round_players;
drop policy if exists p_score_read on public.gf_scores;
drop policy if exists p_res_read on public.gf_round_results;
drop policy if exists p_log_read on public.gf_handicap_log;

create policy p_prof_read on public.gf_profiles for select to authenticated using (true);
create policy p_prof_ins  on public.gf_profiles for insert to authenticated with check (auth.uid() = id);
create policy p_prof_upd  on public.gf_profiles for update to authenticated using (auth.uid() = id);

create policy p_round_read on public.gf_rounds        for select to authenticated using (true);
create policy p_play_read  on public.gf_round_players for select to authenticated using (true);
create policy p_score_read on public.gf_scores        for select to authenticated using (true);
create policy p_res_read   on public.gf_round_results for select to authenticated using (true);
create policy p_log_read   on public.gf_handicap_log  for select to authenticated using (true);

-- 클라이언트가 직접 손댈 수 있는 컬럼 제한 (핸디·회원번호·라운드수는 서버만)
revoke all on public.gf_profiles from authenticated;
grant select on public.gf_profiles to authenticated;
grant insert (id, name, region, hcp) on public.gf_profiles to authenticated;
grant update (name, region) on public.gf_profiles to authenticated;

revoke all on public.gf_rounds, public.gf_round_players, public.gf_scores,
              public.gf_round_results, public.gf_handicap_log from authenticated;
grant select on public.gf_rounds, public.gf_round_players, public.gf_scores,
                public.gf_round_results, public.gf_handicap_log to authenticated;

grant execute on function public.gf_create_round(text,int) to authenticated;
grant execute on function public.gf_join_round(text)      to authenticated;
grant execute on function public.gf_submit_score(uuid,int,int) to authenticated;
grant execute on function public.gf_approve(uuid)         to authenticated;
grant execute on function public.gf_confirm_round(uuid)   to authenticated;
grant execute on function public.gf_leaderboard(text,int) to authenticated;
do $$ begin
  grant execute on function public.gf_leaderboard(text,int) to anon;
exception when undefined_object then null; end $$;

-- ---------- Realtime ----------
do $$ begin alter publication supabase_realtime add table public.gf_scores; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.gf_rounds; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.gf_round_players; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.gf_profiles; exception when duplicate_object then null; end $$;
