-- STUDEX: схема базы данных. Выполнить один раз в Supabase: SQL Editor -> New query -> Run.
-- Все таблицы закрыты (RLS без политик): доступ только через серверную функцию api.

create sequence if not exists user_number_seq start 1;
create sequence if not exists order_number_seq start 1001;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  number bigint not null unique default nextval('user_number_seq'),
  tg_id bigint not null unique,
  role text not null check (role in ('buyer','seller','admin','director')),
  blocked boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists invitation_codes (
  id bigint generated always as identity primary key,
  role text not null check (role in ('seller','admin','director')),
  code_hash char(64) not null unique,
  status text not null default 'unused' check (status in ('unused','used','revoked')),
  created_at timestamptz not null default now(),
  used_at timestamptz,
  used_by_user_id bigint
);

create table if not exists code_attempts (
  id bigint generated always as identity primary key,
  tg_id bigint not null,
  created_at timestamptz not null default now()
);

create table if not exists offers (
  id bigint generated always as identity primary key,
  seller_id uuid not null references users(id),
  title text not null check (char_length(title) between 5 and 120),
  category text not null,
  description text not null check (char_length(description) between 10 and 2000),
  term text not null default '1 день',
  format text not null default 'Чат',
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists ads (
  id bigint generated always as identity primary key,
  buyer_id uuid not null references users(id),
  title text not null check (char_length(title) between 5 and 120),
  category text not null,
  description text not null check (char_length(description) between 20 and 2000),
  term text not null,
  type text not null,
  status text not null default 'open' check (status in ('open','closed')),
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists ad_responses (
  ad_id bigint not null references ads(id) on delete cascade,
  seller_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  primary key (ad_id, seller_id)
);

create table if not exists orders (
  id bigint primary key default nextval('order_number_seq'),
  title text not null,
  category text not null,
  buyer_id uuid not null references users(id),
  seller_id uuid not null references users(id),
  status int not null default 0 check (status between 0 and 8),
  amount numeric(12,2) check (amount is null or amount > 0),
  amount_set boolean not null default false,
  rating int check (rating between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orders_buyer_idx on orders(buyer_id);
create index if not exists orders_seller_idx on orders(seller_id);

create table if not exists order_status_history (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders(id),
  status int not null,
  actor_id uuid references users(id),
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders(id),
  sender_id uuid references users(id),
  kind text not null check (kind in ('user','system')),
  body text not null check (char_length(body) <= 2000),
  created_at timestamptz not null default now()
);
create index if not exists messages_order_idx on messages(order_id);

-- Финансовый журнал: записи не редактируются, только добавляются.
create table if not exists ledger (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders(id),
  kind text not null check (kind in ('buyer_spent','seller_earned','commission')),
  user_id uuid not null references users(id),
  amount numeric(12,2) not null,
  created_at timestamptz not null default now(),
  unique (order_id, kind)
);

create table if not exists cash_payments (
  id bigint generated always as identity primary key,
  seller_id uuid not null references users(id),
  amount numeric(12,2) not null check (amount > 0),
  admin_id uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table if not exists complaints (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders(id),
  buyer_id uuid not null references users(id),
  status text not null default 'open' check (status in ('open','closed')),
  resolution text,
  created_at timestamptz not null default now()
);

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references users(id),
  action text not null,
  details text,
  created_at timestamptz not null default now()
);

create table if not exists notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references users(id),
  body text not null,
  created_at timestamptz not null default now()
);

alter table users enable row level security;
alter table invitation_codes enable row level security;
alter table code_attempts enable row level security;
alter table offers enable row level security;
alter table ads enable row level security;
alter table ad_responses enable row level security;
alter table orders enable row level security;
alter table order_status_history enable row level security;
alter table messages enable row level security;
alter table ledger enable row level security;
alter table cash_payments enable row level security;
alter table complaints enable row level security;
alter table audit_log enable row level security;
alter table notifications enable row level security;

-- Регистрация: без кода создаётся покупатель, с кодом выдаётся роль кода.
-- Всё в одной транзакции, номер пользователя выдаётся последовательностью.
create or replace function register_user(p_tg bigint, p_hash text)
returns users
language plpgsql
security definer
set search_path = public
as $$
declare
  u users;
  c invitation_codes;
  had boolean;
begin
  select * into u from users where tg_id = p_tg;
  had := found;
  if had and (p_hash is null or u.role <> 'buyer') then
    return u;
  end if;
  if p_hash is null then
    insert into users(tg_id, role) values (p_tg, 'buyer') returning * into u;
    return u;
  end if;
  select * into c from invitation_codes where code_hash = p_hash and status = 'unused' for update;
  if not found then
    raise exception 'bad_code';
  end if;
  if had then
    update users set role = c.role where id = u.id returning * into u;
  else
    insert into users(tg_id, role) values (p_tg, c.role) returning * into u;
  end if;
  update invitation_codes set status = 'used', used_at = now(), used_by_user_id = u.number where id = c.id;
  return u;
end;
$$;

revoke all on function register_user(bigint, text) from public, anon, authenticated;
grant execute on function register_user(bigint, text) to service_role;
