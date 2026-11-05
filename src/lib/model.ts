// Domain model: statuses, roles, permissions and the counting rules from the brief.
export type Discipline = 'MMS' | 'PV';
export type WorkStatus = 'not_started' | 'ongoing' | 'on_hold' | 'completed';
export type QaStatus = 'none' | 'ready_for_inspection' | 'for_inspection' | 'for_rectification' | 'for_approval' | 'approved';
export type Role = 'admin' | 'ceo' | 'project_manager' | 'construction_manager' | 'pic_engineer' | 'qaqc_engineer' | 'site_engineer' | 'project_planner' | 'subcontractor';
export type StatusKey = 'not_started' | 'ongoing' | 'on_hold' | 'ready_for_inspection' | 'for_inspection' | 'for_rectification' | 'for_approval' | 'approved' | 'completed';

export interface TableState {
  id: string; sys_key: string; table_code: string | null; block_code: string | null; id_col: string | null; id_row: string | null;
  x0: number; y0: number; x1: number; y1: number; modules_required: number; module_rows: number; module_cols: number;
  id_flags: string[]; cad_outlines: number;
  mms_subcon: string | null; pv_subcon: string | null;
  mms_work: WorkStatus | null; mms_qa: QaStatus | null; mms_pct: number | null; mms_actual_start: string | null; mms_actual_finish: string | null;
  mms_target_start: string | null; mms_target_finish: string | null; mms_approved_at: string | null; mms_updated_at: string | null; mms_hold_reason: string | null;
  pv_work: WorkStatus | null; pv_qa: QaStatus | null; pv_modules: number | null; pv_mask: number | null; pv_actual_start: string | null; pv_actual_finish: string | null;
  pv_target_start: string | null; pv_target_finish: string | null; pv_approved_at: string | null; pv_updated_at: string | null; pv_hold_reason: string | null;
  mms_open_punch: number; pv_open_punch: number; mms_inspections: number; pv_inspections: number;
  has_exception: boolean; pending_reports: number; drone_cover: number | null;
}
export interface Subcon { id: string; code: string; name: string; aliases: string[]; color: string; active: boolean }
export interface Profile { id: string; email: string | null; full_name: string | null; role: Role | null; subcontractor_id: string | null; assigned_blocks: string[] | null; active: boolean; created_at?: string }
export interface Block { code: string; name: string; cad_layer: string | null; sort: number }
export interface DroneLayer { id: string; capture_date: string; source_file: string; bucket: string; prefix: string; meta: DroneMeta; is_active: boolean }
export interface DroneMeta {
  capture_date: string; source: string; extent: [number, number, number, number]; origin: [number, number]; tile_size: number; resolutions: number[];
  format: string; fit: { gsd_m: number; rotation_deg: number; shear: number; ecc: number[]; evidence?: Record<string, number> };
}
export interface ProjectSettings {
  modules_per_table: number; module_rows: number; module_cols: number; module_numbering: string; requires_client_approval: boolean;
  status_opacity: number; table_size_m: [number, number]; module_size_m: [number, number]; baseline_rules?: Record<string, string>;
}

// Section 4 status categories, suggested colours and meanings (colours are configurable tokens in CSS too)
export const STATUSES: { key: StatusKey; label: string; color: string; meaning: string }[] = [
  { key: 'not_started', label: 'Not Started', color: '#A3ACB3', meaning: 'Work has not started' },
  { key: 'ongoing', label: 'Ongoing', color: '#2F6FDB', meaning: 'Work is in progress' },
  { key: 'on_hold', label: 'On Hold', color: '#F08A24', meaning: 'Work is suspended due to a constraint' },
  { key: 'ready_for_inspection', label: 'Ready for Inspection', color: '#8B5CF6', meaning: 'Contractor reports the work ready for inspection' },
  { key: 'for_inspection', label: 'For Inspection', color: '#E0AE00', meaning: 'Inspection is requested or scheduled' },
  { key: 'for_rectification', label: 'For Rectification', color: '#E23C3C', meaning: 'Defects or nonconformities require correction' },
  { key: 'for_approval', label: 'For Approval', color: '#4AB0E6', meaning: 'Awaiting the required approval' },
  { key: 'approved', label: 'Approved', color: '#34C25A', meaning: 'Required approval has been recorded' },
  { key: 'completed', label: 'Completed', color: '#157A3A', meaning: 'Physical work is complete according to the defined completion criteria' },
];
export const STATUS = Object.fromEntries(STATUSES.map((s) => [s.key, s])) as Record<StatusKey, (typeof STATUSES)[number]>;
export const WORK_LABEL: Record<WorkStatus, string> = { not_started: 'Not Started', ongoing: 'Ongoing', on_hold: 'On Hold', completed: 'Completed' };
export const QA_LABEL: Record<QaStatus, string> = {
  none: 'Not requested', ready_for_inspection: 'Ready for Inspection', for_inspection: 'For Inspection',
  for_rectification: 'For Rectification', for_approval: 'For Approval', approved: 'Approved',
};

