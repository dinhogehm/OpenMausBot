import type { Admission } from "./admission";
import type { ExecutionRoom } from "./run-room";
import type { RunRecord } from "./execution";
import type { GitHubEnv } from "./github-client";
import type { CodingExecutorStub } from "./coding-types";
import type { CodingRoom } from "./coding-room";
import type { CodingAdmission } from "./coding-admission";
import type { BrowserRoom } from "./browser-room";
import type { BrowserBinding } from "./browser-runtime";

export interface AppEnv extends GitHubEnv {
  DB: D1Database;
  ASSETS?: Fetcher;
  RUNS: DurableObjectNamespace<ExecutionRoom>;
  ADMISSION: DurableObjectNamespace<Admission>;
  CODING_RUNS: DurableObjectNamespace<CodingRoom>;
  CODING_ADMISSION: DurableObjectNamespace<CodingAdmission>;
  BROWSER_RUNS: DurableObjectNamespace<BrowserRoom>;
  BROWSER?: BrowserBinding;
  CODING_EXECUTORS: { getByName(name: string): CodingExecutorStub };
  LINUX_EXECUTORS: { getByName(name: string): {
    execute(input: { runId: string; organizationId: string; workspaceId: string; generation: number; message: string; delayMs: number; deadlineAt: number }): Promise<NonNullable<RunRecord["result"]>>;
    stop(): Promise<void>;
  } };
  APP_ORIGIN: string;
  RELEASE_ID?: string;
  EMAIL_FROM: string;
  AUTH_SECRET: string;
  CREDENTIAL_MASTER_KEY: string;
  EMAIL: { send(message: {
    to: string;
    from: { email: string; name: string };
    subject: string;
    text: string;
    html: string;
  }): Promise<unknown> };
}
