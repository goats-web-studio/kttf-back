import type { AdminAuditQuery, AuditEntry, Page } from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { toAuditEntries } from './audit.js';

/** Журнал действий — ADR-103: по сущности или по тому, кто действовал. */
@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AdminAuditQuery): Promise<Page<AuditEntry>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.entityType === undefined ? {} : { entityType: query.entityType }),
      ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
      ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return pageOf(await toAuditEntries(this.prisma, rows), total, query);
  }
}
