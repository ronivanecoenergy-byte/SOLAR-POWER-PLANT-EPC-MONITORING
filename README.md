# Expansion PV Farm — one-stop project monitoring

**Live app: https://ronivanecoenergy-byte.github.io/SOLAR-POWER-PLANT-EPC-MONITORING/** (sign-in required)

A web app for desktop and phone that ties every PV table on the site keyplan to its installation
progress, subcontractor, inspections and approvals. The **Interactive Digital Keyplan** is the
centre of it: the latest drone image with the CAD table outlines laid over it, table by table.

- **Front end**: React 18 + TypeScript (Vite), OpenLayers for the keyplan, hosted on GitHub Pages.
- **Back end**: Supabase. Postgres holds the records, with row-level security for every role and
  all workflow changes made through `security definer` functions. Supabase Auth handles sign-in
  and Supabase Storage holds the drone tiles and the photos, both in private buckets.
- **Deployment**: `.github/workflows/deploy.yml`. Every push to `main` migrates the database,
  builds and publishes the site, then smoke-tests the live site without changing any record.

## What it does

| Area | Features |
|---|---|
| Digital keyplan | Drone image of 26 Oct 2026, registered to the CAD at table level (0.13 m/pixel). Each table is a clickable outline with a translucent status fill and a status-opacity slider (45% default). The selected table gets a translucent blue fill. Table ID labels and module grids appear as you zoom in. Pan, zoom and Table ID search work on desktop and phone. Layers: drone, general layout, MMS installation, MMS per subcontractor, PV installation, PV per subcontractor. Piles, inverters, MVPS, cables and earthing are listed as "source needed". |
| Status | The brief's nine colours (Not Started … Completed). Physical completion is tracked separately from QA/QC, and completed work is never treated as approved. |
| Subcontractors | Assigned, installed, for inspection, inspected, for rectification and approved counts per company. The counts overlap and are never added together. Clicking a count highlights its tables; clicking a legend entry dims the other companies; "All subcontractors" restores the view. |
| Mechanical works | Mounting structure (MMS) and PV modules are kept as separate records joined by Table ID. PV modules are tracked one by one on the 4 × 7 grid. PV cannot start until the structure is complete, unless an exception is recorded. |
| Workflow | Plan → assign → execute → update → verify → inspect → approve. Subcontractors report and engineers verify. QA/QC inspects; a failed inspection raises punch items, rectification, re-inspection and then client approval. Approved work is locked. QA/QC can reopen an approval, which raises a punch item; only an administrator can edit approved work directly. |
| Dashboards | One view per role: executive, project status, site execution, work coordination, quality, field progress, planning, and a subcontractor's own work. They show plan vs actual, a completion forecast, daily output, turnaround, quality by company, constraints, milestones and weekly targets. |
| Reports | Daily, weekly, subcontractor, QA/QC and punch-list reports, exported to Excel and PDF. |
| Field use | Phone layout with a tab bar, large status buttons, camera capture for photos and deep links to a table. |
| Audit | Every change is written to the audit log and the table's history: who, when, from what, to what. |
| Administration | Users and roles, subcontractor colours and drawing aliases, the drawing register, import issues (accept or correct), the drone fit, project settings, the audit trail and the permissions matrix. |

## Roles

| Role | Sees | Can change |
|---|---|---|
| CEO | Everything | Raises site constraints; otherwise view only |
| Project Manager | Everything | Targets, dates and milestones. Records approvals and dependency exceptions. Constraints and photos |
| Construction Manager | Everything | Progress and verification. Assignments, target dates and dependency exceptions. Constraints and photos |
| Project-in-Charge (PIC) Engineer | Everything | Progress and verification. Assignments. Inspection requests and scheduling. Targets and dates. Constraints and photos |
| QA/QC Engineer | Everything | Inspections, punch items, approvals and reopening approvals. Constraints and photos |
| Site Engineer | Everything | Progress and verification, limited to their blocks if any are assigned. Inspection requests and scheduling. Constraints and photos |
| Project Planner | Everything | Targets, dates, milestones and dependency rules. Raises constraints. No statuses, inspections or approvals |
| Subcontractor | Only its own tables | Reports progress for verification. Requests inspection, rectifies punch items, raises constraints and adds photos. Cannot inspect or approve |
| Administrator | Everything | Everything, including users, settings and editing approved work |

The database enforces these rights (row-level security and checks in each workflow function),
not just the screens. **Administration → Permissions** shows the full matrix.

New accounts start with no role and see nothing until an administrator assigns one.

## Where the data comes from

