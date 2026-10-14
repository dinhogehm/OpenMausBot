import type { Admission } from "./admission";
import type { ExecutionRoom } from "./run-room";
import type { RunRecord } from "./execution";

export interface AppEnv {
  DB: D1Database;
  ASSETS?: Fetcher;
  RUNS: DurableObjectNamespace<ExecutionRoom>;
  ADMISSION: DurableObjectNamespace<Admission>;
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
