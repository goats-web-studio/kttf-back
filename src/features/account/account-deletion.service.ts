import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type { DeleteAccountInput } from '@kttf/shared/types';
import { Injectable, Logger } from '@nestjs/common';

import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { LoginThrottle } from '../auth/login-throttle.js';
import { DUMMY_HASH, verifyPassword } from '../auth/password.js';
import { TokenService } from '../auth/token.service.js';
import { fileKeysOf } from '../files/file-keys.js';
import { StorageService } from '../files/storage.service.js';
import { duelSubject } from '../forum/forum-subjects.service.js';
import { DELETED_PLAYER_TITLE_RU } from '../players/deleted-player.js';

/** Дуэли, которые ещё не сыграны: их отменяют, а не хранят. */
const ACTIVE_DUEL = ['OPEN', 'CHALLENGE', 'SCHEDULED'] as const;

/** Предел заголовка темы форума. */
const TOPIC_TITLE_MAX = 150;

/**
 * Удаление аккаунта — ADR-092.
 *
 * Строка `User` удаляется целиком: телефон, логин и почта освобождаются, а
 * сессии и всё личное уходят каскадом. Игрок со спортивной историей остаётся
 * обезличенным «Удалённым игроком» (`Player.deletedAt`, имя — пустые строки):
 * встречи, места и события рейтинга — это и история соперников, а пересчёт
 * рейтинга обязан давать тот же результат (бриф, запрет №3). Игрок без истории
 * удаляется вместе с аккаунтом.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly throttle: LoginThrottle,
    private readonly storage: StorageService,
  ) {}

  async deleteAccount(userId: string, input: DeleteAccountInput, ip: string): Promise<void> {
    const throttleKey = `delete:${userId}`;

    // Пароль подбирать перебором так же нельзя, как при входе (ADR-056).
    this.throttle.assertAllowed(throttleKey, ip);

    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });

    if (account === null) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'User no longer exists');
    }

    // Без пароля аккаунтом не войти (ADR-034), и удалить его так тоже нельзя:
    // сверка с подставным хешем всегда ложна, а время ответа то же.
    if (!verifyPassword(input.password, account.passwordHash ?? DUMMY_HASH)) {
      this.throttle.recordFailure(throttleKey, ip);
      throw new AppError(ERROR_CODES.WRONG_PASSWORD, 'Password is wrong');
    }

    this.throttle.recordSuccess(throttleKey);

    const fileKeys = await this.prisma.$transaction(
      async (tx) => {
        // Блокировка строки: два одновременных удаления не идут параллельно,
        // второе увидит, что пользователя уже нет.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;

        if (locked.length === 0) {
          throw new AppError(ERROR_CODES.UNAUTHORIZED, 'User no longer exists');
        }

        await assertDeletable(tx, userId);

        return eraseAccount(tx, userId, new Date());
      },
      { timeout: 30_000, maxWait: 5_000 },
    );

    this.tokens.revokeUser(userId);
    await this.removeFiles(fileKeys);
  }

  /**
   * Файлы — после фиксации: откат транзакции не вернул бы стёртое фото. Сбой
   * хранилища удаление не отменяет: данные в базе уже стёрты, а осиротевший
   * файл без ссылки на него никто не найдёт; в журнал — чтобы дочистить.
   */
  private async removeFiles(keys: readonly string[]): Promise<void> {
    try {
      await this.storage.remove(keys);
    } catch (error) {
      this.logger.warn(`S3 cleanup failed for ${String(keys.length)} files`, error);
    }
  }
}

