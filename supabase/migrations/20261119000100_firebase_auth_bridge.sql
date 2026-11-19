-- Allow Firebase Auth to own sign-in while keeping app data isolated by the
-- existing internal profile UUIDs. Verified email/phone matches retain data.
alter table public.profiles
  drop constraint if exists profiles_id_fkey,
  add column if not exists firebase_uid text,
  add column if not exists phone text,
  add column if not exists user_metadata jsonb not null default '{}'::jsonb;

create unique index if not exists profiles_firebase_uid_key
  on public.profiles (firebase_uid)
  where firebase_uid is not null;

update public.profiles as profile
set phone = users.phone
from auth.users as users
where profile.id = users.id and profile.phone is null and users.phone is not null;

update public.profiles as profile
set user_metadata = coalesce(profile.user_metadata, '{}'::jsonb) ||
      (coalesce(users.raw_user_meta_data, '{}'::jsonb) - 'role'),
    updated_at = now()
from auth.users as users
where profile.id = users.id
  and coalesce(users.raw_user_meta_data, '{}'::jsonb) <> '{}'::jsonb;

do $$
declare
  table_name text;
  constraint_name text;
begin
  foreach table_name in array array['bookmarks', 'question_attempts', 'notes', 'habits', 'habit_logs'] loop
    for constraint_name in
      select conname
      from pg_constraint
      where conrelid = format('public.%I', table_name)::regclass
        and confrelid = 'auth.users'::regclass
        and contype = 'f'
    loop
      execute format('alter table public.%I drop constraint %I', table_name, constraint_name);
    end loop;
    execute format(
      'alter table public.%I add constraint %I foreign key (user_id) references public.profiles(id) on delete cascade',
      table_name,
      table_name || '_user_id_profiles_fkey'
    );
  end loop;
end;
$$;

create or replace function public.current_app_user_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  token_issuer text := auth.jwt() ->> 'iss';
  token_subject text := auth.jwt() ->> 'sub';
  resolved_id uuid;
begin
  if token_issuer = 'https://securetoken.google.com/pyq-cloud' then
    select profile.id into resolved_id
    from public.profiles as profile
    where profile.firebase_uid = token_subject;
    return resolved_id;
  end if;

  return auth.uid();
end;
$$;

revoke all on function public.current_app_user_id() from public, anon;
grant execute on function public.current_app_user_id() to authenticated;

create or replace function public.ensure_firebase_profile(p_full_name text default null)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  claims jsonb := auth.jwt();
  issuer text := claims ->> 'iss';
  subject text := claims ->> 'sub';
  verified_email text;
  verified_phone text;
  clean_name text := nullif(left(trim(coalesce(p_full_name, claims ->> 'name', '')), 80), '');
  profile public.profiles%rowtype;
begin
  if issuer <> 'https://securetoken.google.com/pyq-cloud'
     or claims ->> 'aud' <> 'pyq-cloud'
     or subject is null
     or claims ->> 'role' <> 'authenticated' then
    raise exception 'A verified PYQ Cloud Firebase session is required.' using errcode = '42501';
  end if;

  if claims ->> 'email_verified' = 'true' then
    verified_email := nullif(lower(trim(claims ->> 'email')), '');
  end if;
  -- Firebase only issues phone_number after the SMS credential has been
  -- confirmed, so a present phone_number claim is a verified number.
  verified_phone := nullif(trim(claims ->> 'phone_number'), '');

  select * into profile from public.profiles where firebase_uid = subject limit 1;
  if found then
    update public.profiles
    set email = coalesce(verified_email, email),
        phone = coalesce(verified_phone, phone),
        full_name = coalesce(clean_name, full_name),
        updated_at = now()
    where id = profile.id
    returning * into profile;
    return profile;
  end if;

  if verified_email is not null then
    select * into profile from public.profiles
    where lower(email) = verified_email and firebase_uid is null
    order by created_at limit 1;
  end if;
  if not found and verified_phone is not null then
    select * into profile from public.profiles
    where phone = verified_phone and firebase_uid is null
    order by created_at limit 1;
  end if;

  if found then
    update public.profiles
    set firebase_uid = subject,
        email = coalesce(verified_email, email),
        phone = coalesce(verified_phone, phone),
        full_name = coalesce(clean_name, full_name),
        updated_at = now()
    where id = profile.id
    returning * into profile;
    return profile;
  end if;

  insert into public.profiles (id, firebase_uid, email, phone, full_name, user_metadata)
  values (gen_random_uuid(), subject, verified_email, verified_phone, clean_name, '{}'::jsonb)
  returning * into profile;
  return profile;
end;
$$;

revoke all on function public.ensure_firebase_profile(text) from public, anon;
grant execute on function public.ensure_firebase_profile(text) to authenticated;

create or replace function public.update_my_firebase_metadata(p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile_id uuid;
  safe_patch jsonb;
  updated_metadata jsonb;
begin
  select ensured.id into profile_id
  from public.ensure_firebase_profile(null) as ensured;
  safe_patch := coalesce(p_patch, '{}'::jsonb)
    - 'id' - 'firebase_uid' - 'role' - 'email' - 'phone' - 'created_at' - 'updated_at';
  update public.profiles
  set user_metadata = coalesce(user_metadata, '{}'::jsonb) || safe_patch,
      updated_at = now()
  where id = profile_id
  returning user_metadata into updated_metadata;
  return updated_metadata;
end;
$$;

revoke all on function public.update_my_firebase_metadata(jsonb) from public, anon;
grant execute on function public.update_my_firebase_metadata(jsonb) to authenticated;

drop policy if exists "Users can view their own profile" on public.profiles;
create policy "Users can view their own profile" on public.profiles
  for select to authenticated using ((select public.current_app_user_id()) = id);
drop policy if exists "Users can insert their own profile" on public.profiles;
drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile" on public.profiles
  for update to authenticated using ((select public.current_app_user_id()) = id)
  with check ((select public.current_app_user_id()) = id);

drop policy if exists "Users manage their own bookmarks" on public.bookmarks;
create policy "Users manage their own bookmarks" on public.bookmarks
  for all to authenticated using ((select public.current_app_user_id()) = user_id)
  with check ((select public.current_app_user_id()) = user_id);
drop policy if exists "Users manage their own attempts" on public.question_attempts;
create policy "Users manage their own attempts" on public.question_attempts
  for all to authenticated using ((select public.current_app_user_id()) = user_id)
  with check ((select public.current_app_user_id()) = user_id);
drop policy if exists "Users manage their own notes" on public.notes;
create policy "Users manage their own notes" on public.notes
  for all to authenticated using ((select public.current_app_user_id()) = user_id)
  with check ((select public.current_app_user_id()) = user_id);
drop policy if exists "Users manage their own habits" on public.habits;
create policy "Users manage their own habits" on public.habits
  for all to authenticated using ((select public.current_app_user_id()) = user_id)
  with check ((select public.current_app_user_id()) = user_id);
drop policy if exists "Users manage their own habit logs" on public.habit_logs;
create policy "Users manage their own habit logs" on public.habit_logs
  for all to authenticated using ((select public.current_app_user_id()) = user_id)
  with check ((select public.current_app_user_id()) = user_id);

drop policy if exists "Users can upload their own avatar" on storage.objects;
create policy "Users can upload their own avatar"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select public.current_app_user_id())::text
  );
drop policy if exists "Users can read their own avatar" on storage.objects;
create policy "Users can read their own avatar"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select public.current_app_user_id())::text
  );
