// privacy-guard.ts: which paths count as inside a folder macOS privacy controls guard. Pure path
// logic; nothing here touches the filesystem, so no real TCC folder is ever opened.

import { describe, expect, it } from "vitest";
import { isPrivacyGuarded } from "../privacy-guard.js";

const HOME = "/Users/me";

describe("isPrivacyGuarded", () => {
  it("covers Desktop, Downloads, Library, media folders and /Volumes, and what is inside them", () => {
    for (const p of ["/Users/me/Desktop", "/Users/me/Desktop/x/y", "/Users/me/Downloads/a", "/Users/me/Library/Mobile Documents/x", "/Users/me/Library/Containers/app/Data", "/Users/me/Movies", "/Users/me/Music/a", "/Users/me/Pictures", "/Volumes", "/Volumes/usb/repo"]) {
      expect(isPrivacyGuarded(p, HOME, "darwin"), p).toBe(true);
    }
  });

  it("leaves home itself, ~/Documents, dot-folders, look-alike names and other roots alone", () => {
    for (const p of ["/Users/me", "/Users/me/Documents/Code/agent-world", "/Users/me/.acme-worktrees/tick-1", "/Users/me/DesktopApps", "/Users/me/Downloads-old", "/Users/other/Desktop", "/Volumesx", "/tmp/x", "/"]) {
      expect(isPrivacyGuarded(p, HOME, "darwin"), p).toBe(false);
    }
  });

  it("on darwin ignores letter case, in the path and in home (APFS is case-insensitive by default)", () => {
    for (const p of ["/Users/me/desktop", "/Users/me/DOWNLOADS/x", "/users/ME/Library/Containers", "/volumes/USB"]) {
      expect(isPrivacyGuarded(p, HOME, "darwin"), p).toBe(true);
    }
    expect(isPrivacyGuarded("/Users/me/Desktop/x", "/USERS/Me", "darwin")).toBe(true);
    expect(isPrivacyGuarded("/Users/me/documents", HOME, "darwin")).toBe(false);
  });

  it("treats the data volume's spelling of a folder (/System/Volumes/Data/...) as the same folder", () => {
    for (const p of ["/System/Volumes/Data/Users/me/Desktop", "/System/Volumes/Data/Users/me/Downloads/x", "/system/volumes/data/users/me/pictures", "/System/Volumes/Data/Volumes/usb"]) {
      expect(isPrivacyGuarded(p, HOME, "darwin"), p).toBe(true);
    }
    expect(isPrivacyGuarded("/Users/me/Desktop", "/System/Volumes/Data/Users/me", "darwin")).toBe(true);
    expect(isPrivacyGuarded("/System/Volumes/Data/Users/me/Documents", HOME, "darwin")).toBe(false);
    expect(isPrivacyGuarded("/System/Volumes/Data", HOME, "darwin")).toBe(false);
  });

  it("compares case-sensitively off darwin", () => {
    expect(isPrivacyGuarded("/home/me/Desktop/x", "/home/me", "linux")).toBe(true);
    expect(isPrivacyGuarded("/home/me/desktop/x", "/home/me", "linux")).toBe(false);
  });

  it("resolves relative segments before comparing", () => {
    expect(isPrivacyGuarded("/Users/me/Documents/../Desktop/x", HOME, "darwin")).toBe(true);
    expect(isPrivacyGuarded("/Users/me/Desktop/../Documents", HOME, "darwin")).toBe(false);
  });
});
