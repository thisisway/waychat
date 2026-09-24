CREATE TABLE "contact_opt_outs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"keyword" text NOT NULL,
	"opted_out_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opted_in_at" timestamp with time zone,
	CONSTRAINT "contact_opt_outs_uq" UNIQUE("account_id","contact_id","channel")
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"provider_template_id" text,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"category" text DEFAULT 'UTILITY' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_templates_inbox_name_lang_uq" UNIQUE("inbox_id","name","language"),
	CONSTRAINT "message_templates_status_ck" CHECK ("message_templates"."status" in ('pending', 'approved', 'rejected', 'paused', 'disabled', 'other'))
);
--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_uploader_ck";--> statement-breakpoint
ALTER TABLE "inboxes" DROP CONSTRAINT "inboxes_channel_type_ck";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_status_ck";--> statement-breakpoint
ALTER TABLE "inbound_events" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN "quality_rating" text;--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN "messaging_tier" text;--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN "quality_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_opt_outs" ADD CONSTRAINT "contact_opt_outs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_opt_outs" ADD CONSTRAINT "contact_opt_outs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_ck" CHECK ("attachments"."uploader_type" in ('user', 'visitor', 'contact'));--> statement-breakpoint
ALTER TABLE "inboxes" ADD CONSTRAINT "inboxes_channel_type_ck" CHECK ("inboxes"."channel_type" in ('api', 'widget', 'whatsapp'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_status_ck" CHECK ("messages"."status" in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed'));