export interface GraftQueryOptions {
  repo: string;
  cache: string;
  identity: { organizationId: string; workspaceId: string; runId: string; generation: number; baseSha: string };
  tool: unknown;
  packageRoot?: URL;
}
export function query(options: GraftQueryOptions): Promise<string>;
export function boundedResult(value: { result: unknown; [key: string]: unknown }): string;
