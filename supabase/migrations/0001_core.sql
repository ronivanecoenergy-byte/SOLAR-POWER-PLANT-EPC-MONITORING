-- =====================================================================================
-- Solar Power Plant One-Stop Project Monitoring System — core schema
-- One project database (Principle 11.1). Every tracked table has a unique system key and its
-- Table ID from the General Layout (11.2). MMS and PV records are separate rows joined by the
-- table (discipline = 'MMS' | 'PV'). Installation, inspection and approval are separate but
-- connected statuses (11.3). Subcontractor submissions are kept apart from verified progress
-- (11.4). Access is role-based and enforced with row-level security (11.5).
-- =====================================================================================
create extension if not exists pgcrypto with schema extensions;

-- ---------- enums
create type public.app_role as enum ('admin','ceo','project_manager','construction_manager','pic_engineer',
  'qaqc_engineer','site_engineer','project_planner','subcontractor');
create type public.discipline as enum ('MMS','PV');
create type public.work_status as enum ('not_started','ongoing','on_hold','completed');
create type public.qa_status as enum ('none','ready_for_inspection','for_inspection','for_rectification','for_approval','approved');
create type public.report_status as enum ('submitted','verified','rejected');
create type public.inspection_stage as enum ('contractor','qaqc','client','final');
create type public.inspection_result as enum ('passed','failed');
create type public.request_status as enum ('open','scheduled','completed','cancelled');
create type public.punch_status as enum ('open','resubmitted','closed');

-- ---------- project + reference data
create table public.project (
  id int primary key default 1 check (id = 1),
  name text not null,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.blocks (
  code text primary key,           -- M01 .. M04
  name text not null,
  cad_layer text,
  sort int not null default 0
);

create table public.subcontractors (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,       -- TECHNO, JJC, SAL, RMS, AAPCI
  name text not null,
  aliases text[] not null default '{}',   -- other spellings found in drawings, e.g. {JJ,JJCES}
  color text not null,             -- assignment colour (from CAD legend, admin-configurable)
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.drawings (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  title text not null,
  purpose text not null,           -- baseline_geometry | table_ids | mms_status | pv_status | mms_assignment | pv_assignment | reference
  revision text,
  status text not null default 'active',  -- active | superseded | reference
  sha256 text,
  stats jsonb not null default '{}'::jsonb,
  notes text,
  imported_at timestamptz not null default now(),
  imported_by uuid
);

create table public.drone_layers (
  id uuid primary key default gen_random_uuid(),
  capture_date date not null,
  source_file text not null,
  bucket text not null default 'drone',
  prefix text not null,
  meta jsonb not null,             -- tile grid + registration fit
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- tables (tracked elements)
create table public.pv_tables (
  id uuid primary key default gen_random_uuid(),
  sys_key text not null unique,    -- system ID, e.g. T0001 (stable across drawing revisions)
  table_code text,                 -- Table ID from the General Layout, e.g. M04-11-07
  block_code text references public.blocks(code),
  id_col text,                     -- 2nd ID group (increases eastward)
  id_row text,                     -- 3rd ID group (increases southward)
  cad_layer text,
  x0 double precision not null, y0 double precision not null,
  x1 double precision not null, y1 double precision not null,   -- CAD metres, MMS_APPROVED_2.0 baseline
  modules_required int not null default 28,
  module_rows int not null default 4,
  module_cols int not null default 7,
  cad_outlines int not null default 1,
  id_flags text[] not null default '{}',
  remarks text,
  created_at timestamptz not null default now()
);
create index pv_tables_code_idx on public.pv_tables (table_code);
create index pv_tables_block_idx on public.pv_tables (block_code);

-- ---------- people
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  role public.app_role,            -- null = waiting for an administrator to assign a role
  subcontractor_id uuid references public.subcontractors(id),
  assigned_blocks text[],          -- Site Engineer scope; null = all blocks
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint subcon_role_needs_company check (role is distinct from 'subcontractor' or subcontractor_id is not null)
);

-- ---------- assignment, progress, submissions
create table public.assignments (
  table_id uuid not null references public.pv_tables(id) on delete cascade,
  discipline public.discipline not null,
  subcontractor_id uuid not null references public.subcontractors(id),
  source text not null default 'manual',
  assigned_by uuid,
  assigned_at timestamptz not null default now(),
  primary key (table_id, discipline)
);
create index assignments_subcon_idx on public.assignments (subcontractor_id, discipline);

create table public.progress (
  table_id uuid not null references public.pv_tables(id) on delete cascade,
  discipline public.discipline not null,
  work_status public.work_status not null default 'not_started',
  qa_status public.qa_status not null default 'none',
  progress_pct smallint not null default 0 check (progress_pct between 0 and 100),
  installed_modules int not null default 0 check (installed_modules >= 0),
  module_mask int not null default 0,          -- PV: bit n-1 set = module n installed
  on_hold_reason text,
  target_start date, target_finish date,
  actual_start date, actual_finish date,
  approved_at timestamptz, approved_by uuid,
  verified_at timestamptz, verified_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  source text not null default 'manual',
  primary key (table_id, discipline)
);

create table public.accomplishments (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.pv_tables(id) on delete cascade,
  discipline public.discipline not null,
  subcontractor_id uuid references public.subcontractors(id),
  work_status public.work_status not null,
  progress_pct smallint,
  installed_modules int,
  module_mask int,
  actual_start date, actual_finish date,
  note text,
  status public.report_status not null default 'submitted',
  submitted_by uuid, submitted_at timestamptz not null default now(),
  reviewed_by uuid, reviewed_at timestamptz, review_note text
);
create index accomplishments_status_idx on public.accomplishments (status, discipline);

-- ---------- quality
create table public.inspection_requests (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.pv_tables(id) on delete cascade,
  discipline public.discipline not null,
  stage public.inspection_stage not null default 'qaqc',
  status public.request_status not null default 'open',
  is_reinspection boolean not null default false,
  note text,
  scheduled_for date,
  requested_by uuid, requested_at timestamptz not null default now(),
  scheduled_by uuid, closed_at timestamptz
);
create index inspection_requests_open_idx on public.inspection_requests (status, discipline);

create table public.inspections (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.pv_tables(id) on delete cascade,
  discipline public.discipline not null,
  stage public.inspection_stage not null,
  request_id uuid references public.inspection_requests(id),
  result public.inspection_result not null,
  comments text,
  nonconformities text,
  inspector_id uuid,
  inspector_name text,
  inspected_at timestamptz not null default now()
);

create table public.punch_items (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.pv_tables(id) on delete cascade,
  discipline public.discipline not null,
  inspection_id uuid references public.inspections(id),
  subcontractor_id uuid references public.subcontractors(id),
  description text not null,
  status public.punch_status not null default 'open',
  due_date date,
  raised_by uuid, raised_at timestamptz not null default now(),
  resubmitted_by uuid, resubmitted_at timestamptz, resubmit_note text,
  closed_by uuid, closed_at timestamptz, close_note text
);
create index punch_items_status_idx on public.punch_items (status, discipline);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.pv_tables(id) on delete cascade,
  discipline public.discipline not null,
  stage public.inspection_stage not null default 'client',
  approved_by uuid,
  approver_name text,
  reference text,
  note text,
  source text not null default 'manual',
  approved_at timestamptz not null default now()
);

-- ---------- field records
create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  table_id uuid references public.pv_tables(id) on delete cascade,
  discipline public.discipline,
  entity text not null default 'table',   -- table | inspection | punch | accomplishment | constraint
  entity_id uuid,
  storage_path text not null unique,
  file_name text not null,
  mime text,
  size_bytes bigint,
  caption text,
  uploaded_by uuid default auth.uid(),
  uploaded_at timestamptz not null default now()
);

