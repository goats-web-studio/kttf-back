import { createHmac } from 'node:crypto';

/**
 * Хеш номера телефона для архива — ADR-095.
 *
 * HMAC SHA-256 на `JWT_SECRET`, как хеш IP: сам номер после удаления
 * аккаунта не хранится, а сравнить новый аккаунт с архивом хешем можно.
 * Простой SHA-256 номера не годится — номеров мало, перебор вернул бы их все.
 */
export function phoneHash(secret: string, phone: string): string {
  return createHmac('sha256', secret).update(phone).digest('hex');
}
