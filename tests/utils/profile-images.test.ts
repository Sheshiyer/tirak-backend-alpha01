import { describe, expect, it } from 'vitest';
import { firstProfileImage, isPublicImageUrl, publicProfileImages } from '@/utils/profileImages';

describe('public profile image filtering', () => {
  it.each(['file:///tmp/photo.jpg', 'data:image/png;base64,abc', 'blob:local', '/relative.jpg', 'javascript:alert(1)'])('rejects non-public reference %s', (value) => {
    expect(isPublicImageUrl(value)).toBe(false);
  });

  it('keeps only http and https URLs in stored arrays', () => {
    const value = JSON.stringify(['file:///phone/photo.jpg', 'https://cdn.example.test/photo.jpg', 'http://legacy.example.test/photo.jpg']);
    expect(publicProfileImages(value)).toEqual([
      'https://cdn.example.test/photo.jpg',
      'http://legacy.example.test/photo.jpg',
    ]);
    expect(firstProfileImage(value)).toBe('https://cdn.example.test/photo.jpg');
  });

  it('fails closed for malformed or unexpected storage values', () => {
    expect(publicProfileImages('[bad-json')).toEqual([]);
    expect(publicProfileImages({ url: 'https://cdn.example.test/photo.jpg' })).toEqual([]);
    expect(firstProfileImage('file:///phone/photo.jpg')).toBeNull();
  });
});
