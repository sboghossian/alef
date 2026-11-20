// Contract for GET /api/replay?date=YYYY-MM-DD — a time-ordered activity feed for one
// past day (built from session jsonl lines, capped + sampled) plus a daily report card.

import type { ActivityStage } from "../types.js";

export interface ReplayEvent {
  id: string;
  agentId: string;
  islandId: string;
  at: string; // ISO
  stage: ActivityStage;
  toolName: string | null;
  targetObjectId: string | null;
  summary: string;
}

export interface DailyReportRow {
  name: string;
  count: number;
}

export interface DailyReportCity {
  islandId: string;
  name: string;
  events: number;
  sessions: number;
}

/** Real numbers only — no $ figures (not a registered metric here). */
export interface DailyReport {
  date: string;
  sessions: number;
  tokens: number;
  events: number; // total events that day, before capping/sampling
  perCity: DailyReportCity[];
  topFiles: DailyReportRow[];
  topTools: DailyReportRow[];
  topSkills: DailyReportRow[];
}

export interface ReplayResponse {
  ok: true;
  date: string;
  events: ReplayEvent[]; // time-ordered, capped + sampled
  truncated: boolean;
  report: DailyReport;
}

export interface ReplayError {
  ok: false;
  error: string;
}
