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

-- ===========================================================================
-- v2: plugin-owned roles, multi-location windows, work-intent, approvals, tz.
-- Idempotent — safe to re-run on an existing database.
-- ===========================================================================

-- Per-tenant settings — timezone drives correct LOCAL-day boundaries (not UTC).
create table if not exists tenant_settings (
    tenant_id   text primary key,
    timezone    text not null default 'UTC',
    updated_at  timestamptz not null default now()
);

-- Role membership: who is enrolled and as what. NO row = no access at all.
-- Roles are plugin-defined ('manager' | 'staff'), assigned in the plugin's OWN
-- config UI. pay_rate (per hour) feeds expected-pay + the QuickBooks bill.
create table if not exists memberships (
    tenant_id     text not null,
    employee_ref  text not null,          -- Eesa user id (token sub)
    role          text not null default 'staff',
    pay_rate      numeric(10,2),
    name          text not null default '',
    email         text not null default '',
    active        boolean not null default true,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    primary key (tenant_id, employee_ref)
);
create index if not exists memberships_tenant_idx on memberships (tenant_id, active);

-- Zones: permanence + an active window for temporary on-site work.
alter table zones add column if not exists is_permanent boolean not null default true;
alter table zones add column if not exists active_until date;

-- Events: did this presence count for work? The "Are you here to work?" NO path
-- still logs the event but with for_work=false so it's excluded from paid totals.
-- source distinguishes geofence / manual (admin) / banner (staff toggle).
alter table events add column if not exists for_work boolean not null default true;
alter table events add column if not exists source text not null default 'geofence';

-- Approvals + QuickBooks export tracking on the day summary.
alter table day_summaries add column if not exists approval_status text not null default 'pending';
alter table day_summaries add column if not exists approved_by text;
alter table day_summaries add column if not exists approved_at timestamptz;
alter table day_summaries add column if not exists exported_at timestamptz;

-- Optional per-person, per-day SCHEDULE (expected minutes). A row = the manager
-- set an expectation for that day; absence = no expectation. Drives the report's
-- Actual vs Expected vs Difference comparison.
create table if not exists schedules (
    tenant_id        text not null,
    employee_ref     text not null,
    day              date not null,
    expected_minutes integer not null default 0,
    note             text not null default '',
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    primary key (tenant_id, employee_ref, day)
);
create index if not exists schedules_tenant_day_idx on schedules (tenant_id, day);

-- ===========================================================================
-- v3: reusable schedule templates + a per-tenant work-type catalog (assigned
-- per user) + the work type chosen at check-in. Idempotent.
-- ===========================================================================

-- Reusable shift templates (a LIBRARY the manager assigns). Break is optional.
-- expected_minutes for an assigned day is computed from (end-start)-break.
create table if not exists schedule_templates (
    id           uuid primary key default gen_random_uuid(),
    tenant_id    text not null,
    name         text not null,
    start_time   time not null,
    end_time     time not null,
    break_start  time,
    break_end    time,
    active       boolean not null default true,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
create index if not exists sched_tpl_tenant_idx on schedule_templates (tenant_id, active);

-- When a schedule was created from a template, remember which (for display).
alter table schedules add column if not exists template_id uuid;

-- Per-tenant catalog of work/job types. Each is assigned to specific users
-- (memberships.work_type_ids); a user picks one at check-in ("here to work?").
create table if not exists work_types (
    id          uuid primary key default gen_random_uuid(),
    tenant_id   text not null,
    name        text not null,
    active      boolean not null default true,
    created_at  timestamptz not null default now()
);
create index if not exists work_types_tenant_idx on work_types (tenant_id, active);

-- Which catalog work types a user may pick (array of work_types.id as text).
alter table memberships add column if not exists work_type_ids jsonb not null default '[]'::jsonb;

-- The work type selected for a given presence event (null for check_out / legacy).
alter table events add column if not exists work_type text;
