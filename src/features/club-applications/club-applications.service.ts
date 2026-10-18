import { createHmac } from 'node:crypto';

import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type {
  ClubApplicationView,
  CreateClubApplicationInput,
  ListClubApplicationsQuery,
  Page,
  UpdateClubApplicationInput,
} from '@kttf/shared/types';
import { Inject, Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import { ENV, type Env } from '../../infra/config/env.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';

/** Заявок с одного адреса за час — больше живой человек не пишет. */
export const APPLICATIONS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

const fields = {
  id: true,
  name: true,
  contact: true,
  clubName: true,
  city: true,
  address: true,
  tableCount: true,
  tournaments: true,
  message: true,
  status: true,
  userId: true,
  createdAt: true,
  handledAt: true,
} as const;

type Row = Omit<ClubApplicationView, 'createdAt' | 'handledAt'> & {
  readonly createdAt: Date;
  readonly handledAt: Date | null;
};

/**
 * Заявки клубов — ADR-047.
 *
 * Принимает кто угодно, читает и отмечает только администратор платформы.
 * Это первый анонимный маршрут, который пишет в базу, поэтому у него две
 * защиты: ловушка для ботов и лимит заявок с одного адреса. Лимит считается
 * по самой таблице, а не в памяти процесса: переживает перезапуск API и не
 * требует ради одной формы заводить клиент Redis.
 */
@Injectable()
export class ClubApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async create(
    input: CreateClubApplicationInput,
    userId: string | undefined,
    ip: string,
  ): Promise<void> {
    // Бот заполнил скрытое поле. Отвечаем как обычно: отказ подсказал бы
    // ему, какое поле не трогать.
    if (input.website !== undefined && input.website.trim() !== '') {
      return;
    }

    const ipHash = this.hashIp(ip);
    const recent = await this.prisma.clubApplication.count({
      where: { ipHash, createdAt: { gt: new Date(Date.now() - HOUR_MS) } },
    });

    if (recent >= APPLICATIONS_PER_HOUR) {
      throw new AppError(ERROR_CODES.RATE_LIMITED, 'too many club applications from one address');
    }

    await this.prisma.clubApplication.create({
      data: {
        name: input.name,
        contact: input.contact,
        clubName: input.clubName,
        city: input.city,
        address: input.address ?? null,
        tableCount: input.tableCount ?? null,
        tournaments: input.tournaments ?? null,
        message: input.message ?? null,
        userId: userId ?? null,
        ipHash,
      },
    });
  }

  /** Свежие сверху: администратор разбирает с последних. */
  async list(query: ListClubApplicationsQuery): Promise<Page<ClubApplicationView>> {
    const where = query.status === undefined ? {} : { status: query.status };
    const [rows, total] = await Promise.all([
      this.prisma.clubApplication.findMany({
        where,
        select: fields,
        orderBy: { createdAt: 'desc' },
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.clubApplication.count({ where }),
    ]);

    return pageOf(rows.map(toView), total, query);
  }

  /** Обработано — с отметкой времени; вернули в новые — отметка снимается. */
  async update(id: string, input: UpdateClubApplicationInput): Promise<ClubApplicationView> {
    const found = await this.prisma.clubApplication.findUnique({
      where: { id },
      select: { id: true },
    });

    if (found === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'club application not found', { id });
    }

    const row = await this.prisma.clubApplication.update({
      where: { id },
      data: { status: input.status, handledAt: input.status === 'DONE' ? new Date() : null },
      select: fields,
    });

    return toView(row);
  }

  /**
   * HMAC, а не голый SHA-256: адресов IPv4 всего четыре миллиарда, и хэш
   * без ключа перебирается за минуты. Ключ — секрет токенов: он и так
   * обязан быть длинным и в репозиторий не попадает.
   */
  private hashIp(ip: string): string {
    return createHmac('sha256', this.env.JWT_SECRET).update(ip).digest('hex');
  }
}

function toView(row: Row): ClubApplicationView {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    handledAt: row.handledAt?.toISOString() ?? null,
  };
}
