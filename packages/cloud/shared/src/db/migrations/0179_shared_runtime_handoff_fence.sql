ALTER TABLE "shared_runtime_history"
	ADD COLUMN "handoff_fence_token" uuid,
	ADD COLUMN "handoff_fence_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "shared_runtime_history"
	ADD CONSTRAINT "shared_runtime_history_handoff_fence_shape_check"
	CHECK (
		("handoff_fence_token" IS NULL AND "handoff_fence_expires_at" IS NULL)
		OR
		("handoff_fence_token" IS NOT NULL AND "handoff_fence_expires_at" IS NOT NULL)
	);
--> statement-breakpoint
CREATE INDEX "shared_runtime_history_handoff_fence_expiry_idx"
	ON "shared_runtime_history" USING btree ("handoff_fence_expires_at");
