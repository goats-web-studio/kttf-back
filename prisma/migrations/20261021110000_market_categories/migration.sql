-- Готовые ракетки и сумки — скрытые категории RTTF «Наборы, ракетки» и «Сумки» (ADR-058)
ALTER TYPE "ProductCategory" ADD VALUE 'RACKET' AFTER 'RUBBER';
ALTER TYPE "ProductCategory" ADD VALUE 'BAG' AFTER 'CASE';
