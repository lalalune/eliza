CREATE TABLE IF NOT EXISTS "shared_runtime_turn_claims" (
	"agent_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"client_message_id" text NOT NULL,
	"assistant_message_id" uuid NOT NULL,
	"owner_text" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"claim_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"assistant_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_runtime_turn_claims_agent_id_channel_id_client_message_id_pk"
		PRIMARY KEY("agent_id","channel_id","client_message_id"),
	CONSTRAINT "shared_runtime_turn_claims_agent_id_agent_sandboxes_id_fk"
		FOREIGN KEY ("agent_id") REFERENCES "public"."agent_sandboxes"("id")
		ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "shared_runtime_turn_claims_client_message_length_check"
		CHECK (length("client_message_id") BETWEEN 1 AND 256),
	CONSTRAINT "shared_runtime_turn_claims_state_check"
		CHECK ("state" IN ('queued', 'processing', 'completed')),
	CONSTRAINT "shared_runtime_turn_claims_state_shape_check"
		CHECK (
			(
				"state" = 'queued'
				AND "claim_token" IS NULL
				AND "lease_expires_at" IS NULL
				AND "assistant_text" IS NULL
			)
			OR
			(
				"state" = 'processing'
				AND "claim_token" IS NOT NULL
				AND "lease_expires_at" IS NOT NULL
				AND "assistant_text" IS NULL
			)
			OR
			(
				"state" = 'completed'
				AND "claim_token" IS NULL
				AND "lease_expires_at" IS NULL
				AND "assistant_text" IS NOT NULL
				AND length(trim("assistant_text")) > 0
			)
		)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shared_runtime_turn_claims_one_processing_idx"
	ON "shared_runtime_turn_claims" USING btree ("agent_id","channel_id")
	WHERE "state" = 'processing';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shared_runtime_turn_claims_queue_idx"
	ON "shared_runtime_turn_claims" USING btree (
		"agent_id","channel_id","state","created_at","client_message_id"
	);