/** Последний владелец клуба и последний администратор аккаунт не удаляют. */
async function assertDeletable(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const owned = await tx.clubMember.findMany({
    where: { userId, role: 'OWNER' },
    select: { clubId: true },
  });

  if (owned.length > 0) {
    const others = await tx.clubMember.findMany({
      where: { clubId: { in: owned.map((row) => row.clubId) }, role: 'OWNER', NOT: { userId } },
      select: { clubId: true },
    });
    const covered = new Set(others.map((row) => row.clubId));
    const clubIds = owned.map((row) => row.clubId).filter((id) => !covered.has(id));

    if (clubIds.length > 0) {
      throw new AppError(ERROR_CODES.ACCOUNT_DELETE_BLOCKED, 'Last owner of a club', {
        reason: 'LAST_CLUB_OWNER',
        clubIds,
      });
    }
  }

  const user = await tx.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });

  if (user?.isAdmin === true) {
    const admins = await tx.user.count({ where: { isAdmin: true, NOT: { id: userId } } });

    if (admins === 0) {
      throw new AppError(ERROR_CODES.ACCOUNT_DELETE_BLOCKED, 'Last platform admin', {
        reason: 'LAST_ADMIN',
      });
    }
  }
}

/**
 * Стирает аккаунт внутри транзакции и отдаёт ключи файлов для удаления.
 *
 * Порядок важен: страница тренера ссылается на пользователя без каскада и
 * удаляется первой, а сама строка `User` — последней, когда всё, что надо
 * обезличить вручную, уже обезличено.
 */
async function eraseAccount(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date,
): Promise<string[]> {
  const player = await tx.player.findUnique({
    where: { userId },
    select: { id: true, photoUrl: true },
  });
  const playerId = player?.id ?? null;

  const coaches = await tx.coach.findMany({
    where: playerId === null ? { userId } : { OR: [{ userId }, { playerId }] },
    select: {
      id: true,
      photoUrl: true,
      coverUrl: true,
      posts: { select: { imageUrl: true } },
      media: { select: { imageUrl: true } },
      credentials: { select: { fileKey: true } },
    },
  });
  const coachIds = coaches.map((coach) => coach.id);

  const posts = await tx.forumPost.findMany({
    where: { authorId: userId },
    select: { id: true, images: true },
  });
  const postIds = posts.map((post) => post.id);

  const duelIds = playerId === null ? [] : await duelsOf(tx, playerId);

  const trials = await tx.trialRequest.findMany({
    where: {
      OR: [
        { userId },
        ...(coachIds.length === 0
          ? []
          : [{ coachId: { in: coachIds } }, { training: { coachId: { in: coachIds } } }]),
      ],
    },
    select: { id: true },
  });
  const trialIds = trials.map((trial) => trial.id);

  const fileKeys = [
    ...fileKeysOf(player?.photoUrl),
    ...coaches.flatMap((coach) => [
      ...fileKeysOf(coach.photoUrl),
      ...fileKeysOf(coach.coverUrl),
      ...coach.posts.flatMap((post) => fileKeysOf(post.imageUrl)),
      ...coach.media.flatMap((media) => fileKeysOf(media.imageUrl)),
      ...coach.credentials.flatMap((credential) => fileKeysOf(credential.fileKey)),
    ]),
    ...posts.flatMap((post) => imageUrlsOf(post.images).flatMap((url) => fileKeysOf(url))),
  ];

  // Страница тренера. Тренировки клуба, которые он вёл, остаются за клубом
  // без тренера; своё (тренировки, заявки, посты, сканы) уходит каскадом.
  if (coachIds.length > 0) {
    await tx.training.updateMany({
      where: { author: 'CLUB', coachId: { in: coachIds } },
      data: { coachId: null, link: 'NONE', linkAt: now, booking: 'CLUB' },
    });
    await tx.follow.deleteMany({ where: { targetType: 'COACH', targetId: { in: coachIds } } });
    await tx.forumTopic.updateMany({
      where: { subjectType: 'COACH', subjectId: { in: coachIds } },
      data: { title: DELETED_PLAYER_TITLE_RU },
    });
    await tx.coach.deleteMany({ where: { id: { in: coachIds } } });
  }

  if (playerId !== null) {
    await erasePlayer(tx, playerId, duelIds, now);
  }

  // Форум: свои сообщения — заглушка «удалено», как при удалении автором;
  // цитаты из них у других людей — тоже. Лайки снимаются до каскада.
  if (postIds.length > 0) {
    await tx.forumPost.updateMany({
      where: { authorId: userId, deletedAt: null },
      data: { deletedAt: now },
    });
    await tx.forumPost.updateMany({
      where: { authorId: userId },
      data: { body: '', images: [], quoteText: null },
    });
    await tx.forumPost.updateMany({
      where: { quotePostId: { in: postIds } },
      data: { quoteText: null },
    });
  }

  await tx.$executeRaw`
    UPDATE "ForumPost" p SET "likesCount" = GREATEST(p."likesCount" - 1, 0)
    FROM "ForumLike" l WHERE l."postId" = p.id AND l."userId" = ${userId}`;

  // Уведомления других людей, где в снимке имя этого человека: о его
  // сообщениях, дуэлях и заявках. Свои уйдут каскадом.
  await tx.$executeRaw`
    DELETE FROM "Notification" WHERE "userId" <> ${userId} AND (
      data->>'postId' = ANY(${postIds}::text[])
      OR data->>'duelId' = ANY(${duelIds}::text[])
      OR data->>'trialRequestId' = ANY(${trialIds}::text[]))`;

  // В журнал — только идентификаторы: запись об удалении сама не должна
  // хранить то, что удалено.
  await tx.auditLog.create({
    data: {
      actorId: userId,
      action: 'account.deleted',
      entityType: 'User',
      entityId: userId,
      after: { playerId, coachIds },
    },
  });

  // Каскадом: сессии, роли в клубах, свои уведомления, заявки, подписки,
  // лайки и жалобы. Авторство контента клубов и тем форума обнуляется.
  await tx.user.delete({ where: { id: userId } });

  return fileKeys;
}

