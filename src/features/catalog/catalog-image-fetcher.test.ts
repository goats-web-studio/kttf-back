import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../infra/config/env.js';
import {
  CatalogImageFetcher,
  IMPORT_IMAGE_MAX_BYTES,
  importHosts,
  isAllowedImageUrl,
} from './catalog-image-fetcher.js';

/**
 * Скачивание фото импорта. Ссылки приходят из файла, поэтому главное здесь —
 * что сервер не уходит с разрешённых хостов ни прямо, ни переадресацией.
 */

const fetcher = new CatalogImageFetcher({} as Env);

function image(body = 'jpg', headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg', ...headers } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('разрешённые адреса', () => {
  const hosts = ['rttf.ru'];

  it('хост и его поддомены — да, похожие — нет', () => {
    expect(isAllowedImageUrl(new URL('https://rttf.ru/a.jpg'), hosts)).toBe(true);
    expect(isAllowedImageUrl(new URL('https://img.rttf.ru/a.jpg'), hosts)).toBe(true);
    expect(isAllowedImageUrl(new URL('https://rttf.ru.evil.example/a.jpg'), hosts)).toBe(false);
    expect(isAllowedImageUrl(new URL('https://notrttf.ru/a.jpg'), hosts)).toBe(false);
  });

  it('только https и без учётных данных в адресе', () => {
    expect(isAllowedImageUrl(new URL('http://rttf.ru/a.jpg'), hosts)).toBe(false);
    expect(isAllowedImageUrl(new URL('https://user:pass@rttf.ru/a.jpg'), hosts)).toBe(false);
  });

  it('список хостов — из окружения, по умолчанию rttf.ru', () => {
    expect(importHosts({})).toEqual(['rttf.ru']);
    expect(importHosts({ CATALOG_IMPORT_HOSTS: 'rttf.ru,cdn.example.kz' })).toEqual([
      'rttf.ru',
      'cdn.example.kz',
    ]);
  });
});

describe('скачивание', () => {
  it('пробелы в пути кодируются', async () => {
    const fetchMock = vi.fn().mockResolvedValue(image());
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetcher.fetch('https://rttf.ru/img/E Lebesson.jpg')).resolves.toEqual(
      Buffer.from('jpg'),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://rttf.ru/img/E%20Lebesson.jpg');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('чужой хост — отказ без запроса', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetcher.fetch('https://169.254.169.254/latest')).rejects.toMatchObject({
      reason: 'HOST',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('переадресация на свой хост проходит, на чужой — отказ', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(redirect('/img/b.jpg')).mockResolvedValueOnce(image()),
    );
    await expect(fetcher.fetch('https://rttf.ru/img/a.jpg')).resolves.toEqual(Buffer.from('jpg'));

    const fetchMock = vi.fn().mockResolvedValueOnce(redirect('https://evil.example/x.jpg'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetcher.fetch('https://rttf.ru/img/a.jpg')).rejects.toMatchObject({
      reason: 'HOST',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('не картинка и SVG — отказ', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(image('<html>', { 'content-type': 'text/html' })),
    );
    await expect(fetcher.fetch('https://rttf.ru/a')).rejects.toMatchObject({ reason: 'TYPE' });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(image('<svg/>', { 'content-type': 'image/svg+xml' })),
    );
    await expect(fetcher.fetch('https://rttf.ru/a.svg')).rejects.toMatchObject({ reason: 'TYPE' });
  });

  it('больше потолка — отказ и по заголовку, и по телу', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(image('x', { 'content-length': String(IMPORT_IMAGE_MAX_BYTES + 1) })),
    );
    await expect(fetcher.fetch('https://rttf.ru/a.jpg')).rejects.toMatchObject({ reason: 'SIZE' });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(image('x'.repeat(IMPORT_IMAGE_MAX_BYTES + 1))),
    );
    await expect(fetcher.fetch('https://rttf.ru/a.jpg')).rejects.toMatchObject({ reason: 'SIZE' });
  });

  it('ошибка ответа и сеть — отказ с причиной', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(fetcher.fetch('https://rttf.ru/a.jpg')).rejects.toMatchObject({ reason: 'HTTP' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(fetcher.fetch('https://rttf.ru/a.jpg')).rejects.toMatchObject({
      reason: 'NETWORK',
    });
  });
});
