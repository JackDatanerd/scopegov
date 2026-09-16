-- FIX (re-audit, notifications section): flag_comment_added notifications
-- are inserted with entity_type='flag'/'exception', entity_id=<flag/exception
-- id> — but NotificationBell's entityHref() only ever resolves
-- 'project'/'project_message'/'approval_request', and even fixing that
-- client-side has nothing to build a project link from: the notifications
-- table never captured which project the event belonged to. Every other
-- project-scoped notification type sidesteps this by using entity_type =
-- 'project' directly (see guardian_flag, co_*, sow_*, invoice_* notify call
-- sites) — flag/exception comments are the one type that points at the
-- flag/exception itself instead. Add project_id so those notifications can
-- finally deep-link, without having to change what entity_type/entity_id
-- point at (other code may rely on entity_id being the flag/exception id).
alter table public.notifications
  add column if not exists project_id uuid references public.projects(id) on delete set null;

create index if not exists notifications_project
  on public.notifications(project_id) where project_id is not null;
