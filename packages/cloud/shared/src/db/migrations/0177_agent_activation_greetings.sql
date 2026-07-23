CREATE TABLE IF NOT EXISTS "agent_activation_greetings" (
	"agent_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"activation_version" text NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" uuid NOT NULL,
	"source" text NOT NULL,
	"greeting_kind" text NOT NULL,
	"text" text NOT NULL,
	"agent_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"projected_at" timestamp with time zone,
	"goal_status" text DEFAULT 'pending' NOT NULL,
	"response_message_id" text,
	"response_text" text,
	"response_created_at" timestamp with time zone,
	"goal_text" text,
	"goal_confidence" double precision,
	"goal_model" text,
	"goal_recorded_at" timestamp with time zone,
	CONSTRAINT "agent_activation_greetings_agent_id_owner_user_id_activation_version_pk"
		PRIMARY KEY("agent_id","owner_user_id","activation_version"),
	CONSTRAINT "agent_activation_greetings_agent_id_agent_sandboxes_id_fk"
		FOREIGN KEY ("agent_id") REFERENCES "public"."agent_sandboxes"("id")
		ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "agent_activation_greetings_owner_user_id_users_id_fk"
		FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id")
		ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "agent_activation_greetings_goal_status_check"
		CHECK ("goal_status" IN ('pending', 'accepted')),
	CONSTRAINT "agent_activation_greetings_response_shape_check"
		CHECK (
			("response_message_id" IS NULL AND "response_text" IS NULL AND "response_created_at" IS NULL)
			OR
			("response_message_id" IS NOT NULL AND "response_text" IS NOT NULL AND "response_created_at" IS NOT NULL)
		),
	CONSTRAINT "agent_activation_greetings_goal_shape_check"
		CHECK (
			(
				"goal_status" = 'pending'
				AND "goal_text" IS NULL
				AND "goal_confidence" IS NULL
				AND "goal_model" IS NULL
				AND "goal_recorded_at" IS NULL
			)
			OR
			(
				"goal_status" = 'accepted'
				AND "response_message_id" IS NOT NULL
				AND "goal_text" IS NOT NULL
				AND length(trim("goal_text")) > 0
				AND "goal_confidence" BETWEEN 0 AND 1
				AND "goal_model" IS NOT NULL
				AND "goal_recorded_at" IS NOT NULL
			)
		)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_activation_greetings_message_id_unique"
	ON "agent_activation_greetings" USING btree ("message_id");
