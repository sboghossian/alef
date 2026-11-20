import { describe, expect, it } from "vitest";
import type { DailyReport } from "../../../shared/features/replay";
import {
  CONFIRM_TTL_MS,
  IDLE,
  inboxAnswer,
  parseIntent,
  resolveAgent,
  stepConfirm,
  todayAnswer,
  unknownAnswer,
  type ConfirmState,
  type VisibleApproval,
} from "./voice-intents";

const CITIES = ["agent-world", "acme-ai-next", "yalla-brief"];

describe("parseIntent", () => {
  it.each([
    ["Who's waiting on me?", "inbox"],
    ["hey alef, who is waiting on me", "inbox"],
    ["open my inbox", "inbox"],
    ["What happened today?", "today"],
    ["give me today's numbers", "today"],
    ["daily report please", "today"],
    ["play Claude FM", "music"],
    ["pause the music", "music"],
    ["stop", "stop"],
    ["be quiet", "stop"],
    ["Wa2ef!", "stop"],
    ["wa'ef", "stop"],
    ["Hey Alef, arrête.", "stop"],
    ["what can you do", "help"],
    ["confirm", "confirm"],
    ["Yes, confirm.", "confirm"],
    ["cancel", "cancel"],
    ["approve", "approve"],
    ["approve it", "approve"],
    ["deny that", "deny"],
    ["open automations", "automations"],
  ])("%s → %s", (text, kind) => {
    expect(parseIntent(text, CITIES).kind).toBe(kind);
  });

  it("finds sessions about a topic (Ask Jev + notes)", () => {
    expect(parseIntent("find the session about the pricing page")).toEqual({ kind: "find", query: "the pricing page" });
    expect(parseIntent("who worked on the billboard?")).toEqual({ kind: "find", query: "the billboard" });
    expect(parseIntent("search for stripe webhooks")).toEqual({ kind: "find", query: "stripe webhooks" });
  });

  it("focus on an agent", () => {
    expect(parseIntent("focus on yalla brief")).toEqual({ kind: "focus", agentQuery: "yalla brief" });
  });

  it("opens known views, rejects unknown ones", () => {
    expect(parseIntent("open the board")).toEqual({ kind: "open-view", viewId: "board" });
    expect(parseIntent("show me the brain view")).toEqual({ kind: "open-view", viewId: "brain" });
    expect(parseIntent("go to orbit")).toEqual({ kind: "open-view", viewId: "orbit" });
    expect(parseIntent("open the pod bay doors").kind).toBe("unknown");
  });

  it("dispatch with a colon, city matched against known cities", () => {
    expect(parseIntent("dispatch to agent-world: fix the compass", CITIES)).toEqual({ kind: "dispatch", city: "agent-world", prompt: "fix the compass" });
    expect(parseIntent("dispatch to nowhere: do it", CITIES)).toEqual({ kind: "dispatch", city: null, prompt: "do it" });
  });

  it("dispatch via the existing voice routing (build/tell)", () => {
    const i = parseIntent("tell yalla-brief to add a weather block", CITIES);
    expect(i).toEqual({ kind: "dispatch", city: "yalla-brief", prompt: "add a weather block" });
  });

  it("an approve + confirm in ONE utterance is not an approval", () => {
    expect(parseIntent("approve and confirm").kind).toBe("unknown");
    expect(parseIntent("confirm approve").kind).toBe("unknown");
    expect(parseIntent("don't confirm").kind).toBe("unknown");
  });

  it("unknown stays unknown (no silent fallback)", () => {
    expect(parseIntent("order me a pizza")).toEqual({ kind: "unknown", text: "order me a pizza" });
    expect(parseIntent("   ").kind).toBe("unknown");
  });
});

describe("resolveAgent", () => {
  const agents = [
    { id: "a1", title: "Fix compass", islandId: "agent-world", lastActive: "2026-09-25T08:00:00Z" },
    { id: "a2", title: "Morning brief", islandId: "yalla-brief", lastActive: "2026-09-25T09:00:00Z" },
    { id: "a3", title: "Compass redesign", islandId: "agent-world", lastActive: "2026-09-25T10:00:00Z" },
  ];
  it("exact title first, then contains (most recent), then city", () => {
    expect(resolveAgent("fix compass", agents)?.id).toBe("a1");
    expect(resolveAgent("compass", agents)?.id).toBe("a3");
    expect(resolveAgent("yalla-brief", agents)?.id).toBe("a2");
    expect(resolveAgent("the morning brief agent", agents)?.id).toBe("a2");
    expect(resolveAgent("unicorn", agents)).toBeNull();
    expect(resolveAgent("", agents)).toBeNull();
  });
  it("answers to Claude Code's name for the session as well as its first prompt", () => {
    const named = [
      { id: "b1", title: "transcript WhatsApp Ptt 2026-09-23 at 11.59.52.ogg", displayName: "Vibemind", islandId: "alexboghossian", lastActive: "2026-09-25T08:00:00Z" },
      { id: "b2", title: "what are the ideas driven by this caroussel? https://www.instagram.com/p/x", displayName: "Jev Ideas", islandId: "alexboghossian", lastActive: "2026-09-25T09:00:00Z" },
      { id: "b3", title: "Morning brief", displayName: null, islandId: "yalla-brief", lastActive: "2026-09-25T07:00:00Z" },
    ];
    expect(resolveAgent("vibemind", named)?.id).toBe("b1");
    expect(resolveAgent("jev ideas", named)?.id).toBe("b2");
    expect(resolveAgent("caroussel", named)?.id).toBe("b2"); // the old prompt still works as an alias
    expect(resolveAgent("morning brief", named)?.id).toBe("b3");
  });
});

