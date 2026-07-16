-- Databases that missed the one-time infrastructure transition must stop for
-- operator review instead of carrying oversized capacity into the
-- autoscaler. Already-migrated databases retain their existing journal cursor.

DO $$
BEGIN
  IF to_regclass('public.docker_nodes') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM docker_nodes
      WHERE enabled = true
        AND capacity > 8
        AND created_at < TIMESTAMPTZ '2026-05-22 00:00:00+00'
    ) THEN
      RAISE EXCEPTION
        'migration 0132: pre-autoscaler nodes require explicit operator review';
    END IF;
  END IF;
END $$;
