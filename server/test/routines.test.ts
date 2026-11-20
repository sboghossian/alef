import { describe, expect, it } from "vitest";
import { extractRoutineFields, formatSchedule, parseLaunchctlList, parsePlistXml } from "../features/routines-lib.js";

const SAMPLE_DAILY = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.stephane.artifact-ritual</string>
	<key>ProgramArguments</key>
	<array>
		<string>/opt/homebrew/bin/bash</string>
		<string>/Users/alex/script.sh</string>
	</array>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>8</integer>
		<key>Minute</key>
		<integer>0</integer>
	</dict>
	<key>StandardOutPath</key>
	<string>/Users/alex/Library/Logs/com.stephane.artifact-ritual.out.log</string>
	<key>StandardErrorPath</key>
	<string>/Users/alex/Library/Logs/com.stephane.artifact-ritual.err.log</string>
</dict>
</plist>`;

const SAMPLE_INTERVAL = `<?xml version="1.0"?>
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.stephane.brain-sync</string>
	<key>Program</key>
	<string>/usr/local/bin/sync.sh</string>
	<key>StartInterval</key>
	<integer>900</integer>
</dict>
</plist>`;

const SAMPLE_WEEKDAYS = `<plist><dict>
<key>Label</key><string>com.stephane.weekday-report</string>
<key>StartCalendarInterval</key>
<array>
  <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
  <dict><key>Weekday</key><integer>2</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
  <dict><key>Weekday</key><integer>3</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
  <dict><key>Weekday</key><integer>4</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
  <dict><key>Weekday</key><integer>5</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
</array>
</dict></plist>`;

describe("parsePlistXml", () => {
  it("parses a dict with a string, a nested array of strings, and a nested dict of integers", () => {
    const parsed = parsePlistXml(SAMPLE_DAILY);
    const fields = extractRoutineFields(parsed);
    expect(fields.label).toBe("com.stephane.artifact-ritual");
    expect(fields.program).toBe("/opt/homebrew/bin/bash");
    expect(fields.startCalendarIntervals).toEqual([{ hour: 8, minute: 0 }]);
    expect(fields.standardOutPath).toContain("artifact-ritual.out.log");
  });

  it("parses StartInterval and falls back to Program when there's no ProgramArguments", () => {
    const fields = extractRoutineFields(parsePlistXml(SAMPLE_INTERVAL));
    expect(fields.label).toBe("com.stephane.brain-sync");
    expect(fields.program).toBe("/usr/local/bin/sync.sh");
    expect(fields.startInterval).toBe(900);
    expect(fields.startCalendarIntervals).toBeNull();
  });

  it("parses an array of StartCalendarInterval dicts (weekdays)", () => {
    const fields = extractRoutineFields(parsePlistXml(SAMPLE_WEEKDAYS));
    expect(fields.startCalendarIntervals).toHaveLength(5);
    expect(fields.startCalendarIntervals?.[0]).toEqual({ weekday: 1, hour: 9, minute: 30 });
  });

  it("does not throw on malformed XML — returns best-effort fields", () => {
    expect(() => extractRoutineFields(parsePlistXml("<plist><dict><key>Label</key>"))).not.toThrow();
  });
});

describe("formatSchedule", () => {
  const now = new Date("2026-09-24T10:00:00"); // a Thursday

  it("formats a single daily calendar entry and computes next run (today, still ahead)", () => {
    const fields = extractRoutineFields(parsePlistXml(SAMPLE_DAILY));
    const s = formatSchedule(fields, new Date("2026-09-24T06:00:00"));
    expect(s.text).toBe("daily 08:00");
    expect(s.kind).toBe("calendar");
    expect(new Date(s.nextRunAt!).getHours()).toBe(8);
  });

  const fieldsFor = (entries: object[]): ReturnType<typeof extractRoutineFields> => ({
    label: "x", program: null, startInterval: null, standardOutPath: null, standardErrorPath: null,
    startCalendarIntervals: entries,
  });

  it("honours Day (day of month): monthly on the 1st, next run is Oct 1 not tomorrow (ig-innovation)", () => {
    const s = formatSchedule(fieldsFor([{ day: 1, hour: 19, minute: 0 }]), now);
    expect(s.text).toBe("monthly on the 1st 19:00");
    const next = new Date(s.nextRunAt!);
    expect([next.getMonth(), next.getDate(), next.getHours()]).toEqual([9, 1, 19]);
  });

  it("Day + Month is yearly; a missing Hour means hourly", () => {
    const y = formatSchedule(fieldsFor([{ month: 2, day: 29, hour: 9, minute: 0 }]), now);
    expect(y.text).toBe("every Feb 29 09:00");
    expect(new Date(y.nextRunAt!).getFullYear()).toBe(2028);
    const h = formatSchedule(fieldsFor([{ minute: 15 }]), now);
    expect(h.text).toBe("hourly at :15");
    expect(new Date(h.nextRunAt!).getTime()).toBe(new Date("2026-09-24T10:15:00").getTime());
  });

  it("Day and Weekday together fire on either (cron/launchd rule)", () => {
    const s = formatSchedule(fieldsFor([{ day: 30, weekday: 5, hour: 9, minute: 0 }]), now); // Fri 25th comes first
    expect(new Date(s.nextRunAt!).getDate()).toBe(25);
  });

  it("rolls over to tomorrow when today's time has passed", () => {
    const fields = extractRoutineFields(parsePlistXml(SAMPLE_DAILY));
    const s = formatSchedule(fields, now); // 10:00, past 08:00
    const next = new Date(s.nextRunAt!);
    expect(next.getDate()).toBe(now.getDate() + 1);
    expect(next.getHours()).toBe(8);
  });

  it("formats an interval schedule in minutes", () => {
    const fields = extractRoutineFields(parsePlistXml(SAMPLE_INTERVAL));
    const s = formatSchedule(fields, now);
    expect(s).toEqual({ kind: "interval", text: "every 15 min", nextRunAt: new Date(now.getTime() + 900_000).toISOString() });
  });

  it("collapses five same-time weekday entries into 'weekdays HH:MM'", () => {
    const fields = extractRoutineFields(parsePlistXml(SAMPLE_WEEKDAYS));
    const s = formatSchedule(fields, now);
    expect(s.text).toBe("weekdays 09:30");
  });

  it("falls back to 'manual / unknown' with no schedule fields at all", () => {
    const s = formatSchedule(extractRoutineFields(null), now);
    expect(s).toEqual({ kind: "unknown", text: "manual / unknown", nextRunAt: null });
  });
});

describe("parseLaunchctlList", () => {
  it("parses PID/status/label rows, treating '-' as unset", () => {
    const text = "PID\tStatus\tLabel\n1234\t0\tcom.stephane.artifact-ritual\n-\t78\tcom.stephane.broken\n-\t-\tcom.stephane.never-run\n";
    const map = parseLaunchctlList(text);
    expect(map.get("com.stephane.artifact-ritual")).toEqual({ pid: 1234, lastExitStatus: 0 });
    expect(map.get("com.stephane.broken")).toEqual({ pid: null, lastExitStatus: 78 });
    expect(map.get("com.stephane.never-run")).toEqual({ pid: null, lastExitStatus: null });
  });

  it("ignores the header and blank/short lines", () => {
    const map = parseLaunchctlList("PID\tStatus\tLabel\n\n1\t2\n");
    expect(map.size).toBe(0);
  });
});