/** Current status shown on the keyplan: QA/QC state wins once work is complete; physical state otherwise. */
export function currentStatus(work: WorkStatus | null, qa: QaStatus | null): StatusKey | null {
  if (!work) return null;
  if (work === 'on_hold') return 'on_hold';
  if (work === 'not_started') return 'not_started';
  if (work === 'ongoing') return qa === 'for_rectification' ? 'for_rectification' : 'ongoing';
  // completed
  if (!qa || qa === 'none') return 'completed';
  return qa as StatusKey;
}
export const statusOf = (t: TableState, d: Discipline) => currentStatus(d === 'MMS' ? t.mms_work : t.pv_work, d === 'MMS' ? t.mms_qa : t.pv_qa);

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Administrator', ceo: 'CEO', project_manager: 'Project Manager', construction_manager: 'Construction Manager',
  pic_engineer: 'Project-in-Charge Engineer', qaqc_engineer: 'QA/QC Engineer', site_engineer: 'Site Engineer',
  project_planner: 'Project Planner', subcontractor: 'Subcontractor',
};

export type Action =
  | 'progress.update' | 'progress.submit' | 'report.verify' | 'inspection.request' | 'inspection.schedule' | 'inspection.record'
  | 'inspection.contractor' | 'approval.record' | 'approval.reopen' | 'punch.raise' | 'punch.resubmit' | 'punch.close' | 'assign'
  | 'plan.dates' | 'plan.targets' | 'plan.milestones' | 'plan.dependencies' | 'exception.record' | 'constraint.raise' | 'constraint.resolve'
  | 'attach' | 'admin' | 'view.audit' | 'view.comparison' | 'view.all';

const PERMS: Record<Action, Role[]> = {
  'progress.update': ['admin', 'construction_manager', 'pic_engineer', 'site_engineer'],
  'progress.submit': ['subcontractor'],
  'report.verify': ['admin', 'construction_manager', 'pic_engineer', 'site_engineer'],
  'inspection.request': ['admin', 'construction_manager', 'pic_engineer', 'site_engineer', 'qaqc_engineer', 'subcontractor'],
  'inspection.schedule': ['admin', 'qaqc_engineer', 'site_engineer', 'pic_engineer'],
  'inspection.record': ['admin', 'qaqc_engineer'],
  'inspection.contractor': ['admin', 'qaqc_engineer', 'site_engineer', 'pic_engineer', 'subcontractor'],
  'approval.record': ['admin', 'qaqc_engineer', 'project_manager'],
  'approval.reopen': ['admin', 'qaqc_engineer'],
  'punch.raise': ['admin', 'qaqc_engineer'],
  'punch.resubmit': ['admin', 'construction_manager', 'pic_engineer', 'site_engineer', 'subcontractor'],
  'punch.close': ['admin', 'qaqc_engineer'],
  assign: ['admin', 'pic_engineer', 'construction_manager'],
  'plan.dates': ['admin', 'project_planner', 'project_manager', 'construction_manager', 'pic_engineer'],
  'plan.targets': ['admin', 'project_planner', 'project_manager', 'pic_engineer'],
  'plan.milestones': ['admin', 'project_planner', 'project_manager'],
  'plan.dependencies': ['admin', 'project_planner'],
  'exception.record': ['admin', 'project_manager', 'construction_manager'],
  'constraint.raise': ['admin', 'ceo', 'project_manager', 'construction_manager', 'pic_engineer', 'qaqc_engineer', 'site_engineer', 'project_planner', 'subcontractor'],
  'constraint.resolve': ['admin', 'project_manager', 'construction_manager', 'pic_engineer', 'site_engineer', 'qaqc_engineer'],
  attach: ['admin', 'project_manager', 'construction_manager', 'pic_engineer', 'qaqc_engineer', 'site_engineer', 'subcontractor'],
  admin: ['admin'],
  'view.audit': ['admin', 'ceo', 'project_manager', 'construction_manager', 'pic_engineer', 'qaqc_engineer', 'site_engineer', 'project_planner'],
  'view.comparison': ['admin', 'ceo', 'project_manager', 'construction_manager', 'pic_engineer', 'qaqc_engineer', 'site_engineer', 'project_planner'],
  'view.all': ['admin', 'ceo', 'project_manager', 'construction_manager', 'pic_engineer', 'qaqc_engineer', 'site_engineer', 'project_planner'],
};
export const can = (role: Role | null | undefined, a: Action) => !!role && PERMS[a].includes(role);
export const PERMISSION_MATRIX = PERMS;

