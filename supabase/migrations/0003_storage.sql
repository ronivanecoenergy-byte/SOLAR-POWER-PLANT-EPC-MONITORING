-- =====================================================================================
-- File storage: photos/documents per table, and the drone imagery tiles.
-- Both buckets are private. Object paths in "attachments" start with the table's id,
-- so access follows the same rule as the table's records.
-- =====================================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('attachments', 'attachments', false, 26214400,
   array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'text/plain','text/csv']),
  ('drone', 'drone', false, 10485760, array['image/webp','image/png','image/jpeg','application/json'])
on conflict (id) do nothing;

drop policy if exists "attachments: read" on storage.objects;
drop policy if exists "attachments: add" on storage.objects;
drop policy if exists "attachments: delete" on storage.objects;
drop policy if exists "drone: read" on storage.objects;

create policy "attachments: read" on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and ((select public.is_staff()) or public.can_see(public.try_uuid(split_part(name, '/', 1)))));
create policy "attachments: add" on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and (select public.is_member()) and public.can_see(public.try_uuid(split_part(name, '/', 1))));
create policy "attachments: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and (owner_id = (select auth.uid())::text or (select public.has_role('admin'))));
create policy "drone: read" on storage.objects for select to authenticated
  using (bucket_id = 'drone' and (select public.is_member()));

notify pgrst, 'reload schema';
