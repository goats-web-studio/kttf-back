import { describe, expect, it } from 'vitest';

import { fileKeysOf } from './file-keys.js';

describe('ключи файлов по адресу — ADR-092', () => {
  it('фото игрока и скан документа — один файл', () => {
    expect(fileKeysOf('/api/v1/files/players/0b5c.jpg')).toEqual(['players/0b5c.jpg']);
    expect(fileKeysOf('/api/v1/files/coach-docs/a1.webp')).toEqual(['coach-docs/a1.webp']);
  });

  it('пережатая картинка — основной файл и все варианты ширины', () => {
    const keys = fileKeysOf('/api/v1/files/coaches/a1.webp');

    expect(keys[0]).toBe('coaches/a1.webp');
    expect(keys).toContain('coaches/a1-480.webp');
    expect(keys).toContain('coaches/a1-960.webp');
  });

  it('чужой адрес и пустое значение ключей не дают', () => {
    expect(fileKeysOf(null)).toEqual([]);
    expect(fileKeysOf(undefined)).toEqual([]);
    expect(fileKeysOf('https://example.com/logo.png')).toEqual([]);
    expect(fileKeysOf('/api/v1/files/../secret.webp')).toEqual([]);
    expect(fileKeysOf('/api/v1/files/unknown/a1.webp')).toEqual([]);
  });
});
