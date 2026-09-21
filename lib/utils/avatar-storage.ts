// lib/utils/avatar-storage.ts
//
// Profile photos live in the public `logos` bucket at a path derived from the
// user's id, so they can always be found (and removed) without a second column.

export const AVATAR_BUCKET = 'logos'
export const AVATAR_EXTENSIONS = ['png', 'jpg'] as const

export function avatarPaths(userId: string): string[] {
  return AVATAR_EXTENSIONS.map(ext => `avatars/${userId}.${ext}`)
}

/**
 * Remove every stored copy of a user's profile photo. Missing objects are not
 * an error (remove() succeeds for paths that don't exist). Returns the storage
 * error message if the removal itself failed.
 */
export async function removeAvatarObjects(service: any, userId: string): Promise<string | null> {
  const { error } = await service.storage.from(AVATAR_BUCKET).remove(avatarPaths(userId))
  return error ? String(error.message || error) : null
}
