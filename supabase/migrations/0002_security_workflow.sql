-- =====================================================================================
-- Role-based access, audit trail and workflow procedures
-- Direct writes to workflow tables are not allowed for app users; every status change goes
-- through a procedure below that checks the caller's role and scope, keeps the statuses
-- consistent, and writes the history (status_events) and audit trail (audit_log).
-- =====================================================================================

-- ---------- helpers
create or replace function public.my_role() returns public.app_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create or replace function public.my_subcon() returns uuid
language sql stable security definer set search_path = public as $$
  select subcontractor_id from public.profiles where id = auth.uid() and active and role = 'subcontractor'
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role() is not null
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() <> 'subcontractor', false)
$$;

create or replace function public.has_role(variadic roles public.app_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = any(roles), false)
$$;

create or replace function public.can_see(p_table uuid, p_disc public.discipline default null) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when public.is_staff() then true
    when public.my_role() = 'subcontractor' then exists (
      select 1 from public.assignments a
      where a.table_id = p_table and a.subcontractor_id = public.my_subcon()
        and (p_disc is null or a.discipline = p_disc))
    else false end
$$;

create or replace function public.try_uuid(p text) returns uuid
language plpgsql immutable as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;

create or replace function public._deny(msg text) returns void
language plpgsql as $$
begin
  raise exception '%', msg using errcode = '42501';
end $$;