| Source | Used for |
|---|---|
| `MMS_APPROVED_2.0.dwg` | Baseline geometry: 3,512 tables (the 4,682 outlines include 1,170 stacked duplicates). Also MMS approvals: 2,299 tables (the earlier revision had 2,289). |
| `EXPANSION_PV_FARM_-_GEENRAL_LAYOUT.dwg` | Table IDs (`M04-11-07` = block, row, column): 3,508 tables have one |
| `APPROVED_PV.dwg` | PV approvals: 2,166 tables |
| `MS_APPROVED_PER_SUBCON.dwg` | MMS assignments: 2,348 (TECHNO 1,192, JJC 659, SAL 380, RMS 111, AAPCI 6) |
| `PV_ACCOMP_1._PER_SUBCON.dwg` (right-hand keyplan) | PV assignments: 2,325 (TECHNO 1,126, SAL 598, JJC 485, RMS 110, AAPCI 6) |
| Drone image of 26 Oct 2026 | Background layer and a check on PV progress: modules are visible on 2,043 of the 2,166 PV-approved tables, and on 138 tables not yet approved |

How the drawings were read:
- A green fill means "installed and QA/QC approved". The import records this as completed with a
  QA/QC approval that cites the drawing, with no approval date.
- JJ and JJCES are the same company as JJC, and AAPSI is the same as AAPCI.
- MMS_APPROVED_2.0 is the MMS baseline.
- The eastern section (about 1,500 tables, shown only on the left-hand keyplan of PV_ACCOMP_1)
  is not imported yet.

Every anomaly is listed under **Administration → Import issues**, where it can be accepted or
corrected:
- 4 tables without a Table ID;
- 5 IDs used by two tables each;
- 5 IDs in a non-standard format;
- 2 tables marked "For checking";
- 32 tables with PV approved before the structure (recorded as dependency exceptions for review);
- the rest of the 131 issues.

## Deploying

One-time setup:
1. Create a Supabase project and an access token (supabase.com/dashboard/account/tokens).
2. In the GitHub repository, add the secrets `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`
   and `DATA_KEY`. Each value is recognised by its form, so it does not matter which secret holds
   which value. The project ID is also recorded in the workflow (`FALLBACK_PROJECT_REF`).
3. Set **Settings → Pages → Source** to "GitHub Actions".

Each push to `main` then runs three jobs:
1. **build**:
   - decrypts `data/bundle.tar.gz.enc`;
   - applies `supabase/migrations/*.sql` once each (tracked in `public.app_migrations`);
   - loads the CAD baseline into an empty project;
   - sets the auth site URL;
   - creates any role accounts that are missing, and never changes existing accounts;
   - uploads the drone tiles that are missing;
   - builds the app.
2. **deploy** publishes `dist/` on GitHub Pages.
3. **smoke** waits for the new version to go live. It then runs:
   - the read-only API permission checks: `node scripts/api-tests.mjs --readonly`;
   - the read-only browser tests on desktop and phone: `E2E_READONLY=1 npx playwright test`.

   These sign in with the demo accounts. If those accounts are deactivated, set the repository
   variable `SMOKE_TESTS` to `off`.

The repository is public, so project data (seed SQL, drone tiles, demo accounts) is committed only
in encrypted form. To rebuild the bundle after changing the data, run `scripts/bundle-data.sh`.

## Working locally

```bash
npm ci
# .env.local: VITE_SUPABASE_URL=… and VITE_SUPABASE_ANON_KEY=… of a Supabase project with the migrations and seed
npm run dev
```

Tests (against a disposable project or a local Supabase stack, never production):

```bash
SUPABASE_URL=… SUPABASE_ANON_KEY=… DEMO_USERS=data/secrets/demo_users.json node scripts/api-tests.mjs   # 23 API tests
SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… npx playwright test                    # desktop + phone
```

Rebuilding the data from the drawings (the source files are not in the repository):

```bash
node pipeline/parse_dwg.mjs                  # DWG → JSON (LibreDWG WebAssembly)
python3 pipeline/build_registry.py           # tables, IDs, statuses, assignments, import issues
python3 -I pipeline/drone.py <drone.png> 2026-10-26 --tiles   # registration, per-table evidence, tiles
python3 pipeline/build_seed.py               # idempotent seed SQL
scripts/bundle-data.sh                       # encrypt for the deployment workflow
```

## Before real use

- **Demo accounts.** Change or deactivate them in Administration → Users. The deployment never
  re-enables an account.
- **Password-reset emails.** Supabase's built-in mailer only delivers to members of the Supabase
  organisation and is heavily rate-limited. Configure custom SMTP in Supabase (Authentication →
  Emails) before relying on reset emails.
- **Supabase free tier.** A free project is paused after a week without activity. Upgrade, or
  restore it from the dashboard.
- **Missing sources.** The pile, inverter, MVPS, cable and earthing layers need their drawings.
  The eastern section needs its baseline.
