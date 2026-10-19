import type { Request } from 'express';

/**
 * Адрес отправителя за прокси.
 *
 * API стоит за Caddy (kttf-infra), и `request.ip` — это всегда адрес
 * прокси: лимит по нему стал бы одним на весь сайт. Caddy дописывает адрес
 * клиента в конец `X-Forwarded-For`, а то, что клиент прислал в этом
 * заголовке сам, остаётся левее. Поэтому берётся последний элемент, а не
 * первый: первый подделывается одной строкой в запросе.
 *
 * Без заголовка — адрес соединения: так API отвечает в тестах и при
 * запуске без прокси.
 */
export function clientIp(request: Pick<Request, 'headers' | 'socket'>): string {
  const header = request.headers['x-forwarded-for'];
  const chain = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

  return chain.at(-1) ?? request.socket.remoteAddress ?? 'unknown';
}
