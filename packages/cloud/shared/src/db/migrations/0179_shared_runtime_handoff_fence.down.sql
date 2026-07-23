DROP INDEX IF EXISTS "shared_runtime_history_handoff_fence_expiry_idx";
--> statement-breakpoint
ALTER TABLE "shared_runtime_history"
	DROP CONSTRAINT IF EXISTS "shared_runtime_history_handoff_fence_shape_check",
	DROP COLUMN IF EXISTS "handoff_fence_expires_at",
	DROP COLUMN IF EXISTS "handoff_fence_token";
