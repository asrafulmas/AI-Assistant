export const PROTECTED_CHANNEL = {
  username: '@TeleforgeOfficial',
  url: 'https://t.me/TeleforgeOfficial',
  title: 'TELEFORGE OFFICIAL 🤖',
} as const;

export type ProtectedChannelConfig = typeof PROTECTED_CHANNEL;

export function verifyProtectedChannel(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const cfg = PROTECTED_CHANNEL;

  if (!cfg.username || cfg.username.length < 2) {
    errors.push('Protected channel username is missing or too short');
  }
  if (!cfg.username.startsWith('@')) {
    errors.push('Protected channel username must start with @');
  }
  if (!cfg.url) {
    errors.push('Protected channel URL is missing');
  }
  if (!cfg.url.startsWith('https://t.me/')) {
    errors.push('Protected channel URL must start with https://t.me/');
  }
  if (!cfg.title || cfg.title.length < 3) {
    errors.push('Protected channel title is missing or too short');
  }

  return { valid: errors.length === 0, errors };
}
