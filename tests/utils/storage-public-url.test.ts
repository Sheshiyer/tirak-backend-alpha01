import { describe, expect, it } from 'vitest';
import { publicAssetUrl } from '@/utils/storage';

describe('publicAssetUrl', () => {
  it('joins and encodes an R2 key under the configured Worker route', () => {
    expect(publicAssetUrl('https://api.example.test/api/uploads/public/', 'avatars/user 1/profile#.jpg'))
      .toBe('https://api.example.test/api/uploads/public/avatars/user%201/profile%23.jpg');
  });

  it('fails closed when a public base URL is not configured', () => {
    expect(() => publicAssetUrl(undefined, 'avatars/user/photo.jpg')).toThrow('PUBLIC_ASSET_BASE_URL');
  });
});
