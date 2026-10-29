// lib/help/permission-labels.ts
// Plain-language names for permission keys, for the "Who this is for" strip. Add a line when an article first needs one;
// an unlisted key falls back to its key lowercased (CREATE_PROJECTS -> "create projects"), so nothing ever renders blank.

import type { Permission } from '@/lib/supabase/types'

const LABELS: Partial<Record<Permission, string>> = {
  CREATE_PROJECTS: 'Create projects',
  EDIT_SOW: 'Edit SOWs',
  SEND_SOW: 'Send SOWs',
  CREATE_CHANGE_ORDERS: 'Create change orders',
  SEND_CHANGE_ORDERS: 'Send change orders',
  INVITE_MEMBERS: 'Invite members',
  MANAGE_BILLING: 'Manage billing',
  MANAGE_WORKSPACE_SETTINGS: 'Manage workspace settings',
}

export function helpPermissionLabel(p: Permission): string {
  return LABELS[p] ?? p.toLowerCase().replace(/_/g, ' ')
}