create table public.site_constraints (
  id uuid primary key default gen_random_uuid(),
  table_id uuid references public.pv_tables(id) on delete cascade,
  block_code text references public.blocks(code),
  discipline public.discipline,
  category text not null default 'other',  -- material | access | weather | design | equipment | manpower | other
  description text not null,
  is_stoppage boolean not null default false,
  status text not null default 'open' check (status in ('open','resolved')),
  raised_by uuid default auth.uid(), raised_at timestamptz not null default now(),
  resolved_by uuid, resolved_at timestamptz, resolution text
);

-- ---------- planning
create table public.targets (
  id uuid primary key default gen_random_uuid(),
  discipline public.discipline not null,
  subcontractor_id uuid references public.subcontractors(id),
  block_code text references public.blocks(code),
  period text not null check (period in ('day','week')),
  period_start date not null,
  quantity int not null check (quantity >= 0),     -- tables to complete in the period
  note text,
  set_by uuid default auth.uid(), set_at timestamptz not null default now(),
  unique (discipline, subcontractor_id, block_code, period, period_start)
);

create table public.milestones (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  discipline public.discipline,
  block_code text references public.blocks(code),
  planned_date date,
  forecast_date date,
  actual_date date,
  notes text,
  updated_by uuid default auth.uid(), updated_at timestamptz not null default now()
);

create table public.dependency_rules (
  predecessor public.discipline not null,
  successor public.discipline not null,
  rule text not null,
  enforced boolean not null default true,
  primary key (predecessor, successor)
);

create table public.dependency_exceptions (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.pv_tables(id) on delete cascade,
  successor public.discipline not null,
  reason text not null,
  approved_by uuid, approved_at timestamptz not null default now(),
  source text not null default 'manual',
  revoked_at timestamptz, revoked_by uuid
);

-- ---------- history
create table public.status_events (
  id bigserial primary key,
  table_id uuid not null references public.pv_tables(id) on delete cascade,
  discipline public.discipline not null,
  event text not null,   -- baseline | progress | submitted | verified | rejected | inspection_requested | inspection_scheduled
                         -- | inspected | rectification_raised | rectification_resubmitted | rectification_closed | approved | assigned | exception
  from_work public.work_status, to_work public.work_status,
  from_qa public.qa_status, to_qa public.qa_status,
  installed_modules int, modules_delta int,
  actor uuid, actor_role public.app_role,
  note text, ref_id uuid,
  at timestamptz not null default now()
);
create index status_events_at_idx on public.status_events (at);
create index status_events_table_idx on public.status_events (table_id, discipline, at);

create table public.audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor uuid,
  actor_role public.app_role,
  action text not null,
  table_name text not null,
  record_id text,
  old_data jsonb,
  new_data jsonb,
  changed text[]
);
create index audit_log_at_idx on public.audit_log (at desc);

create table public.drone_evidence (
  table_id uuid not null references public.pv_tables(id) on delete cascade,
  layer_id uuid not null references public.drone_layers(id) on delete cascade,
  module_cover real not null,       -- share of module-coloured pixels inside the table footprint
  primary key (table_id, layer_id)
);

create table public.import_issues (
  id bigserial primary key,
  drawing text,
  severity text not null,
  code text not null,
  message text not null,
  table_id uuid references public.pv_tables(id) on delete set null,
  details jsonb,
  status text not null default 'open' check (status in ('open','resolved','accepted')),
  resolution text,
  resolved_by uuid, resolved_at timestamptz
);

notify pgrst, 'reload schema';