// ---------- counting rules (3.2, 3.4, 6.1, 7): counts overlap and are never added together
export interface Counts { total: number; installed: number; remaining: number; inspected: number; forInspection: number; rectification: number; approved: number; onHold: number; ongoing: number; notStarted: number; forApproval: number }
export function countTables(rows: TableState[], d: Discipline, subconId?: string | null): Counts {
  const c: Counts = { total: 0, installed: 0, remaining: 0, inspected: 0, forInspection: 0, rectification: 0, approved: 0, onHold: 0, ongoing: 0, notStarted: 0, forApproval: 0 };
  for (const t of rows) {
    const work = d === 'MMS' ? t.mms_work : t.pv_work;
    if (!work) continue;
    if (subconId !== undefined && (d === 'MMS' ? t.mms_subcon : t.pv_subcon) !== subconId) continue;
    const qa = (d === 'MMS' ? t.mms_qa : t.pv_qa) || 'none';
    c.total++;
    if (work === 'completed') c.installed++;
    if (work === 'on_hold') c.onHold++;
    if (work === 'ongoing') c.ongoing++;
    if (work === 'not_started') c.notStarted++;
    if (qa === 'ready_for_inspection' || qa === 'for_inspection') c.forInspection++;
    if (qa === 'for_rectification') c.rectification++;
    if (qa === 'for_approval') c.forApproval++;
    if (qa === 'approved') c.approved++;
    if (qa === 'approved' || qa === 'for_approval' || qa === 'for_rectification' || (d === 'MMS' ? t.mms_inspections : t.pv_inspections) > 0) c.inspected++;
  }
  c.remaining = c.total - c.installed;
  return c;
}
export const COUNT_RULES: Record<keyof Counts, string> = {
  total: 'Tables in scope (assigned to the subcontractor, or all tables)',
  installed: 'Physically complete (installation status Completed), whatever the QA/QC status',
  remaining: 'Total minus installed',
  inspected: 'At least one QA/QC or client inspection recorded, or already passed/approved',
  forInspection: 'Ready for Inspection or For Inspection',
  rectification: 'For Rectification (open defects)',
  approved: 'Required approval recorded',
  onHold: 'Installation On Hold',
  ongoing: 'Installation Ongoing',
  notStarted: 'Installation Not Started',
  forApproval: 'Passed inspection, awaiting approval',
};
export function matchCount(t: TableState, d: Discipline, k: keyof Counts): boolean {
  const work = d === 'MMS' ? t.mms_work : t.pv_work; const qa = (d === 'MMS' ? t.mms_qa : t.pv_qa) || 'none';
  if (!work) return false;
  switch (k) {
    case 'total': return true;
    case 'installed': return work === 'completed';
    case 'remaining': return work !== 'completed';
    case 'onHold': return work === 'on_hold';
    case 'ongoing': return work === 'ongoing';
    case 'notStarted': return work === 'not_started';
    case 'forInspection': return qa === 'ready_for_inspection' || qa === 'for_inspection';
    case 'rectification': return qa === 'for_rectification';
    case 'forApproval': return qa === 'for_approval';
    case 'approved': return qa === 'approved';
    case 'inspected': return qa === 'approved' || qa === 'for_approval' || qa === 'for_rectification' || (d === 'MMS' ? t.mms_inspections : t.pv_inspections) > 0;
  }
}

export const label = (t: Pick<TableState, 'table_code' | 'sys_key'>) => t.table_code || t.sys_key;
export const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : 0);
export const fmtPct = (n: number, d: number) => (d ? `${pct(n, d).toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : '—');
export const popcount = (m: number) => { let c = 0; for (let x = m >>> 0; x; x &= x - 1) c++; return c; };
export const fullMask = (n: number) => (n >= 31 ? 0x7fffffff : (1 << n) - 1);
export const ID_FLAG_TEXT: Record<string, string> = {
  NO_ID: 'No Table ID in the General Layout',
  DUPLICATE_ID: 'This Table ID is used by two tables in the General Layout',
  NONSTANDARD_FORMAT: 'Table ID format differs from the drawing’s usual pattern',
  ID_BY_LABEL_POSITION: 'Matched by label position (outline moved between drawings)',
  MULTIPLE_LABELS: 'More than one ID label inside this outline',
  BLOCK_MISMATCH: 'ID block differs from the CAD layer',
};