/** Дуэли игрока: автор, соперник или откликнувшийся. */
async function duelsOf(tx: Prisma.TransactionClient, playerId: string): Promise<string[]> {
  const [own, responded] = await Promise.all([
    tx.duel.findMany({
      where: { OR: [{ authorId: playerId }, { opponentId: playerId }] },
      select: { id: true },
    }),
    tx.duelResponse.findMany({ where: { playerId }, select: { duelId: true } }),
  ]);

  return [...new Set([...own.map((duel) => duel.id), ...responded.map((row) => row.duelId)])];
}

/**
 * Игрок: связи с другими людьми рвутся, личное стирается, спорт остаётся.
 * Без спортивной истории строка удаляется целиком.
 */
async function erasePlayer(
  tx: Prisma.TransactionClient,
  playerId: string,
  duelIds: readonly string[],
  now: Date,
): Promise<void> {
  // Тренер и ученики: связь — это сведения о двух людях, а один из них ушёл.
  await tx.coachTenure.deleteMany({
    where: { OR: [{ playerId }, { coachPlayerId: playerId }] },
  });
  await tx.player.updateMany({
    where: { coachPlayerId: playerId },
    data: { coachPlayerId: null },
  });
  await tx.registration.updateMany({
    where: { coachPlayerId: playerId },
    data: { coachPlayerId: null, coachName: null, coachManual: false },
  });

  // Несыгранные дуэли отменяются молча: уведомление несло бы имя человека,
  // а страница дуэли и так покажет отмену. Сыгранные и спорные остаются —
  // их доводят соперник или администратор.
  const active = { status: { in: [...ACTIVE_DUEL] } };
  const activeDuels = await tx.duel.findMany({
    where: { ...active, OR: [{ authorId: playerId }, { opponentId: playerId }] },
    select: { id: true },
  });
  await tx.duel.updateMany({
    where: { id: { in: activeDuels.map((duel) => duel.id) } },
    data: { status: 'CANCELLED', closedAt: now, closeReason: null },
  });
  await tx.duelResponse.updateMany({
    where: { duelId: { in: activeDuels.map((duel) => duel.id) }, status: 'NEW' },
    data: { status: 'DECLINED', answeredAt: now },
  });

  // Личные тексты и контакты в дуэлях стираются; решения администратора —
  // нет, это не сведения о человеке.
  await tx.duel.updateMany({
    where: { authorId: playerId },
    data: { note: null, authorContact: null },
  });
  await tx.duel.updateMany({ where: { opponentId: playerId }, data: { opponentContact: null } });
  await tx.duel.updateMany({
    where: { OR: [{ authorId: playerId }, { opponentId: playerId }] },
    data: { disputeComment: null, rescheduleMessage: null, closeReason: null },
  });
  await tx.duelResponse.updateMany({
    where: { playerId, status: 'NEW' },
    data: { status: 'WITHDRAWN' },
  });
  await tx.duelResponse.updateMany({ where: { playerId }, data: { message: null, contact: null } });

  await tx.follow.deleteMany({ where: { targetType: 'PLAYER', targetId: playerId } });

  await renameDuelTopics(tx, playerId, duelIds);

  const history = await tx.player.findUnique({
    where: { id: playerId },
    select: {
      _count: {
        select: {
          registrations: true,
          ratingEvents: true,
          duelsAuthored: true,
          duelsOpposed: true,
        },
      },
    },
  });
  const counts = history?._count;
  const hasHistory =
    counts !== undefined &&
    counts.registrations + counts.ratingEvents + counts.duelsAuthored + counts.duelsOpposed > 0;

  if (!hasHistory) {
    await tx.player.delete({ where: { id: playerId } });
    return;
  }

  // Год рождения, пол и город остаются: по ним в снимках идущих турниров
  // проверяется допуск в категорию, а колонки обязательны.
  await tx.player.update({
    where: { id: playerId },
    data: {
      deletedAt: now,
      userId: null,
      lastName: '',
      firstName: '',
      middleName: null,
      birthDate: null,
      birthYearOnly: true,
      photoUrl: null,
      clubId: null,
      playingHand: null,
      grip: null,
      blade: null,
      rubberForehand: null,
      rubberBackhand: null,
      bio: null,
      bladeProductId: null,
      rubberForehandProductId: null,
      rubberBackhandProductId: null,
      coachPlayerId: null,
      coachName: null,
      coachVisibility: 'ALL',
    },
  });
}

