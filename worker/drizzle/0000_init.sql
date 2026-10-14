CREATE TYPE "public"."leverage_mode" AS ENUM('idea', 'service', 'dependency', 'fork', 'none');--> statement-breakpoint
CREATE TYPE "public"."repo_source" AS ENUM('star_sync', 'discovery', 'research', 'manual');--> statement-breakpoint
CREATE TYPE "public"."research_kind" AS ENUM('consultation', 'leverage', 'maestro_auto');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('cron', 'manual', 'api', 'mcp');--> statement-breakpoint
CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text DEFAULT 'folder' NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"color" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_custom" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" bigint NOT NULL,
	"run_id" uuid NOT NULL,
	"profile_id" uuid,
	"score" real DEFAULT 0 NOT NULL,
	"reason" text,
	"matched_query" text,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"starred_via_app_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "discovery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" "run_trigger" NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"queries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"candidates_seen" integer DEFAULT 0 NOT NULL,
	"items_added" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "interest_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"min_stars" integer DEFAULT 100 NOT NULL,
	"freshness_days" integer DEFAULT 30 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maestro_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"project_key" text NOT NULL,
	"plan_id" text,
	"epic_task_id" text,
	"task_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maestro_project_scans" (
	"project_key" text PRIMARY KEY NOT NULL,
	"last_run_id" uuid,
	"plan_hash" text,
	"last_scanned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" bigint PRIMARY KEY NOT NULL,
	"repo_id" bigint NOT NULL,
	"tag_name" text NOT NULL,
	"name" text,
	"body" text,
	"html_url" text,
	"published_at" timestamp with time zone,
	"prerelease" boolean DEFAULT false NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"assets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" bigint PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"name" text NOT NULL,
	"owner_login" text NOT NULL,
	"owner_avatar_url" text,
	"description" text,
	"html_url" text NOT NULL,
	"homepage" text,
	"language" text,
	"topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"license" text,
	"stargazers_count" integer DEFAULT 0 NOT NULL,
	"forks_count" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"gh_created_at" timestamp with time zone,
	"gh_pushed_at" timestamp with time zone,
	"readme_excerpt" text,
	"content_hash" text,
	"embedding" vector(384),
	"embedded_at" timestamp with time zone,
	"search_text" text DEFAULT '' NOT NULL,
	"is_starred" boolean DEFAULT false NOT NULL,
	"starred_at" timestamp with time zone,
	"unstarred_at" timestamp with time zone,
	"ai_summary" text,
	"ai_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"custom_description" text,
	"custom_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"category_id" text,
	"first_seen_source" "repo_source" NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"name" text NOT NULL,
	"angle" text NOT NULL,
	"queries" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"candidates_found" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "research_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"repo_id" bigint NOT NULL,
	"agent_id" uuid,
	"similarity" real,
	"relevance" real,
	"rationale" text,
	"leverage_mode" "leverage_mode",
	"leverage" jsonb,
	"selected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "research_kind" NOT NULL,
	"trigger" "run_trigger" NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"criterion" text NOT NULL,
	"criterion_hash" text NOT NULL,
	"target_repo" text,
	"target_infrastructure" text,
	"min_stars" integer DEFAULT 500 NOT NULL,
	"parent_run_id" uuid,
	"maestro_project_key" text,
	"maestro_plan_id" text,
	"maestro_task_id" text,
	"workflow_instance_id" text,
	"plan" jsonb,
	"report_markdown" text,
	"llm_calls" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovery_items" ADD CONSTRAINT "discovery_items_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_items" ADD CONSTRAINT "discovery_items_run_id_discovery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_items" ADD CONSTRAINT "discovery_items_profile_id_interest_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."interest_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maestro_exports" ADD CONSTRAINT "maestro_exports_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maestro_project_scans" ADD CONSTRAINT "maestro_project_scans_last_run_id_research_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."research_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_agents" ADD CONSTRAINT "research_agents_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_agent_id_research_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."research_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_parent_run_id_research_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."research_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_items_repo_uq" ON "discovery_items" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "discovery_items_unread_idx" ON "discovery_items" USING btree ("score") WHERE "discovery_items"."read_at" is null;--> statement-breakpoint
CREATE INDEX "discovery_items_run_idx" ON "discovery_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "discovery_runs_started_idx" ON "discovery_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "maestro_exports_run_idx" ON "maestro_exports" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "releases_repo_published_idx" ON "releases" USING btree ("repo_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_full_name_uq" ON "repositories" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "repositories_starred_idx" ON "repositories" USING btree ("starred_at") WHERE "repositories"."is_starred";--> statement-breakpoint
CREATE INDEX "repositories_stars_idx" ON "repositories" USING btree ("stargazers_count");--> statement-breakpoint
CREATE INDEX "repositories_category_idx" ON "repositories" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "research_agents_run_idx" ON "research_agents" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_findings_run_repo_uq" ON "research_findings" USING btree ("run_id","repo_id");--> statement-breakpoint
CREATE INDEX "research_findings_repo_idx" ON "research_findings" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "research_runs_hash_idx" ON "research_runs" USING btree ("criterion_hash","created_at");--> statement-breakpoint
CREATE INDEX "research_runs_maestro_idx" ON "research_runs" USING btree ("maestro_project_key","created_at");--> statement-breakpoint
CREATE INDEX "research_runs_status_idx" ON "research_runs" USING btree ("status","created_at");