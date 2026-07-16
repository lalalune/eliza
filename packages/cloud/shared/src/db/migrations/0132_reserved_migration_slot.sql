-- This timestamped slot remains registered so deployed databases retain their
-- migration cursor. Its one-time infrastructure cleanup is not part of the
-- schema required by new installations.

SELECT 1;
