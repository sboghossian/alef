// Wire types for the "todos" feature (A3): each agent's latest todo list, parsed from
// TodoWrite (full list) or TaskCreate/TaskUpdate (incremental) tool calls in its jsonl.

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string; // sanitized, ≤120 chars
  status: TodoStatus;
  activeForm: string | null; // "Running the tests" style label for the in-progress item
}

export interface TodoList {
  agentId: string;
  items: TodoItem[]; // ≤30, in the order the agent wrote them
  updatedAt: string; // ISO of the tool call that produced this version
}

/** snapshot extras key "todos.lists": agentId → list (only agents that ever wrote one). */
export type TodosExtras = Record<string, TodoList>;

/** WS payload: one list changed (an empty items array means the agent cleared it). */
export interface TodosMessage {
  kind: "update";
  lists: TodoList[];
}

export function todoProgress(list: TodoList): { done: number; total: number; current: TodoItem | null } {
  const done = list.items.filter((i) => i.status === "completed").length;
  const current = list.items.find((i) => i.status === "in_progress") ?? null;
  return { done, total: list.items.length, current };
}
