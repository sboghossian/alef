import { afterEach, describe, expect, it } from "vitest";
import { createAgendaFeature, isPermissionDenied, parseAgenda } from "../features/agenda.js";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

describe("isPermissionDenied", () => {
  it("recognizes macOS TCC denial shapes", () => {
    expect(isPermissionDenied("execution error: Not authorized to send Apple events (-1743)")).toBe(true);
    expect(isPermissionDenied("Not allowed to access Calendar")).toBe(true);
    expect(isPermissionDenied("some other error")).toBe(false);
  });
});

describe("parseAgenda", () => {
  const now = new Date("2026-09-24T12:00:00.000Z");

  it("parses today's events and finds the next upcoming one", () => {
    const raw = JSON.stringify({
      ok: true,
      events: [
        { title: "Standup", start: "2026-09-24T09:00:00.000Z", end: "2026-09-24T09:15:00.000Z" },
        { title: "1:1 with Sam", start: "2026-09-24T13:00:00.000Z", end: "2026-09-24T13:30:00.000Z" },
      ],
    });
    const result = parseAgenda(raw, now);
    expect(result.ok).toBe(true);
    expect(result.today).toHaveLength(2);
    expect(result.next).toEqual({ title: "1:1 with Sam", start: "2026-09-24T13:00:00.000Z", inMinutes: 60 });
  });

  it("returns next: null when nothing is left today", () => {
    const raw = JSON.stringify({ ok: true, events: [{ title: "Standup", start: "2026-09-24T09:00:00.000Z", end: "2026-09-24T09:15:00.000Z" }] });
    expect(parseAgenda(raw, now).next).toBeNull();
  });

  it("surfaces a permission-denied error", () => {
    const raw = JSON.stringify({ ok: false, error: "Not authorized to send Apple events (-1743)" });
    const result = parseAgenda(raw, now);
    expect(result.ok).toBe(false);
    expect(result.permissionDenied).toBe(true);
  });

  it("degrades on non-JSON output instead of throwing", () => {
    const result = parseAgenda("not json at all", now);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("non-JSON");
  });
});

describe("GET /api/agenda", () => {
  let server: RunningServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("returns the runner's parsed result and caches it for 5 minutes", async () => {
    let calls = 0;
    const feature = createAgendaFeature(async () => {
      calls++;
      return JSON.stringify({ ok: true, events: [{ title: "Standup", start: "2026-01-01T09:00:00.000Z", end: "2026-01-01T09:15:00.000Z" }] });
    });
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature] } });
    server = s;

    const first = await fetch(`${base}/api/agenda`);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { today: unknown[] };
    expect(firstBody.today).toHaveLength(1);

    const second = await fetch(`${base}/api/agenda`);
    expect(second.status).toBe(200);
    expect(calls).toBe(1); // second call served from cache, runner not invoked again
  });

  it("502s and reports permissionDenied when the runner throws a TCC-denial error", async () => {
    const feature = createAgendaFeature(async () => {
      throw new Error("execution error: Not authorized to send Apple events (-1743)");
    });
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [feature] } });
    server = s;

    const res = await fetch(`${base}/api/agenda`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; permissionDenied?: boolean };
    expect(body.ok).toBe(false);
    expect(body.permissionDenied).toBe(true);
  });
});
