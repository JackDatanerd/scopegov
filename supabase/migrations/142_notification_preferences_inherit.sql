-- ============================================================
-- ScopeGov — Migration 142: notification preferences can inherit a channel
--
-- Notifications & email fix round (independent pass).
--
-- notification_preferences had email_enabled / in_app_enabled both NOT NULL, so the first time a member toggled
-- EITHER channel of an event the route wrote BOTH columns — the untouched one frozen at whatever the workspace
-- default happened to be that day. An admin later changing the default ("applies to new and existing members" in
-- Settings) then never reached that member for the channel they had never touched.
--
-- NULL now means "no personal choice for this channel: follow the workspace default". Existing rows keep their
-- stored values (there is no way to tell which were real choices).
--
-- Idempotent.
-- ============================================================
ALTER TABLE public.notification_preferences ALTER COLUMN email_enabled  DROP NOT NULL;
ALTER TABLE public.notification_preferences ALTER COLUMN in_app_enabled DROP NOT NULL;
