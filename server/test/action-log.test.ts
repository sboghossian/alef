import { describe, expect, it } from "vitest";
import { CLIENT_CLOSED, describeAction, REASON_MAX, ROUTE_MAX, routeOf, shouldLogRequest } from "../action-log.js";

const base = { method: "POST", path: "/api/dispatch", durationMs: 12 };

describe("shouldLogRequest", () => {
  it("logs writes and skips reads", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "post", "OPTIONS"]) expect(shouldLogRequest(m)).toBe(true);
    for (const m of ["GET", "HEAD", "get", undefined]) expect(shouldLogRequest(m)).toBe(false);
  });
});

describe("describeAction", () => {
  it("formats an ok action as info with the exact contract fields", () => {
    const line = describeAction({ ...base, status: 200, outcome: { ok: true, error: null } });
    expect(line.level).toBe("info");
    expect(line.message).toBe("POST /api/dispatch → 200 in 12ms");
    expect(line.fields).toEqual({ kind: "action", method: "POST", route: "/api/dispatch", status: 200, ok: true, reason: null, durationMs: 12 });
  });

  it("warns on a 4xx and carries the body's error as the reason", () => {
    const line = describeAction({ ...base, path: "/api/reactivate/not-a-uuid", status: 400, outcome: { ok: false, error: "invalid agent id" } });
    expect(line.level).toBe("warn");
    expect(line.message).toBe("POST /api/reactivate/not-a-uuid → 400 in 12ms: invalid agent id");
    expect(line.fields).toMatchObject({ status: 400, ok: false, reason: "invalid agent id" });
  });

  it("warns on a 200 whose body says ok:false", () => {
    const line = describeAction({ ...base, status: 200, outcome: { ok: false, error: "nothing to do" } });
    expect(line.level).toBe("warn");
    expect(line.fields.ok).toBe(false);
  });

  it("is an error on a 5xx, and on status 0 (the client hung up) with its own reason", () => {
    expect(describeAction({ ...base, status: 500, outcome: { ok: false, error: "Error: boom" } }).level).toBe("error");
    expect(describeAction({ ...base, status: 503, outcome: undefined }).level).toBe("error");
    const closed = describeAction({ ...base, status: 0, outcome: undefined });
    expect(closed.level).toBe("error");
    expect(closed.fields).toMatchObject({ status: 0, ok: false, reason: CLIENT_CLOSED });
    expect(closed.message).toBe(`POST /api/dispatch → 0 in 12ms: ${CLIENT_CLOSED}`);
  });

  it("treats a response with no recorded body as ok when the status is", () => {
    expect(describeAction({ ...base, status: 204, outcome: undefined })).toMatchObject({ level: "info", fields: { ok: true, reason: null } });
  });

  it("strips the query and fragment from the route, and caps it", () => {
    expect(describeAction({ ...base, path: "/api/talk/x/send?token=secret#frag", status: 200, outcome: undefined }).fields.route).toBe("/api/talk/x/send");
    expect(routeOf("/a#b?c")).toBe("/a");
    expect(routeOf("?only=query")).toBe("/");
    const long = routeOf(`/api/${"x".repeat(400)}?q=1`);
    expect(long.length).toBe(ROUTE_MAX);
    expect(long.endsWith("…")).toBe(true);
  });

  it("keeps only the reason's first line, capped", () => {
    const multi = describeAction({ ...base, status: 500, outcome: { ok: false, error: "Error: Command failed: osascript\nexecution error: -1743" } });
    expect(multi.fields.reason).toBe("Error: Command failed: osascript");
    const long = describeAction({ ...base, status: 500, outcome: { ok: false, error: "e".repeat(1000) } });
    expect(long.fields.reason?.length).toBe(REASON_MAX);
    expect(describeAction({ ...base, status: 400, outcome: { ok: false, error: "  \n  " } }).fields.reason).toBeNull();
  });

  it("rounds the duration to a non-negative integer", () => {
    expect(describeAction({ ...base, durationMs: 3.6, status: 200, outcome: undefined }).fields.durationMs).toBe(4);
    expect(describeAction({ ...base, durationMs: -2, status: 200, outcome: undefined }).fields.durationMs).toBe(0);
  });
});
