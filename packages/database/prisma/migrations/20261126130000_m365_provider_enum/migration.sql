-- Microsoft 365 (M1) — parte 1/2: SÓ o novo valor de enum.
--
-- Migration própria porque o Postgres não permite USAR um valor de enum
-- recém-adicionado na mesma transação em que foi criado (padrão de
-- 20261027115900_fluxo_horas_enum_values). Aditivo e idempotente.

ALTER TYPE "IntegrationProviderKind" ADD VALUE IF NOT EXISTS 'MICROSOFT_365';
