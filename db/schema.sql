-- Attendance plugin — Supabase (Postgres) schema.
-- Tenant isolation is app-level: every row carries tenant_id (the Eesa tenant
-- id from the verified token) and every query filters on it. employee_ref is the
-- token `sub` (the Eesa user id). No Firestore, no Firebase.
--
-- Apply:  psql "$DATABASE_URL" -f db/schema.sql   (or paste into Supabase SQL editor)

create table if not exists zones (
    id          uuid primary key default gen_random_uuid(),
    tenant_id   text not null,
    name        text not null,
    center_lat  double precision not null,
    center_lng  double precision not null,
    radius_m    integer not null default 100 check (radius_m between 10 and 5000),
    active      boolean not null default true,
    created_at  timestamptz not null default now()
);
create index if not exists zones_tenant_idx on zones (tenant_id, active);

create table if not exists employees (
    tenant_id     text not null,
    employee_ref  text not null,          -- Eesa user id (token sub)
    name          text not null default '',
    active        boolean not null default true,
    created_at    timestamptz not null default now(),
    primary key (tenant_id, employee_ref)
);

create table if not exists events (
    id            uuid primary key default gen_random_uuid(),
    tenant_id     text not null,
    employee_ref  text not null,
    type          text not null check (type in ('check_in', 'check_out')),
    zone_id       uuid references zones (id) on delete set null,
    lat           double precision,
    lng           double precision,
    at            timestamptz not null default now()
);
create index if not exists events_emp_at_idx on events (tenant_id, employee_ref, at desc);
create index if not exists events_tenant_at_idx on events (tenant_id, at desc);

create table if not exists day_summaries (
    tenant_id      text not null,
    employee_ref   text not null,
    day            date not null,
    first_in       timestamptz,
    last_out       timestamptz,
    total_minutes  integer not null default 0,
    updated_at     timestamptz not null default now(),
    primary key (tenant_id, employee_ref, day)
);
create index if not exists day_tenant_day_idx on day_summaries (tenant_id, day);
