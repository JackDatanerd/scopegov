-- Notifications & email independent pass: notification-cleanup now prunes READ notifications by read_at
-- (they used to be pruned by created_at). Partial index so the nightly sweep does not scan the table.
CREATE INDEX IF NOT EXISTS notifications_read_at
  ON public.notifications(read_at) WHERE read = true;
