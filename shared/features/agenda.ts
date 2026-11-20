// Types for the "agenda" feature: GET /api/agenda -> today's Calendar.app events (JXA).
// Lazy + cached server-side (5 min); never called at boot.

export interface AgendaEvent {
  title: string;
  start: string; // ISO
  end: string; // ISO
}

export interface AgendaNext {
  title: string;
  start: string; // ISO
  inMinutes: number;
}

export interface AgendaResult {
  ok: boolean;
  today: AgendaEvent[];
  next: AgendaNext | null;
  /** True when the calendar permission looks denied (client shows a friendly hint instead of retrying). */
  permissionDenied?: boolean;
  error?: string;
}
