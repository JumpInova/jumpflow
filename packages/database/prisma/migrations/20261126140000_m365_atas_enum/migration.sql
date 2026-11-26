-- Microsoft 365 (M2) — parte 1/2: SÓ os novos valores de enum.
--
-- Migration própria porque o Postgres não permite USAR um valor de enum
-- recém-adicionado na mesma transação em que foi criado (padrão de
-- 20261126130000_m365_provider_enum). Aditivo e idempotente. Os dois eventos são
-- só in-app (avisos ao gestor), sem regra de e-mail.

ALTER TYPE "NotificationEvent" ADD VALUE IF NOT EXISTS 'CHECKPOINT_MINUTES_READY';
ALTER TYPE "NotificationEvent" ADD VALUE IF NOT EXISTS 'CHECKPOINT_MINUTES_CHOICE';
