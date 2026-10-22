// Types shared by room turn dispatch and its private coordinator guard.
import type { RoomRoundLine } from "./room-jobs.ts";

export type GroupTurnOperation = {
  id: string;
  threadId: string;
  botIds: Set<string>;
  cancelled: boolean;
  cancellation: AbortController;
  providerHandshakePending: boolean;
  queuedQueueIds?: string[];
  line?: RoomRoundLine;
  goalRun?: {
    runId: string;
    cardMessageId: string;
    goal: string;
    coordinatorBotId: string;
    coordinatorName: string;
    turnCount: number;
    maxTurns: number;
    startedAt: number;
    finished: boolean;
  };
};

export type GroupGoalCoordinatorTurn = {
  token: symbol;
  turnId?: string;
  assistantItems: string[];
  /** A timed-out provider may still emit: keep swallowing until its real completion arrives. */
  discard: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};
