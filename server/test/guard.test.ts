import { describe, expect, it } from "vitest";
import { checkRequest } from "../guard.js";

const base = { method: "GET", host: "localhost:5179", origin: undefined, contentType: undefined };

describe("checkRequest", () => {
  it("allows the local UI and same-machine tools", () => {
    expect(checkRequest(base)).toBeNull();
    expect(checkRequest({ ...base, host: "127.0.0.1:5179", origin: "http://localhost:5178" })).toBeNull();
    expect(checkRequest({ ...base, method: "POST", contentType: "application/json; charset=utf-8", origin: "http://127.0.0.1:5178" })).toBeNull();
  });
  it("blocks DNS rebinding (non-loopback Host)", () => {
    expect(checkRequest({ ...base, host: "evil.example:5179" })?.status).toBe(403);
    expect(checkRequest({ ...base, host: undefined })?.status).toBe(403);
  });
  it("blocks cross-site origins", () => {
    expect(checkRequest({ ...base, origin: "https://evil.example" })?.status).toBe(403);
    expect(checkRequest({ ...base, origin: "http://localhost.evil.example" })?.status).toBe(403);
  });
  it("blocks simple-request writes (text/plain, form) that skip CORS preflight", () => {
    expect(checkRequest({ ...base, method: "POST", contentType: "text/plain" })?.status).toBe(415);
    expect(checkRequest({ ...base, method: "POST", contentType: "application/x-www-form-urlencoded" })?.status).toBe(415);
    expect(checkRequest({ ...base, method: "POST", contentType: undefined })?.status).toBe(415);
  });
  it("blocks cross-site GETs with no Origin (an <img> on any page), allows same-origin and curl", () => {
    expect(checkRequest({ ...base, origin: undefined, fetchSite: "cross-site" })?.status).toBe(403);
    expect(checkRequest({ ...base, origin: undefined, fetchSite: "same-origin" })).toBeNull();
    expect(checkRequest({ ...base, origin: undefined, fetchSite: undefined })).toBeNull();
  });
});
