-- Tranquila: Loyverse sales data synced by the loyverse-sync Edge Function.
create extension if not exists pg_cron;
create extension if not exists pg_net;

create schema if not exists loyverse;
revoke all on schema loyverse from public, anon, authenticated;

create table loyverse.stores (
  id text primary key,
  name text not null,
  raw jsonb not null,
  synced_at timestamptz not null default now()
);

create table loyverse.payment_types (
  id text primary key,
  name text not null,
  type text,
  raw jsonb not null,
  synced_at timestamptz not null default now()
);

create table loyverse.employees (
  id text primary key,
  name text not null,
  raw jsonb not null,
  synced_at timestamptz not null default now()
);

create table loyverse.receipts (
  receipt_number text primary key,
  receipt_type text not null,
  store_id text,
  employee_id text,
  customer_id text,
  receipt_date timestamptz not null,
  updated_at timestamptz,
  cancelled_at timestamptz,
  total_money numeric(14,2) not null default 0,
  total_discount numeric(14,2) not null default 0,
  total_tax numeric(14,2) not null default 0,
  line_items jsonb not null default '[]',
  payments jsonb not null default '[]',
  raw jsonb not null,
  synced_at timestamptz not null default now()
);
create index receipts_receipt_date_idx on loyverse.receipts (receipt_date);
create index receipts_store_date_idx on loyverse.receipts (store_id, receipt_date);

-- key/value state: sync watermark and resume cursor, the shared sync_key,
-- functions_url (used by the cron jobs) and send_to_owner
create table loyverse.sync_state (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

create table loyverse.sync_log (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  receipts_upserted int not null default 0,
  status text not null default 'running',
  message text
);

-- LINE groups the bot was invited to; reports go only to active ones,
-- and only the owner (LINE_TO) can activate a group from inside it.
create table loyverse.line_targets (
  id text primary key,
  kind text not null check (kind in ('group', 'room')),
  name text,
  active boolean not null default false,
  joined_at timestamptz not null default now(),
  changed_at timestamptz not null default now()
);

alter table loyverse.stores enable row level security;
alter table loyverse.payment_types enable row level security;
alter table loyverse.employees enable row level security;
alter table loyverse.receipts enable row level security;
alter table loyverse.sync_state enable row level security;
alter table loyverse.sync_log enable row level security;
alter table loyverse.line_targets enable row level security;

-- net sales per receipt: refunds negative, cancelled receipts zero
create view loyverse.receipt_sales with (security_invoker = true) as
select
  r.receipt_number,
  r.receipt_type,
  r.store_id,
  coalesce(s.name, r.store_id) as store_name,
  r.receipt_date,
  (r.receipt_date at time zone 'Asia/Bangkok')::date as local_date,
  extract(hour from r.receipt_date at time zone 'Asia/Bangkok')::int as local_hour,
  case when r.cancelled_at is not null then 0
       when r.receipt_type = 'REFUND' then -r.total_money
       else r.total_money end as net_money,
  r.cancelled_at,
  r.line_items,
  r.payments,
  r.employee_id,
  coalesce(e.name, 'ไม่ระบุ') as employee_name
from loyverse.receipts r
left join loyverse.stores s on s.id = r.store_id
left join loyverse.employees e on e.id = r.employee_id;

-- one row per sold line; refunds negative; cost_known is false when Loyverse has no cost for the item
create view loyverse.line_sales with (security_invoker = true) as
select
  s.receipt_number,
  s.local_date,
  s.employee_name,
  li->>'item_name' as item,
  sign * (li->>'quantity')::numeric as qty,
  sign * (li->>'total_money')::numeric as sales,
  sign * coalesce((li->>'cost_total')::numeric, 0) as cost,
  coalesce((li->>'cost_total')::numeric, 0) > 0 as cost_known
from loyverse.receipt_sales s
cross join lateral (select case when s.receipt_type = 'REFUND' then -1 else 1 end as sign) k
cross join lateral jsonb_array_elements(s.line_items) li
where s.cancelled_at is null;

insert into loyverse.sync_state (key, value)
values ('sync_key', encode(gen_random_bytes(24), 'hex'));
