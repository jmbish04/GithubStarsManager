/**
 * Colby Maestro through its service binding (default entrypoint).
 *
 * A Worker cannot fetch another Worker's workers.dev hostname on the same
 * account (Cloudflare error 1042), so every call goes through `env.MAESTRO.fetch`
 * with WORKER_API_KEY as the bearer. The hostname in the URL is never dialed.
 */
import { requireSecret } from "./secrets";

export class MaestroError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(env: Env, method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
  const key = await requireSecret(env, "WORKER_API_KEY");
  const response = await env.MAESTRO.fetch(new Request(`https://colby-maestro.internal${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await response.text();
  if (!response.ok) throw new MaestroError(`colby-maestro ${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`, response.status);
  return JSON.parse(text) as T;
}

export interface MaestroProject {
  project_key: string;
  repo_path: string;
  repo_full_name: string;
  name: string;
  open_task_count: number;
  updated_at: string;
}

export interface MaestroPlanSummary {
  id: string;
  project_key: string;
  repo_path: string;
  title: string;
  updated_at: string;
  superseded_by_plan_id?: string;
}

export interface MaestroPlanSection {
  id: string;
  title: string;
  heading_level: number;
  body_markdown: string;
}

export interface MaestroPlan extends MaestroPlanSummary {
  markdown: string;
  sections: MaestroPlanSection[];
}

export async function listProjects(env: Env): Promise<MaestroProject[]> {
  const result = await call<{ projects?: MaestroProject[] } | MaestroProject[]>(env, "GET", "/api/projects");
  return Array.isArray(result) ? result : (result.projects ?? []);
}

/** Current (not superseded) plans for a project. */
export async function listPlans(env: Env, projectKey: string): Promise<MaestroPlanSummary[]> {
  const result = await call<{ plans: MaestroPlanSummary[] }>(env, "GET", `/api/plans?project_key=${encodeURIComponent(projectKey)}`);
  return (result.plans ?? []).filter((plan) => !plan.superseded_by_plan_id);
}

export async function getPlan(env: Env, planId: string): Promise<MaestroPlan> {
  const result = await call<{ plan: MaestroPlan }>(env, "GET", `/api/plans/${encodeURIComponent(planId)}`);
  return result.plan;
}

export async function createPlan(env: Env, input: { projectKey: string; repoPath: string; title: string; markdown: string }): Promise<MaestroPlan> {
  const result = await call<{ plan: MaestroPlan }>(env, "POST", "/api/plans", {
    project_key: input.projectKey,
    repo_path: input.repoPath,
    title: input.title,
    author: "github-stars-manager",
    markdown: input.markdown,
  });
  return result.plan;
}

export interface MaestroTaskInput {
  projectKey: string;
  repoPath: string;
  title: string;
  description: string;
  taskType: "epic" | "task" | "spike";
  priority: "high" | "medium" | "low";
  planId: string;
  sectionIds: string[];
  parentTaskId?: string;
  tags: string[];
}

export async function createTask(env: Env, input: MaestroTaskInput): Promise<{ task_id: string }> {
  const result = await call<{ task?: { task_id: string }; task_id?: string }>(env, "POST", "/api/tasks", {
    project_key: input.projectKey,
    repo_path: input.repoPath,
    title: input.title,
    description: input.description,
    status: "backlog",
    priority: input.priority,
    task_type: input.taskType,
    plan_id: input.planId,
    section_ids: input.sectionIds,
    parent_task_id: input.parentTaskId,
    tags: input.tags,
  });
  const taskId = result.task?.task_id ?? result.task_id;
  if (!taskId) throw new MaestroError("colby-maestro created a task but returned no task_id", 502);
  return { task_id: taskId };
}

export async function ping(env: Env): Promise<number> {
  const response = await env.MAESTRO.fetch(new Request("https://colby-maestro.internal/api/ping"));
  return response.status;
}
