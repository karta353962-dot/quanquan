-- =========================================================
-- 券券日記・階段二  Supabase 資料庫設定
-- 用法：Supabase 後台 → SQL Editor → New query → 貼上全部 → Run
-- 可以重複執行，不會刪除既有資料。
-- =========================================================

-- ---------- 票券 ----------
create table if not exists public.tickets (
  id                uuid primary key,
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title             text not null check (char_length(title) between 1 and 80),
  platform          text not null default 'other',
  platform_name     text not null default '',
  category          text not null default 'other',
  expires_on        date,                                  -- 只存日期，不做時區轉換
  expires_time      text check (expires_time is null or expires_time ~ '^\d{2}:\d{2}$'),
  value             text not null default '',
  order_no          text not null default '',
  original_url      text not null default '',
  order_url         text not null default '',
  redeem_code       text not null default '',
  note              text not null default '',
  reminders         int[] not null default '{}',
  remind_time       text not null default '09:00' check (remind_time ~ '^\d{2}:00$'),
  timezone          text not null default 'Asia/Taipei',
  ticket_type       text not null default 'single' check (ticket_type in ('single','multi','stored_value')),
  batch_id          uuid,
  batch_index       int  not null default 1,
  batch_total       int  not null default 1,
  status            text not null default 'active' check (status in ('active','used')),
  used_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  version           int  not null default 1,              -- 樂觀鎖版本號
  deleted_at        timestamptz,                           -- 軟刪除，第一版不自動永久刪除
  server_updated_at timestamptz not null default now(),    -- 伺服器時間，供增量同步
  unique (id, user_id)
);

-- ---------- 票券圖片（一張票券多張圖） ----------
create table if not exists public.ticket_images (
  id                uuid primary key,
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ticket_id         uuid not null,
  hash              text not null,                          -- SHA-256，對應 image_files
  kind              text not null default 'other' check (kind in ('info','qr','barcode','guide','other')),
  sort              int  not null default 0,
  is_primary        boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  version           int  not null default 1,
  deleted_at        timestamptz,
  server_updated_at timestamptz not null default now(),
  foreign key (ticket_id, user_id) references public.tickets(id, user_id) on delete cascade
);

-- ---------- 圖片檔案（依雜湊去重，同一檔案只存一份） ----------
create table if not exists public.image_files (
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  hash         text not null,
  path         text not null,
  content_type text not null default 'image/jpeg',
  size         bigint not null default 0,
  created_at   timestamptz not null default now(),
  primary key (user_id, hash)
);

create index if not exists tickets_sync_idx       on public.tickets (user_id, server_updated_at);
create index if not exists ticket_images_sync_idx on public.ticket_images (user_id, server_updated_at);
create index if not exists ticket_images_ticket_idx on public.ticket_images (ticket_id);

-- ---------- 觸發器：伺服器時間、版本檢查、不可改擁有者 ----------
create or replace function public.qq_before_write() returns trigger
language plpgsql set search_path = public as $$
begin
  new.server_updated_at := clock_timestamp();
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;
    if new.version <> old.version + 1 then
      raise exception 'version conflict: expected %, got %', old.version + 1, new.version
        using errcode = '40001';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists tickets_before_write on public.tickets;
create trigger tickets_before_write before insert or update on public.tickets
  for each row execute function public.qq_before_write();

drop trigger if exists ticket_images_before_write on public.ticket_images;
create trigger ticket_images_before_write before insert or update on public.ticket_images
  for each row execute function public.qq_before_write();

-- ---------- RLS：每個人只能讀寫自己的資料 ----------
alter table public.tickets       enable row level security;
alter table public.ticket_images enable row level security;
alter table public.image_files   enable row level security;

do $$
declare t text;
begin
  foreach t in array array['tickets','ticket_images','image_files'] loop
    execute format('drop policy if exists "own_select" on public.%I', t);
    execute format('drop policy if exists "own_insert" on public.%I', t);
    execute format('drop policy if exists "own_update" on public.%I', t);
    execute format('drop policy if exists "own_delete" on public.%I', t);
    execute format('create policy "own_select" on public.%I for select to authenticated using ((select auth.uid()) = user_id)', t);
    execute format('create policy "own_insert" on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "own_update" on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "own_delete" on public.%I for delete to authenticated using ((select auth.uid()) = user_id)', t);
  end loop;
end $$;

revoke all on public.tickets, public.ticket_images, public.image_files from anon;
grant select, insert, update, delete on public.tickets, public.ticket_images, public.image_files to authenticated;

-- ---------- 私人圖片空間 ----------
-- 路徑格式：<使用者 id>/<SHA-256>，只有本人讀得到
insert into storage.buckets (id, name, public, file_size_limit)
values ('ticket-images', 'ticket-images', false, 20971520)
on conflict (id) do update set public = false;

drop policy if exists "qq_images_select" on storage.objects;
drop policy if exists "qq_images_insert" on storage.objects;
drop policy if exists "qq_images_update" on storage.objects;
drop policy if exists "qq_images_delete" on storage.objects;
create policy "qq_images_select" on storage.objects for select to authenticated
  using (bucket_id = 'ticket-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "qq_images_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'ticket-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "qq_images_update" on storage.objects for update to authenticated
  using (bucket_id = 'ticket-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "qq_images_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'ticket-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
