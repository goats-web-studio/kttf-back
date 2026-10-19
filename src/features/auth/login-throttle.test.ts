import { describe, expect, it } from 'vitest';

import type { Env } from '../../infra/config/env.js';
import {
  LOGIN_FAILURES_PER_ACCOUNT,
  LOGIN_FAILURES_PER_ADDRESS,
  LoginThrottle,
} from './login-throttle.js';

const make = (): LoginThrottle => new LoginThrottle({ JWT_SECRET: 'x'.repeat(32) } as Env);
const NOW = 1_000_000;

function fail(
  throttle: LoginThrottle,
  times: number,
  identifier: (i: number) => string,
  ip: string,
): void {
  for (let attempt = 0; attempt < times; attempt += 1) {
    throttle.recordFailure(identifier(attempt), ip, NOW);
  }
}

describe('защита входа — ADR-056', () => {
  it('после десяти неудач логин закрыт на четверть часа, регистр и пробелы не важны', () => {
    const throttle = make();
    fail(throttle, LOGIN_FAILURES_PER_ACCOUNT, () => 'Aslan', '1.1.1.1');

    expect(() => {
      throttle.assertAllowed(' aslan ', '2.2.2.2', NOW + 1000);
    }).toThrow(
      expect.objectContaining({
        code: 'RATE_LIMITED',
        details: { retryAfterSeconds: 899 },
      }) as Error,
    );
    expect(() => {
      throttle.assertAllowed('aslan', '2.2.2.2', NOW + 15 * 60 * 1000);
    }).not.toThrow();
  });

  it('девять неудач ещё не закрывают, удачный вход обнуляет счёт логина', () => {
    const throttle = make();
    fail(throttle, LOGIN_FAILURES_PER_ACCOUNT - 1, () => 'aslan', '1.1.1.1');
    expect(() => {
      throttle.assertAllowed('aslan', '1.1.1.1', NOW);
    }).not.toThrow();

    throttle.recordSuccess('aslan');
    fail(throttle, LOGIN_FAILURES_PER_ACCOUNT - 1, () => 'aslan', '3.3.3.3');
    expect(() => {
      throttle.assertAllowed('aslan', '3.3.3.3', NOW);
    }).not.toThrow();
  });

  it('с одного адреса по разным логинам — свой предел, другой адрес не задет', () => {
    const throttle = make();
    fail(throttle, LOGIN_FAILURES_PER_ADDRESS, (i) => `user${String(i)}`, '1.1.1.1');

    expect(() => {
      throttle.assertAllowed('aslan', '1.1.1.1', NOW);
    }).toThrow(expect.objectContaining({ code: 'RATE_LIMITED' }) as Error);
    expect(() => {
      throttle.assertAllowed('aslan', '2.2.2.2', NOW);
    }).not.toThrow();
  });
});