describe("stepConfirm (spoken approval confirmation)", () => {
  const card: VisibleApproval = { id: "ap1", toolName: "Bash", summary: "rm -rf build" };
  const T = 1_000_000;

  it("approve arms and asks for confirm; it never decides", () => {
    const s = stepConfirm(IDLE, { kind: "approve" }, T, card);
    expect(s.state.kind).toBe("armed");
    expect(s.effect.kind).toBe("say");
    expect(s.effect.kind === "say" && s.effect.text).toContain('Say "confirm" to approve Bash: rm -rf build');
  });

  it("confirm after approve decides the SAME approval", () => {
    const armed = stepConfirm(IDLE, { kind: "approve" }, T, card).state;
    const s = stepConfirm(armed, { kind: "confirm" }, T + 1000, card);
    expect(s.effect).toEqual({ kind: "decide", approvalId: "ap1", behavior: "allow", text: "Approved Bash." });
    expect(s.state).toEqual(IDLE);
  });

  it("deny → confirm sends deny", () => {
    const armed = stepConfirm(IDLE, { kind: "deny" }, T, card).state;
    const s = stepConfirm(armed, { kind: "confirm" }, T + 1, card);
    expect(s.effect.kind === "decide" && s.effect.behavior).toBe("deny");
  });

  it("approve with nothing on screen does nothing", () => {
    const s = stepConfirm(IDLE, { kind: "approve" }, T, null);
    expect(s.state).toEqual(IDLE);
    expect(s.effect.kind).toBe("say");
  });

  it("confirm with nothing armed does nothing", () => {
    const s = stepConfirm(IDLE, { kind: "confirm" }, T, card);
    expect(s.effect).toEqual({ kind: "say", text: "There's nothing to confirm." });
  });

  it("confirm after the TTL does nothing", () => {
    const armed = stepConfirm(IDLE, { kind: "approve" }, T, card).state;
    const s = stepConfirm(armed, { kind: "confirm" }, T + CONFIRM_TTL_MS + 1, card);
    expect(s.effect.kind).toBe("say");
    expect(s.state).toEqual(IDLE);
  });

  it("confirm when a DIFFERENT approval is now on screen does nothing", () => {
    const armed = stepConfirm(IDLE, { kind: "approve" }, T, card).state;
    const s = stepConfirm(armed, { kind: "confirm" }, T + 10, { id: "ap2", toolName: "Write", summary: "x" });
    expect(s.effect.kind).toBe("say");
  });

  it("confirm when the approval vanished does nothing", () => {
    const armed = stepConfirm(IDLE, { kind: "approve" }, T, card).state;
    expect(stepConfirm(armed, { kind: "confirm" }, T + 10, null).effect.kind).toBe("say");
  });

  it("cancel disarms; a later confirm does nothing", () => {
    const armed = stepConfirm(IDLE, { kind: "approve" }, T, card).state;
    const c = stepConfirm(armed, { kind: "cancel" }, T + 1, card);
    expect(c.state).toEqual(IDLE);
    expect(stepConfirm(c.state, { kind: "confirm" }, T + 2, card).effect.kind).toBe("say");
  });

  it("any other intent disarms and is passed through", () => {
    const armed: ConfirmState = stepConfirm(IDLE, { kind: "approve" }, T, card).state;
    const s = stepConfirm(armed, { kind: "inbox" }, T + 1, card);
    expect(s.handled).toBe(false);
    expect(s.state).toEqual(IDLE);
    expect(stepConfirm(s.state, { kind: "confirm" }, T + 2, card).effect.kind).toBe("say");
  });
});

describe("answers", () => {
  it("inbox", () => {
    expect(inboxAnswer([])).toBe("Nobody is waiting on you. Inbox zero.");
    expect(inboxAnswer([{ title: "Fix", city: "aw" }])).toBe("One agent is waiting on you: Fix in aw.");
    const four = ["a", "b", "c", "d"].map((t) => ({ title: t, city: "x" }));
    expect(inboxAnswer(four)).toBe("4 agents are waiting on you: a in x, b in x and c in x, plus 1 more.");
  });

  it("today uses only the report's real numbers", () => {
    const r: DailyReport = {
      date: "2026-09-25",
      sessions: 12,
      tokens: 0,
      events: 3400,
      perCity: [
        { islandId: "a", name: "agent-world", events: 1200, sessions: 5 },
        { islandId: "b", name: "yalla-brief", events: 2200, sessions: 7 },
      ],
      topFiles: [],
      topTools: [{ name: "Edit", count: 310 }],
      topSkills: [],
    };
    expect(todayAnswer(r)).toBe("Today: 12 sessions, 3,400 events across 2 cities; busiest was yalla-brief with 2,200 events; top tool Edit, used 310 times.");
    expect(todayAnswer({ ...r, sessions: 0, events: 0, perCity: [] })).toBe("Nothing has happened yet today.");
  });

  it("unknown is honest and offers suggestions", () => {
    expect(unknownAnswer()).toMatch(/^I can't do that yet\. Try: "/);
  });
});