/** Темы дуэлей подписаны фамилиями (ADR-068) — подпись пересобирается. */
async function renameDuelTopics(
  tx: Prisma.TransactionClient,
  playerId: string,
  duelIds: readonly string[],
): Promise<void> {
  if (duelIds.length === 0) return;

  const topics = await tx.forumTopic.findMany({
    where: { subjectType: 'DUEL', subjectId: { in: [...duelIds] } },
    select: { id: true, subjectId: true },
  });
  if (topics.length === 0) return;

  const duels = await tx.duel.findMany({
    where: { id: { in: topics.flatMap((topic) => topic.subjectId ?? []) } },
    select: {
      id: true,
      kind: true,
      author: { select: { id: true, lastName: true } },
      opponent: { select: { id: true, lastName: true } },
    },
  });
  const side = (row: { id: string; lastName: string }): { lastName: string } => ({
    lastName: row.id === playerId ? DELETED_PLAYER_TITLE_RU : row.lastName,
  });

  for (const duel of duels) {
    const title = duelSubject({
      id: duel.id,
      kind: duel.kind,
      author: side(duel.author),
      opponent: duel.opponent === null ? null : side(duel.opponent),
    }).name.slice(0, TOPIC_TITLE_MAX);

    await tx.forumTopic.updateMany({
      where: { subjectType: 'DUEL', subjectId: duel.id },
      data: { title },
    });
  }
}

/** Адреса картинок сообщения форума: `images` — JSON `[{url, width, height}]`. */
function imageUrlsOf(images: Prisma.JsonValue): string[] {
  if (!Array.isArray(images)) return [];

  return images.flatMap((image) =>
    typeof image === 'object' &&
    image !== null &&
    !Array.isArray(image) &&
    typeof image.url === 'string'
      ? [image.url]
      : [],
  );
}
