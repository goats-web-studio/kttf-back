-- Время снятия — порядок технических побед, ADR-077. Только добавляет.
ALTER TABLE "Registration" ADD COLUMN "withdrawnAt" TIMESTAMP(3);
