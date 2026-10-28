// lib/integrations/drive-config.ts
//
// Which events the Drive archive can act on, and the permission needed to ask for each (the same rule as every other
// integration: you can only route what you could see yourself). Free of server imports so routes and the UI can share it.

export const DRIVE_EVENT_PERMISSIONS: Record<string, string> = {
  'sow.signed': 'SEND_SOW',
  'change_order.accepted': 'SEND_CHANGE_ORDERS',
}
export const DRIVE_EVENT_LABELS: Record<string, string> = {
  'sow.signed': 'Signed SOWs',
  'change_order.accepted': 'Accepted change orders',
}
/** How many past documents one "archive past documents" click may queue, per document type. */
export const BACKFILL_LIMIT = 200
/** Minimum gap between two backfills for one workspace. */
export const BACKFILL_COOLDOWN_MS = 10 * 60 * 1000
