// A3 — live todo progress. Each agent's latest todo list (TodoWrite, or the newer
// TaskCreate/TaskUpdate tools) from its jsonl, via the shared FleetTracker.
// Snapshot extras "todos.lists"; WS { kind: "update", lists } when a list changes.

import type { TodoList, TodosMessage } from "../../shared/features/todos.js";
import { respondJson } from "../http.js";
import { isValidUuid } from "../reactivate.js";
import { fleetTracker, type FleetTracker } from "./fleet-tracker.js";
import type { FeatureContext, ServerFeature } from "./registry.js";

export function createTodosFeature(tracker: FleetTracker = fleetTracker): ServerFeature {
  const emittedVersion = new Map<string, number>();

  /** Lists whose version moved since we last emitted them. */
  function changedLists(): TodoList[] {
    const out: TodoList[] = [];
    for (const [id, t] of tracker.sessions) {
      if (t.todoVersion === 0 || emittedVersion.get(id) === t.todoVersion) continue;
      emittedVersion.set(id, t.todoVersion);
      const l = tracker.todoList(id);
      if (l) out.push(l);
    }
    return out;
  }

  function emitChanges(ctx: FeatureContext): void {
    const lists = changedLists();
    if (lists.length > 0) ctx.emit({ kind: "update", lists } satisfies TodosMessage);
  }

  function startColdScan(ctx: FeatureContext): void {
    void tracker.ensureColdScan(ctx.config.projectsDir).then(() => emitChanges(ctx));
  }

  return {
    id: "todos",
    routes: [
      {
        // The boot scan covers recent sessions only; the agent panel asks for older ones here.
        method: "GET",
        path: "/api/todos/:agentId",
        async handler(_req, res, ctx, params) {
          const agentId = params.agentId ?? "";
          if (!isValidUuid(agentId)) return respondJson(res, 400, { ok: false, error: "invalid agent id" });
          await tracker.ensureColdScan(ctx.config.projectsDir);
          await tracker.scanSession(ctx.config.projectsDir, agentId);
          emitChanges(ctx);
          respondJson(res, 200, tracker.todoList(agentId) ?? { agentId, items: [], updatedAt: null });
        },
      },
    ],
    async onIndexPass(ctx, batch) {
      await tracker.ensureColdScan(ctx.config.projectsDir);
      tracker.ingestBatch(batch);
      emitChanges(ctx);
    },
    onTick(ctx) {
      startColdScan(ctx);
    },
    snapshotExtras(ctx) {
      startColdScan(ctx);
      const lists: Record<string, TodoList> = {};
      for (const l of tracker.allTodoLists()) lists[l.agentId] = l;
      return { "todos.lists": lists };
    },
  };
}

export const todosFeature = createTodosFeature();