create or replace function public._label(p_table uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(table_code, sys_key) from public.pv_tables where id = p_table
$$;

-- Site Engineers may be limited to some blocks (profiles.assigned_blocks).
create or replace function public._in_my_blocks(p_table uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case when public.my_role() <> 'site_engineer' then true
    else coalesce((select p.assigned_blocks is null or t.block_code = any(p.assigned_blocks)
                   from public.profiles p, public.pv_tables t where p.id = auth.uid() and t.id = p_table), false) end
$$;

-- ---------- new users get a profile without a role (an administrator assigns it)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ---------- audit trail (10.2): who, what, old -> new, when
create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_old jsonb; v_new jsonb; v_changed text[]; v_rec jsonb; v_id text;
begin
  if coalesce(current_setting('app.bulk_import', true), '') = 'on' then
    return coalesce(new, old);
  end if;
  if tg_op in ('UPDATE','DELETE') then v_old := to_jsonb(old); end if;
  if tg_op in ('INSERT','UPDATE') then v_new := to_jsonb(new); end if;
  if tg_op = 'UPDATE' then
    select array_agg(k order by k) into v_changed from jsonb_object_keys(v_new) as k where (v_new -> k) is distinct from (v_old -> k);
    if v_changed is null then return new; end if;
  end if;
  v_rec := coalesce(v_new, v_old);
  v_id := coalesce(v_rec->>'id', concat_ws(':', v_rec->>'table_id', v_rec->>'discipline'));
  insert into public.audit_log (actor, actor_role, action, table_name, record_id, old_data, new_data, changed)
  values (auth.uid(), public.my_role(), lower(tg_op), tg_table_name, v_id, v_old, v_new, v_changed);
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['project','blocks','subcontractors','drawings','drone_layers','pv_tables','profiles','assignments','progress',
    'accomplishments','inspection_requests','inspections','punch_items','approvals','attachments','site_constraints','targets',
    'milestones','dependency_rules','dependency_exceptions','import_issues'] loop
    execute format('drop trigger if exists audit_%1$s on public.%1$I', t);
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$I for each row execute function public.audit_row()', t);
  end loop;
end $$;

-- ---------- row-level security
do $$
declare t text;
begin
  foreach t in array array['project','blocks','subcontractors','drawings','drone_layers','pv_tables','profiles','assignments','progress',
    'accomplishments','inspection_requests','inspections','punch_items','approvals','attachments','site_constraints','targets',
    'milestones','dependency_rules','dependency_exceptions','status_events','audit_log','drone_evidence','import_issues'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- reference data every member can read
create policy member_read on public.project for select to authenticated using ((select public.is_member()));
create policy member_read on public.blocks for select to authenticated using ((select public.is_member()));
create policy member_read on public.subcontractors for select to authenticated using ((select public.is_member()));
create policy member_read on public.drawings for select to authenticated using ((select public.is_member()));
create policy member_read on public.drone_layers for select to authenticated using ((select public.is_member()));
create policy member_read on public.milestones for select to authenticated using ((select public.is_member()));
create policy member_read on public.dependency_rules for select to authenticated using ((select public.is_member()));
-- table outlines and IDs are visible to every member so the layout stays readable; their records are not
create policy member_read on public.pv_tables for select to authenticated using ((select public.is_member()));

-- administrator-maintained reference data
create policy admin_write on public.subcontractors for all to authenticated using ((select public.has_role('admin'))) with check ((select public.has_role('admin')));
create policy admin_write on public.project for update to authenticated using ((select public.has_role('admin'))) with check ((select public.has_role('admin')));
create policy admin_write on public.blocks for all to authenticated using ((select public.has_role('admin'))) with check ((select public.has_role('admin')));
create policy admin_write on public.drawings for all to authenticated using ((select public.has_role('admin'))) with check ((select public.has_role('admin')));

-- planning data (Project Planner, PM, admin; PIC may set targets)
create policy planner_write on public.milestones for all to authenticated
  using ((select public.has_role('admin','project_planner','project_manager')))
  with check ((select public.has_role('admin','project_planner','project_manager')));
create policy planner_write on public.dependency_rules for all to authenticated
  using ((select public.has_role('admin','project_planner')))
  with check ((select public.has_role('admin','project_planner')));
create policy read_targets on public.targets for select to authenticated
  using ((select public.is_staff()) or subcontractor_id = (select public.my_subcon()) or (subcontractor_id is null and (select public.is_member())));
create policy planner_write on public.targets for all to authenticated
  using ((select public.has_role('admin','project_planner','project_manager','pic_engineer')))
  with check ((select public.has_role('admin','project_planner','project_manager','pic_engineer')));

-- profiles: everyone sees their own; staff see colleagues (names in histories)
create policy read_profiles on public.profiles for select to authenticated using (id = auth.uid() or (select public.is_staff()));

-- assignment / progress / quality records: staff see all, a subcontractor sees only its own tables
create policy read_assignments on public.assignments for select to authenticated
  using ((select public.is_staff()) or subcontractor_id = (select public.my_subcon()));
create policy read_progress on public.progress for select to authenticated
  using ((select public.is_staff()) or exists (select 1 from public.assignments a where a.table_id = progress.table_id
    and a.discipline = progress.discipline and a.subcontractor_id = (select public.my_subcon())));
create policy read_accomplishments on public.accomplishments for select to authenticated
  using ((select public.is_staff()) or subcontractor_id = (select public.my_subcon()));
create policy read_requests on public.inspection_requests for select to authenticated
  using ((select public.is_staff()) or public.can_see(table_id, discipline));
create policy read_inspections on public.inspections for select to authenticated
  using ((select public.is_staff()) or public.can_see(table_id, discipline));
create policy read_punch on public.punch_items for select to authenticated
  using ((select public.is_staff()) or subcontractor_id = (select public.my_subcon()) or public.can_see(table_id, discipline));
create policy read_approvals on public.approvals for select to authenticated
  using ((select public.is_staff()) or public.can_see(table_id, discipline));
create policy read_events on public.status_events for select to authenticated
  using ((select public.is_staff()) or public.can_see(table_id, discipline));
create policy read_exceptions on public.dependency_exceptions for select to authenticated
  using ((select public.is_staff()) or public.can_see(table_id));
create policy read_evidence on public.drone_evidence for select to authenticated
  using ((select public.is_staff()) or public.can_see(table_id));
create policy read_audit on public.audit_log for select to authenticated using ((select public.is_staff()));
create policy read_issues on public.import_issues for select to authenticated using ((select public.is_staff()));
create policy admin_update_issues on public.import_issues for update to authenticated
  using ((select public.has_role('admin'))) with check ((select public.has_role('admin')));

-- attachments: anyone who can see the table may add photos/documents; uploader or admin may delete
create policy read_attachments on public.attachments for select to authenticated
  using ((select public.is_staff()) or uploaded_by = auth.uid() or public.can_see(table_id));
create policy add_attachments on public.attachments for insert to authenticated
  with check ((select public.is_member()) and uploaded_by = auth.uid() and (table_id is null and (select public.is_staff()) or public.can_see(table_id)));
create policy delete_attachments on public.attachments for delete to authenticated
  using (uploaded_by = auth.uid() or (select public.has_role('admin')));

-- site constraints (10.3 record constraints while on site)
create policy read_constraints on public.site_constraints for select to authenticated
  using ((select public.is_staff()) or raised_by = auth.uid() or (table_id is not null and public.can_see(table_id)));
create policy add_constraints on public.site_constraints for insert to authenticated
  with check ((select public.is_member()) and raised_by = auth.uid() and status = 'open'
    and ((select public.is_staff()) or (table_id is not null and public.can_see(table_id))));
create policy resolve_constraints on public.site_constraints for update to authenticated
  using ((select public.has_role('admin','project_manager','construction_manager','pic_engineer','site_engineer','qaqc_engineer')))
  with check ((select public.has_role('admin','project_manager','construction_manager','pic_engineer','site_engineer','qaqc_engineer')));

-- no direct writes on workflow tables (procedures only)
revoke insert, update, delete on public.assignments, public.progress, public.accomplishments, public.inspection_requests,
  public.inspections, public.punch_items, public.approvals, public.status_events, public.audit_log, public.dependency_exceptions,
  public.drone_evidence, public.pv_tables, public.profiles from authenticated;

-- ---------- core progress update (shared by engineers' direct updates and verified submissions)
create or replace function public._apply_progress(
  p_table uuid, p_disc public.discipline, p_work public.work_status, p_pct int, p_mask int,
  p_start date, p_finish date, p_hold text, p_note text, p_event text, p_ref uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  r public.progress%rowtype; t public.pv_tables%rowtype;
  v_work public.work_status; v_qa public.qa_status; v_mask int; v_mods int; v_pct int; v_full int;
begin
  select * into t from public.pv_tables where id = p_table;
  if not found then raise exception 'Unknown table %', p_table using errcode = 'P0002'; end if;
  insert into public.progress (table_id, discipline) values (p_table, p_disc) on conflict do nothing;
  select * into r from public.progress where table_id = p_table and discipline = p_disc for update;

  if r.qa_status = 'approved' and public.my_role() is distinct from 'admin' then
    raise exception '% %: approved work cannot be changed here. QA/QC must reopen it first.', public._label(p_table), p_disc using errcode = 'P0001';
  end if;

  v_work := coalesce(p_work, r.work_status);
  v_full := (1 << t.modules_required) - 1;

  if p_disc = 'PV' then
    v_mask := coalesce(p_mask, r.module_mask);
    if p_work = 'completed' and p_mask is null then v_mask := v_full; end if;
    if p_work = 'not_started' and p_mask is null then v_mask := 0; end if;
    v_mask := v_mask & v_full;
    v_mods := bit_count(v_mask::bit(32))::int;
    if p_work is null or p_work in ('ongoing','completed','not_started') then
      if v_work <> 'on_hold' then
        v_work := case when v_mods = 0 then 'not_started' when v_mods >= t.modules_required then 'completed' else 'ongoing' end;
      end if;
    end if;
    v_pct := round(100.0 * v_mods / t.modules_required);
  else
    v_mask := 0; v_mods := 0;
    v_pct := case v_work when 'completed' then 100 when 'not_started' then 0 else coalesce(p_pct, r.progress_pct) end;
    if v_work = 'ongoing' and v_pct >= 100 then v_pct := 95; end if;
  end if;

  -- 10.1 dependency: PV work needs a completed mounting structure unless an approved exception exists
  if p_disc = 'PV' and v_work <> 'not_started'
     and exists (select 1 from public.dependency_rules where predecessor = 'MMS' and successor = 'PV' and enforced)
     and not exists (select 1 from public.progress where table_id = p_table and discipline = 'MMS' and work_status = 'completed')
     and not exists (select 1 from public.dependency_exceptions where table_id = p_table and successor = 'PV' and revoked_at is null) then
    raise exception '%: the mounting structure is not complete, so PV progress cannot be recorded. Ask the Construction Manager to record a dependency exception.', public._label(p_table) using errcode = 'P0001';
  end if;

  if v_work = 'on_hold' and coalesce(nullif(trim(p_hold), ''), r.on_hold_reason) is null then
    raise exception 'Give the reason the work is on hold.' using errcode = '22023';
  end if;

  v_qa := r.qa_status;
  if v_work <> 'completed' and v_qa in ('ready_for_inspection','for_inspection','for_approval','approved') then
    v_qa := 'none';
    update public.inspection_requests set status = 'cancelled', closed_at = now()
     where table_id = p_table and discipline = p_disc and status in ('open','scheduled');
  end if;

  update public.progress set
    work_status = v_work, qa_status = v_qa, progress_pct = v_pct, installed_modules = v_mods, module_mask = v_mask,
    on_hold_reason = case when v_work = 'on_hold' then coalesce(nullif(trim(p_hold), ''), r.on_hold_reason) else null end,
    actual_start = coalesce(p_start, r.actual_start, case when v_work <> 'not_started' then current_date end),
    actual_finish = case when v_work = 'completed' then coalesce(p_finish, r.actual_finish, current_date) else p_finish end,
    verified_at = now(), verified_by = auth.uid(), updated_at = now(), updated_by = auth.uid(), source = 'app'
  where table_id = p_table and discipline = p_disc;

  insert into public.status_events (table_id, discipline, event, from_work, to_work, from_qa, to_qa, installed_modules, modules_delta, actor, actor_role, note, ref_id)
  values (p_table, p_disc, p_event, r.work_status, v_work, r.qa_status, v_qa, v_mods, v_mods - r.installed_modules, auth.uid(), public.my_role(), p_note, p_ref);
end $$;

-- ---------- engineers record verified progress directly (Site Engineer, PIC, Construction Manager, admin)
create or replace function public.update_progress(
  p_tables uuid[], p_discipline public.discipline, p_work public.work_status default null, p_pct int default null,
  p_mask int default null, p_actual_start date default null, p_actual_finish date default null,
  p_hold_reason text default null, p_note text default null)
returns int language plpgsql security definer set search_path = public as $$
declare t uuid; n int := 0;
begin
  if not public.has_role('admin','construction_manager','pic_engineer','site_engineer') then
    perform public._deny('Only Site Engineers, Project-in-Charge Engineers, the Construction Manager or an administrator can record verified progress. Subcontractors submit accomplishments for verification.');
  end if;
  foreach t in array p_tables loop
    if not public._in_my_blocks(t) then
      perform public._deny(format('%s is outside the blocks assigned to you.', public._label(t)));
    end if;
    perform public._apply_progress(t, p_discipline, p_work, p_pct, p_mask, p_actual_start, p_actual_finish, p_hold_reason, p_note, 'progress', null);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- subcontractors submit accomplishments (not official until verified)
create or replace function public.submit_accomplishment(
  p_table uuid, p_discipline public.discipline, p_work public.work_status, p_pct int default null, p_mask int default null,
  p_actual_start date default null, p_actual_finish date default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_sub uuid;
begin
  if public.my_role() is null then perform public._deny('Your account has no role yet.'); end if;
  if public.my_role() = 'subcontractor' then
    if not public.can_see(p_table, p_discipline) then
      perform public._deny(format('%s %s is not assigned to your company.', public._label(p_table), p_discipline));
    end if;
    v_sub := public.my_subcon();
  else
    select subcontractor_id into v_sub from public.assignments where table_id = p_table and discipline = p_discipline;
  end if;
  update public.accomplishments set status = 'rejected', review_note = 'Superseded by a newer submission', reviewed_at = now()
   where table_id = p_table and discipline = p_discipline and status = 'submitted';
  insert into public.accomplishments (table_id, discipline, subcontractor_id, work_status, progress_pct, installed_modules, module_mask,
    actual_start, actual_finish, note, submitted_by)
  values (p_table, p_discipline, v_sub, p_work, p_pct,
    case when p_mask is not null then bit_count(p_mask::bit(32))::int end, p_mask, p_actual_start, p_actual_finish, p_note, auth.uid())
  returning id into v_id;
  insert into public.status_events (table_id, discipline, event, to_work, actor, actor_role, note, ref_id, installed_modules)
  values (p_table, p_discipline, 'submitted', p_work, auth.uid(), public.my_role(), p_note, v_id,
    case when p_mask is not null then bit_count(p_mask::bit(32))::int end);
  return v_id;
end $$;

create or replace function public.review_accomplishment(p_id uuid, p_verify boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare a public.accomplishments%rowtype;
begin
  if not public.has_role('admin','construction_manager','pic_engineer','site_engineer') then
    perform public._deny('Only engineers or the Construction Manager can verify accomplishments.');
  end if;
  select * into a from public.accomplishments where id = p_id for update;
  if not found or a.status <> 'submitted' then raise exception 'This submission is no longer waiting for review.' using errcode = 'P0001'; end if;
  if not public._in_my_blocks(a.table_id) then perform public._deny('This table is outside the blocks assigned to you.'); end if;
  if p_verify then
    perform public._apply_progress(a.table_id, a.discipline, a.work_status, a.progress_pct, a.module_mask, a.actual_start, a.actual_finish,
      null, coalesce(p_note, a.note), 'verified', a.id);
    update public.accomplishments set status = 'verified', reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note where id = p_id;
  else
    update public.accomplishments set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note where id = p_id;
    insert into public.status_events (table_id, discipline, event, actor, actor_role, note, ref_id)
    values (a.table_id, a.discipline, 'rejected', auth.uid(), public.my_role(), p_note, a.id);
  end if;
end $$;

-- ---------- inspection requests
create or replace function public.request_inspection(p_tables uuid[], p_discipline public.discipline, p_note text default null, p_scheduled date default null)
returns int language plpgsql security definer set search_path = public as $$
declare t uuid; r public.progress%rowtype; v_qa public.qa_status; v_re boolean; n int := 0; v_role public.app_role := public.my_role();
begin
  if not public.has_role('admin','construction_manager','pic_engineer','site_engineer','qaqc_engineer','subcontractor') then
    perform public._deny('Your role cannot request inspections.');
  end if;
  foreach t in array p_tables loop
    if v_role = 'subcontractor' and not public.can_see(t, p_discipline) then
      perform public._deny(format('%s %s is not assigned to your company.', public._label(t), p_discipline));
    end if;
    select * into r from public.progress where table_id = t and discipline = p_discipline for update;
    if not found or r.work_status <> 'completed' then
      raise exception '% %: work must be complete before inspection.', public._label(t), p_discipline using errcode = 'P0001';
    end if;
    if r.qa_status in ('ready_for_inspection','for_inspection','for_approval','approved') then
      raise exception '% %: already %.', public._label(t), p_discipline, replace(r.qa_status::text, '_', ' ') using errcode = 'P0001';
    end if;
    v_re := r.qa_status = 'for_rectification';
    if v_re and exists (select 1 from public.punch_items where table_id = t and discipline = p_discipline and status = 'open') then
      raise exception '% %: resubmit every open rectification item before asking for reinspection.', public._label(t), p_discipline using errcode = 'P0001';
    end if;
    v_qa := case when v_role = 'subcontractor' and p_scheduled is null then 'ready_for_inspection' else 'for_inspection' end;
    insert into public.inspection_requests (table_id, discipline, stage, status, is_reinspection, note, scheduled_for, requested_by)
    values (t, p_discipline, 'qaqc', (case when v_qa = 'for_inspection' then 'scheduled' else 'open' end)::public.request_status, v_re, p_note, p_scheduled, auth.uid());
    update public.progress set qa_status = v_qa, updated_at = now(), updated_by = auth.uid() where table_id = t and discipline = p_discipline;
    insert into public.status_events (table_id, discipline, event, from_qa, to_qa, actor, actor_role, note)
    values (t, p_discipline, 'inspection_requested', r.qa_status, v_qa, auth.uid(), v_role, p_note);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.schedule_inspection(p_request_ids uuid[], p_date date)
returns int language plpgsql security definer set search_path = public as $$
declare q public.inspection_requests%rowtype; n int := 0;
begin
  if not public.has_role('admin','qaqc_engineer','site_engineer','pic_engineer') then
    perform public._deny('Only QA/QC or engineers can schedule inspections.');
  end if;
  for q in select * from public.inspection_requests where id = any(p_request_ids) and status in ('open','scheduled') for update loop
    update public.inspection_requests set status = 'scheduled', scheduled_for = p_date, scheduled_by = auth.uid() where id = q.id;
    update public.progress set qa_status = 'for_inspection', updated_at = now(), updated_by = auth.uid()
     where table_id = q.table_id and discipline = q.discipline and qa_status = 'ready_for_inspection';
    insert into public.status_events (table_id, discipline, event, from_qa, to_qa, actor, actor_role, note, ref_id)
    values (q.table_id, q.discipline, 'inspection_scheduled', 'ready_for_inspection', 'for_inspection', auth.uid(), public.my_role(), 'Scheduled ' || p_date, q.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- inspections (QA/QC records internal and client results; subcontractor may log its own contractor inspection)
create or replace function public.record_inspection(
  p_table uuid, p_discipline public.discipline, p_stage public.inspection_stage, p_result public.inspection_result,
  p_comments text default null, p_nonconformities text default null, p_punch text[] default null, p_inspector_name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare r public.progress%rowtype; v_id uuid; v_qa public.qa_status; v_role public.app_role := public.my_role(); v_sub uuid; d text; v_items text[];
        v_client boolean;
begin
  if p_stage = 'contractor' then
    if not (public.has_role('admin','qaqc_engineer','site_engineer','pic_engineer') or (v_role = 'subcontractor' and public.can_see(p_table, p_discipline))) then
      perform public._deny('You cannot record a contractor inspection for this table.');
    end if;
  elsif not public.has_role('admin','qaqc_engineer') then
    perform public._deny('Only QA/QC can record QA/QC, client or final inspection results.');
  end if;
  select * into r from public.progress where table_id = p_table and discipline = p_discipline for update;
  if not found or r.work_status <> 'completed' then
    raise exception '% %: work is not complete, so it cannot be inspected.', public._label(p_table), p_discipline using errcode = 'P0001';
  end if;
  if r.qa_status = 'approved' and p_stage <> 'contractor' then
    raise exception '% %: already approved.', public._label(p_table), p_discipline using errcode = 'P0001';
  end if;
  insert into public.inspections (table_id, discipline, stage, request_id, result, comments, nonconformities, inspector_id, inspector_name)
  values (p_table, p_discipline, p_stage,
    (select id from public.inspection_requests where table_id = p_table and discipline = p_discipline and status in ('open','scheduled') order by requested_at desc limit 1),
    p_result, p_comments, p_nonconformities, auth.uid(), p_inspector_name)
  returning id into v_id;
  if p_stage = 'contractor' then
    insert into public.status_events (table_id, discipline, event, actor, actor_role, note, ref_id)
    values (p_table, p_discipline, 'inspected', auth.uid(), v_role, 'Contractor inspection: ' || p_result || coalesce(' — ' || p_comments, ''), v_id);
    return v_id;
  end if;
  update public.inspection_requests set status = 'completed', closed_at = now()
   where table_id = p_table and discipline = p_discipline and status in ('open','scheduled');
  select coalesce((settings->>'requires_client_approval')::boolean, true) into v_client from public.project where id = 1;
  if p_result = 'failed' then
    v_qa := 'for_rectification';
    select subcontractor_id into v_sub from public.assignments where table_id = p_table and discipline = p_discipline;
    v_items := coalesce(nullif(array_remove(p_punch, ''), '{}'), array[coalesce(nullif(p_nonconformities, ''), nullif(p_comments, ''), 'Rectify the defects recorded at inspection')]);
    foreach d in array v_items loop
      insert into public.punch_items (table_id, discipline, inspection_id, subcontractor_id, description, raised_by)
      values (p_table, p_discipline, v_id, v_sub, d, auth.uid());
    end loop;
  else
    update public.punch_items set status = 'closed', closed_by = auth.uid(), closed_at = now(), close_note = 'Closed at reinspection'
     where table_id = p_table and discipline = p_discipline and status in ('open','resubmitted');
    if p_stage = 'qaqc' and v_client then
      v_qa := 'for_approval';
    else
      v_qa := 'approved';
      insert into public.approvals (table_id, discipline, stage, approved_by, approver_name, note, source)
      values (p_table, p_discipline, p_stage, auth.uid(), p_inspector_name, p_comments, 'inspection');
    end if;
  end if;
  update public.progress set qa_status = v_qa, updated_at = now(), updated_by = auth.uid(),
    approved_at = case when v_qa = 'approved' then now() else approved_at end,
    approved_by = case when v_qa = 'approved' then auth.uid() else approved_by end
  where table_id = p_table and discipline = p_discipline;
  insert into public.status_events (table_id, discipline, event, from_qa, to_qa, actor, actor_role, note, ref_id)
  values (p_table, p_discipline, 'inspected', r.qa_status, v_qa, auth.uid(), v_role,
    initcap(p_stage::text) || ' inspection ' || p_result || coalesce(' — ' || p_comments, ''), v_id);
  if v_qa = 'approved' then
    insert into public.status_events (table_id, discipline, event, from_qa, to_qa, actor, actor_role, note, ref_id)
    values (p_table, p_discipline, 'approved', v_qa, v_qa, auth.uid(), v_role, initcap(p_stage::text) || ' approval', v_id);
  end if;
  return v_id;
end $$;

create or replace function public.record_approval(
  p_tables uuid[], p_discipline public.discipline, p_stage public.inspection_stage default 'client',
  p_approver_name text default null, p_reference text default null, p_note text default null)
returns int language plpgsql security definer set search_path = public as $$
declare t uuid; r public.progress%rowtype; n int := 0;
begin
  if not public.has_role('admin','qaqc_engineer','project_manager') then
    perform public._deny('Only QA/QC, the Project Manager or an administrator can record approvals.');
  end if;
  foreach t in array p_tables loop
    select * into r from public.progress where table_id = t and discipline = p_discipline for update;
    if not found or r.qa_status <> 'for_approval' then
      raise exception '% %: only work that passed inspection (For Approval) can be approved.', public._label(t), p_discipline using errcode = 'P0001';
    end if;
    insert into public.approvals (table_id, discipline, stage, approved_by, approver_name, reference, note)
    values (t, p_discipline, p_stage, auth.uid(), p_approver_name, p_reference, p_note);
    update public.progress set qa_status = 'approved', approved_at = now(), approved_by = auth.uid(), updated_at = now(), updated_by = auth.uid()
     where table_id = t and discipline = p_discipline;
    insert into public.status_events (table_id, discipline, event, from_qa, to_qa, actor, actor_role, note)
    values (t, p_discipline, 'approved', r.qa_status, 'approved', auth.uid(), public.my_role(),
      initcap(p_stage::text) || ' approval' || coalesce(' — ' || p_approver_name, '') || coalesce(' (' || p_reference || ')', ''));
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.reopen_approval(p_table uuid, p_discipline public.discipline, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.progress%rowtype;
begin
  if not public.has_role('admin','qaqc_engineer') then perform public._deny('Only QA/QC or an administrator can reopen approved work.'); end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give the reason for reopening.' using errcode = '22023'; end if;
  select * into r from public.progress where table_id = p_table and discipline = p_discipline for update;
  if r.qa_status <> 'approved' then raise exception 'Only approved work can be reopened.' using errcode = 'P0001'; end if;
  update public.progress set qa_status = 'for_rectification', updated_at = now(), updated_by = auth.uid() where table_id = p_table and discipline = p_discipline;
  insert into public.punch_items (table_id, discipline, subcontractor_id, description, raised_by)
  values (p_table, p_discipline, (select subcontractor_id from public.assignments where table_id = p_table and discipline = p_discipline), p_reason, auth.uid());
  insert into public.status_events (table_id, discipline, event, from_qa, to_qa, actor, actor_role, note)
  values (p_table, p_discipline, 'rectification_raised', 'approved', 'for_rectification', auth.uid(), public.my_role(), 'Approval reopened: ' || p_reason);
end $$;

-- ---------- punch list / rectification
create or replace function public.raise_punch_item(p_table uuid, p_discipline public.discipline, p_description text, p_due date default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; r public.progress%rowtype;
begin
  if not public.has_role('admin','qaqc_engineer') then perform public._deny('Only QA/QC can raise punch-list items.'); end if;
  select * into r from public.progress where table_id = p_table and discipline = p_discipline for update;
  if r.qa_status = 'approved' then raise exception 'Reopen the approval first.' using errcode = 'P0001'; end if;
  insert into public.punch_items (table_id, discipline, subcontractor_id, description, due_date, raised_by)
  values (p_table, p_discipline, (select subcontractor_id from public.assignments where table_id = p_table and discipline = p_discipline), p_description, p_due, auth.uid())
  returning id into v_id;
  if r.work_status = 'completed' and r.qa_status <> 'for_rectification' then
    update public.progress set qa_status = 'for_rectification', updated_at = now(), updated_by = auth.uid() where table_id = p_table and discipline = p_discipline;
    update public.inspection_requests set status = 'cancelled', closed_at = now() where table_id = p_table and discipline = p_discipline and status in ('open','scheduled');
  end if;
  insert into public.status_events (table_id, discipline, event, from_qa, to_qa, actor, actor_role, note, ref_id)
  values (p_table, p_discipline, 'rectification_raised', r.qa_status, case when r.work_status = 'completed' then 'for_rectification' else r.qa_status end,
    auth.uid(), public.my_role(), p_description, v_id);
  return v_id;
end $$;

create or replace function public.resubmit_rectification(p_ids uuid[], p_note text default null)
returns int language plpgsql security definer set search_path = public as $$
declare p public.punch_items%rowtype; n int := 0; v_role public.app_role := public.my_role();
begin
  if not public.has_role('admin','construction_manager','pic_engineer','site_engineer','subcontractor') then
    perform public._deny('Your role cannot resubmit rectification work.');
  end if;
  for p in select * from public.punch_items where id = any(p_ids) and status = 'open' for update loop
    if v_role = 'subcontractor' and p.subcontractor_id is distinct from public.my_subcon() then
      perform public._deny('This rectification item belongs to another subcontractor.');
    end if;
    update public.punch_items set status = 'resubmitted', resubmitted_by = auth.uid(), resubmitted_at = now(), resubmit_note = p_note where id = p.id;
    insert into public.status_events (table_id, discipline, event, actor, actor_role, note, ref_id)
    values (p.table_id, p.discipline, 'rectification_resubmitted', auth.uid(), v_role, coalesce(p_note, p.description), p.id);
    -- last open item resubmitted -> back to Ready for Inspection with a reinspection request
    if not exists (select 1 from public.punch_items where table_id = p.table_id and discipline = p.discipline and status = 'open') then
      update public.progress set qa_status = 'ready_for_inspection', updated_at = now(), updated_by = auth.uid()
       where table_id = p.table_id and discipline = p.discipline and qa_status = 'for_rectification';
      if found then
        insert into public.inspection_requests (table_id, discipline, stage, status, is_reinspection, note, requested_by)
        values (p.table_id, p.discipline, 'qaqc', 'open', true, 'Reinspection after rectification', auth.uid());
        insert into public.status_events (table_id, discipline, event, from_qa, to_qa, actor, actor_role, note)
        values (p.table_id, p.discipline, 'inspection_requested', 'for_rectification', 'ready_for_inspection', auth.uid(), v_role, 'Reinspection requested');
      end if;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.close_punch_items(p_ids uuid[], p_note text default null)
returns int language plpgsql security definer set search_path = public as $$
declare p public.punch_items%rowtype; n int := 0;
begin
  if not public.has_role('admin','qaqc_engineer') then perform public._deny('Only QA/QC can close punch-list items.'); end if;
  for p in select * from public.punch_items where id = any(p_ids) and status <> 'closed' for update loop
    update public.punch_items set status = 'closed', closed_by = auth.uid(), closed_at = now(), close_note = p_note where id = p.id;
    insert into public.status_events (table_id, discipline, event, actor, actor_role, note, ref_id)
    values (p.table_id, p.discipline, 'rectification_closed', auth.uid(), public.my_role(), coalesce(p_note, p.description), p.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- assignment, planning, exceptions
create or replace function public.set_assignment(p_tables uuid[], p_discipline public.discipline, p_subcon uuid)
returns int language plpgsql security definer set search_path = public as $$
declare t uuid; n int := 0; v_old uuid;
begin
  if not public.has_role('admin','pic_engineer','construction_manager') then
    perform public._deny('Only the Project-in-Charge Engineer, the Construction Manager or an administrator can assign tables.');
  end if;
  foreach t in array p_tables loop
    select subcontractor_id into v_old from public.assignments where table_id = t and discipline = p_discipline;
    if p_subcon is null then
      delete from public.assignments where table_id = t and discipline = p_discipline;
    else
      insert into public.assignments (table_id, discipline, subcontractor_id, source, assigned_by, assigned_at)
      values (t, p_discipline, p_subcon, 'app', auth.uid(), now())
      on conflict (table_id, discipline) do update set subcontractor_id = excluded.subcontractor_id, source = 'app', assigned_by = auth.uid(), assigned_at = now();
    end if;
    insert into public.status_events (table_id, discipline, event, actor, actor_role, note)
    values (t, p_discipline, 'assigned', auth.uid(), public.my_role(),
      coalesce((select code from public.subcontractors where id = v_old), 'unassigned') || ' → ' || coalesce((select code from public.subcontractors where id = p_subcon), 'unassigned'));
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.set_target_dates(p_tables uuid[], p_discipline public.discipline, p_start date, p_finish date)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.has_role('admin','project_planner','project_manager','construction_manager','pic_engineer') then
    perform public._deny('Only planning and management roles can set target dates.');
  end if;
  if p_start is not null and p_finish is not null and p_finish < p_start then
    raise exception 'The target finish is before the target start.' using errcode = '22023';
  end if;
  insert into public.progress (table_id, discipline) select unnest(p_tables), p_discipline on conflict do nothing;
  update public.progress set target_start = p_start, target_finish = p_finish, updated_at = now(), updated_by = auth.uid()
   where table_id = any(p_tables) and discipline = p_discipline;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.record_dependency_exception(p_tables uuid[], p_reason text)
returns int language plpgsql security definer set search_path = public as $$
declare t uuid; n int := 0;
begin
  if not public.has_role('admin','project_manager','construction_manager') then
    perform public._deny('Only the Project Manager, the Construction Manager or an administrator can approve a dependency exception.');
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give the reason for the exception.' using errcode = '22023'; end if;
  foreach t in array p_tables loop
    insert into public.dependency_exceptions (table_id, successor, reason, approved_by) values (t, 'PV', p_reason, auth.uid());
    insert into public.status_events (table_id, discipline, event, actor, actor_role, note)
    values (t, 'PV', 'exception', auth.uid(), public.my_role(), 'Dependency exception: ' || p_reason);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- administration
create or replace function public.admin_update_profile(p_user uuid, p_role public.app_role, p_subcon uuid default null,
  p_blocks text[] default null, p_active boolean default true, p_full_name text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin') then perform public._deny('Only an administrator can change user roles.'); end if;
  if p_user = auth.uid() and p_role is distinct from 'admin' then raise exception 'You cannot remove your own administrator role.' using errcode = 'P0001'; end if;
  if p_role = 'subcontractor' and p_subcon is null then raise exception 'Choose the subcontractor company for this user.' using errcode = '22023'; end if;
  update public.profiles set role = p_role, subcontractor_id = case when p_role = 'subcontractor' then p_subcon end,
    assigned_blocks = case when p_role = 'site_engineer' then p_blocks end, active = p_active,
    full_name = coalesce(nullif(trim(p_full_name), ''), full_name)
  where id = p_user;
  if not found then raise exception 'User not found.' using errcode = 'P0002'; end if;
end $$;

create or replace function public.update_my_name(p_full_name text)
returns void language sql security definer set search_path = public as $$
  update public.profiles set full_name = nullif(trim(p_full_name), '') where id = auth.uid();
$$;

create or replace function public.update_table_config(p_tables uuid[], p_modules int, p_remarks text default null)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.has_role('admin') then perform public._deny('Only an administrator can change the approved design quantity.'); end if;
  if p_modules < 1 or p_modules > 31 then raise exception 'Modules per table must be between 1 and 31.' using errcode = '22023'; end if;
  update public.pv_tables set modules_required = p_modules, remarks = coalesce(p_remarks, remarks) where id = any(p_tables);
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- read model for the keyplan and dashboards (RLS applies through security_invoker)
create or replace view public.v_table_state with (security_invoker = true) as
with pu as (select table_id, discipline, count(*)::int n from public.punch_items where status <> 'closed' group by 1, 2),
     ins as (select table_id, discipline, count(*)::int n from public.inspections where stage <> 'contractor' group by 1, 2),
     exc as (select distinct table_id from public.dependency_exceptions where revoked_at is null),
     acc as (select table_id, count(*)::int n from public.accomplishments where status = 'submitted' group by 1),
     dr as (select distinct on (de.table_id) de.table_id, de.module_cover from public.drone_evidence de
            join public.drone_layers dl on dl.id = de.layer_id and dl.is_active order by de.table_id, dl.capture_date desc)
select t.id, t.sys_key, t.table_code, t.block_code, t.id_col, t.id_row, t.x0, t.y0, t.x1, t.y1, t.modules_required,
       t.module_rows, t.module_cols, t.id_flags, t.cad_outlines,
       am.subcontractor_id as mms_subcon, ap.subcontractor_id as pv_subcon,
       pm.work_status as mms_work, pm.qa_status as mms_qa, pm.progress_pct as mms_pct, pm.actual_start as mms_actual_start,
       pm.actual_finish as mms_actual_finish, pm.target_start as mms_target_start, pm.target_finish as mms_target_finish,
       pm.approved_at as mms_approved_at, pm.updated_at as mms_updated_at, pm.on_hold_reason as mms_hold_reason,
       pp.work_status as pv_work, pp.qa_status as pv_qa, pp.installed_modules as pv_modules, pp.module_mask as pv_mask,
       pp.actual_start as pv_actual_start, pp.actual_finish as pv_actual_finish, pp.target_start as pv_target_start,
       pp.target_finish as pv_target_finish, pp.approved_at as pv_approved_at, pp.updated_at as pv_updated_at, pp.on_hold_reason as pv_hold_reason,
       coalesce(pum.n, 0) as mms_open_punch, coalesce(pup.n, 0) as pv_open_punch,
       coalesce(insm.n, 0) as mms_inspections, coalesce(insp.n, 0) as pv_inspections,
       (exc.table_id is not null) as has_exception, coalesce(acc.n, 0) as pending_reports, dr.module_cover as drone_cover
from public.pv_tables t
left join public.assignments am on am.table_id = t.id and am.discipline = 'MMS'
left join public.assignments ap on ap.table_id = t.id and ap.discipline = 'PV'
left join public.progress pm on pm.table_id = t.id and pm.discipline = 'MMS'
left join public.progress pp on pp.table_id = t.id and pp.discipline = 'PV'
left join pu pum on pum.table_id = t.id and pum.discipline = 'MMS'
left join pu pup on pup.table_id = t.id and pup.discipline = 'PV'
left join ins insm on insm.table_id = t.id and insm.discipline = 'MMS'
left join ins insp on insp.table_id = t.id and insp.discipline = 'PV'
left join exc on exc.table_id = t.id
left join acc on acc.table_id = t.id
left join dr on dr.table_id = t.id;

grant select on public.v_table_state to authenticated;
revoke all on public.v_table_state from anon;

-- function execution: authenticated only
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f' loop
    execute format('revoke execute on function %s from anon, public', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;
-- internal helpers are not callable from the API
revoke execute on function public._apply_progress(uuid, public.discipline, public.work_status, int, int, date, date, text, text, text, uuid) from authenticated;
revoke execute on function public.audit_row() from authenticated;
revoke execute on function public.handle_new_user() from authenticated;

notify pgrst, 'reload schema';
