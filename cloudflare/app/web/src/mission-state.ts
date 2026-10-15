import type { MissionRecord } from "../../src/mission-types";
export type VisibleMission = MissionRecord & { canPause?: boolean; canResume?: boolean; canCancel?: boolean };
export function mergeMissions(current: VisibleMission[], incoming: VisibleMission[], organizationId: string, workspaceId: string): VisibleMission[] {
  if (incoming.some(mission => mission.organizationId !== organizationId || mission.workspaceId !== workspaceId)) throw new Error("mission_scope_changed");
  const values = new Map(current.map(mission => [mission.missionId, mission]));
  for (const mission of incoming) if (!values.has(mission.missionId) || values.get(mission.missionId)!.version <= mission.version) values.set(mission.missionId, mission);
  return [...values.values()].sort((a, b) => b.createdAt - a.createdAt);
}
export const missionNeedsRefresh = (mission: VisibleMission) => mission.nextWakeAt !== undefined && !["completed", "failed", "canceled", "awaiting_delivery", "interrupted"].includes(mission.status);
export function safeMissionPr(value: string | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" && url.host === "github.com" && !url.username && !url.password && !url.search && !url.hash && /^\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(url.pathname) ? url.href : null; } catch { return null; }
}
