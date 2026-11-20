// The credential scanner's rules: a file that holds a credential in ANY format is closed (high
// recall on purpose), while the notes Alef must be able to quote stay open.

import { describe, expect, it } from "vitest";
import {
  denyRuleForPath,
  excludedDenyRules,
  fileKind,
  foldText,
  isSecretShaped,
  isUnscannedPath,
  pathKey,
  scanName,
  scanText,
  spokenToDigits,
  unscannedDenyRules,
} from "../features/credential-scan-lib.js";
import { CLOSED_SPOKEN, redactSpoken } from "../features/voice-brain-recall-lib.js";
import { HOLDOUT_R3, HOLDOUT_R3_OPEN, REVIEW2_MISSES } from "./credential-fixtures.js";

const note = (text: string): string[] => scanText(text, "/v/note.md").reasons;
const code = (text: string, path = "/r/app.ts"): string[] => scanText(text, path).reasons;

describe("the formats sentence redaction missed are closed at the source", () => {
  it.each([
    "Gate 3344",
    "The alarm is 5566.",
    "purplewalrus is the gym password.",
    "| Service | Login | Pass |\n|---|---|---|\n| Netflix | steph | purplewalrus |",
    // spelled out, split, said in words
    "Lisbon flat door code: 4, then 8, then 2, then 1.",
    "The flat code starts with 48 and ends with 21.",
    "Door code? Easy. It's four eight two one.",
    "Punch in 4821 at the building door.",
    // a password manager's master code
    "PasswordManager master code: correct horse battery staple",
    "The master code is correct horse battery staple.",
    "The PasswordManager master code is Xy7-mm2-Qq9. Keep it safe.",
  ])("%s", (t) => {
    expect(note(t)).not.toEqual([]);
  });

  it("names the reason class, never the value", () => {
    const r = scanText("PasswordManager master code: correct horse battery staple", "/v/x.md");
    expect(r.reasons).toEqual(["password-manager"]);
    expect(r.values).toEqual([]); // values only when asked for
    expect(scanText("Gate 3344", "/v/x.md").reasons).toEqual(["access-code"]);
    expect(scanText("| Service | Login | Pass |\n|---|---|---|\n| Netflix | steph | purplewalrus |", "/v/x.md").reasons).toEqual(["credential-table"]);
  });

  it("collects values on request (in memory, for the spoken filter)", () => {
    const r = scanText("The door code for the Lisbon flat is 4821. Gym password is purplewalrus. Code: four eight two one", "/v/x.md", { collectValues: true });
    expect(r.values).toEqual(expect.arrayContaining(["4821", "purplewalrus"]));
    expect(r.values).not.toContain("Lisbon");
  });
});

describe("every format the older suites held", () => {
  it.each([
    "VIEWER_PASSWORD: hunter2",
    "Her PIN: 4821.",
    "The wifi password is correct-horse-battery!",
    "Recovery codes are 8f3a-22b1 and 9c1d-7e4f.",
    "mot de passe : Paris2026",
    "The door code for the Lisbon flat is 4821. The concierge is Samir.",
    "Gate code: 1990#",
    "Alarm code 5566, then press OK.",
    "The safe combination is 12-34-56.",
    "Samir's code is 4821.",
    "Entry code 7731 works after 22:00.",
    "Bank card PIN 7394.",
    "Home Wi-Fi network HomeNet, password SunnyDay2024",
    "passphrase: purple 42 walrus",
    "pw: hunter22",
    "mdp : soleil",
    "wifi: SunnyDay",
    "login: alex / Xy7!abcd",
    "Password\nXy7!abcd",
    "| VIEWER_PASSWORD | Xy7!abcd |",
    "| Site | User | Password |\n|---|---|---|\n| Bank portal | alex | Xy7!Canary |",
    "| Place | Code |\n|---|---|\n| Front door | 4821 |",
    "The PIN is 12.34.56.78 now.",
    "4821 is the code for the Lisbon flat.",
    "Your Lisbon flat note contains the number 4821, which is your door code.",
    "Xy7!abcd, that's the password for the NAS.",
    "Credentials: admin / sesame",
    "secret: sesame",
    "Netflix: user@mail.com / sesame",
    "Old NAS: steph / purplewalrus",
    "Digicode: 5930B",
    "code porte : 4821",
    "Recovery phrase: abandon ability able about above absent absorb abstract absurd abuse access accident",
    "Visa 4111 1111 1111 1111 exp 09/28 CVV 737",
    "Mastercard 5555555555554444",
    "PUK: 12345678",
    "Password for Netflix - purplewalrus",
    "Le code de la porte est 4821",
    "| Account | Credentials |\n|---|---|\n| Netflix | steph / sesame |",
    "## Passwords\n\n- Netflix: purplewalrus\n- Gym: 4821",
    "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    "DB_PASSWORD=Xy7mmQq9zz",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
  ])("%s", (t) => {
    expect(note(t)).not.toEqual([]);
  });
});

/** Phrasings the PR #38 review found open (value in the note → the value the spoken filter needs).
 *  Every one closes its file, and its value is collected for the reply guard. */
const REVIEW_MISSES: ReadonlyArray<readonly [string, string]> = [
  // a lowercase pin, or "Pin" without a colon
  ["The bank app pin is 7394", "7394"],
  ["Pin is 7394", "7394"],
  ["My pin for the office alarm panel is 2580.", "2580"],
  ["Bank app pin: 7394", "7394"],
  // two 2-digit groups
  ["Gate code: 33 44", "3344"],
  ["The gate code is 33 44.", "3344"],
  ["Gate code 33 44", "3344"],
  ["Door code: 48-21", "4821"],
  // "to", "set to", parentheses, no separator at all
  ["I changed the gym password to purplewalrus", "purplewalrus"],
  ["Gym password set to purplewalrus.", "purplewalrus"],
  ["The gym password is now purplewalrus.", "purplewalrus"],
  ["Home Wi-Fi password purplewalrus", "purplewalrus"],
  ["Gym password (purplewalrus)", "purplewalrus"],
  ["WPA2 key: purplewalrus", "purplewalrus"],
  // letters after the digits, French labels
  ["Digicode 4821B", "4821"],
  ["Alarme : 5566", "5566"],
  ["Coffre-fort : 5566", "5566"],
  ["Cadenas du vélo : 4821", "4821"],
  ["Cadenas du vélo : quatre huit deux un", "4821"],
  ["Coffre-fort : cinq cinq six six", "5566"],
  ["Clé wifi : purplewalrus", "purplewalrus"],
  ["Mot de passe du wifi : purplewalrus", "purplewalrus"],
  ["Le code du portail est 3344", "3344"],
  ["Code alarme : 5566", "5566"],
  ["Code de la porte : quatre huit deux un", "4821"],
  ["Le code secret de la carte : sept trois neuf quatre", "7394"],
  ["Alarme : cinq cinq six six", "5566"],
  ["Code du portail : trente-trois quarante-quatre", "3344"],
  // German, Spanish, Portuguese, Italian
  ["Passwort: purplewalrus", "purplewalrus"],
  ["Das WLAN-Passwort ist purplewalrus", "purplewalrus"],
  ["Der Türcode ist 4821", "4821"],
  ["Contraseña: purplewalrus", "purplewalrus"],
  ["Mi contraseña es purplewalrus", "purplewalrus"],
  ["Código de la puerta: 4821", "4821"],
  ["Senha: purplewalrus", "purplewalrus"],
  ["A senha do wifi é purplewalrus", "purplewalrus"],
  ["Código do portão: 3344", "3344"],
  ["Codice del cancello: 3344", "3344"],
  ["La password è purplewalrus", "purplewalrus"],
  // Arabic, Arabic-Indic digits, fullwidth digits
  ["كلمة السر: purplewalrus", "purplewalrus"],
  ["كلمة المرور هي purplewalrus", "purplewalrus"],
  ["رمز البوابة 3344", "3344"],
  ["رمز البوابة ٣٣٤٤", "3344"],
  ["الرقم السري ٧٣٩٤", "7394"],
  ["Gate code: ３３４４", "3344"],
  ["ＰＩＮ： ７３９４", "7394"],
];

describe("every phrasing the review found open is closed, in any language (multilingual regression fixture)", () => {
  it.each(REVIEW_MISSES)("%s", (t, value) => {
    const r = scanText(t, "/v/note.md", { collectValues: true });
    expect(r.reasons, t).not.toEqual([]);
    expect(r.values, t).toContain(value); // the reply guard withholds a sentence that repeats it
  });

  it("the same phrasings inside a longer note still close it", () => {
    const body = `# Lake house\n\nThe lake house is in Faqra. The caretaker is Georges.\n\n${REVIEW_MISSES.map(([t]) => t).join("\n\n")}\n`;
    for (const [t] of REVIEW_MISSES) expect(note(`# Notes\n\nSome context first.\n\n${t}\n\nMore context after.\n`), t).not.toEqual([]);
    expect(note(body)).not.toEqual([]);
  });

  it("numbers said in French become digits too (runs of two words or more)", () => {
    expect(spokenToDigits("quatre huit deux un")).toBe("4821");
    expect(spokenToDigits("trente-trois quarante-quatre")).toBe("3344");
    expect(spokenToDigits("quarante-huit vingt et un")).toBe("4821");
    expect(spokenToDigits("soixante-dix-sept quatre-vingt-dix-neuf")).toBe("7799");
    expect(spokenToDigits("cinq cinq six six")).toBe("5566");
    expect(spokenToDigits("un chat")).toBe("un chat"); // a lone "un" is an article
    expect(spokenToDigits("born Sept 2025")).toBe("born Sept 2025");
  });
});


describe("round 2: a credential in a phrasing nobody listed still closes its file (fresh multilingual fixture)", () => {
  it.each(REVIEW2_MISSES)("%s", (t, reply) => {
    const r = scanText(`# Note\n\nSome context first.\n\n${t}\n\nMore context after.\n`, "/v/note.md", { collectValues: true });
    expect(r.reasons, t).not.toEqual([]);
    expect(redactSpoken(reply, r.values), `${t} → ${reply}`).toBe(CLOSED_SPOKEN); // the value reaches the reply guard
  });

  it("a password manager's own code, however it is labelled (the shape of an old Notion wiki page)", () => {
    const r = scanText("# To start\n\nEverything is there. With PasswordManager, you have access to my whole life - code: ***Walnut7, Rivers***\n", "/v/To start.md", { collectValues: true });
    expect(r.reasons).toEqual(["password-manager"]);
    expect(r.values).toEqual(expect.arrayContaining(["Walnut7", "Rivers"]));
    expect(redactSpoken("It is Walnut7, Rivers.", r.values)).toBe(CLOSED_SPOKEN);
  });

  it("numbers said in Arabic words become digits; a zero-width space or spaced letters hide no word", () => {
    expect(spokenToDigits("رمز الباب أربعة ثمانية اثنان واحد")).toBe("رمز الباب 4821");
    expect(spokenToDigits("ثلاثة وثلاثة وأربعة وأربعة")).toBe("3344");
    expect(spokenToDigits("48 hundred and 21")).toBe("4821");
    expect(spokenToDigits("واحد")).toBe("واحد"); // a lone word is a word
    expect(foldText("pass​word")).toBe("password");
    expect(foldText("P A S S W O R D: x")).toBe("PASSWORD: x");
    expect(foldText("I O U")).toBe("I O U"); // three letters are initials, not a word spelled out
  });
});

describe("round 2 hold-out sets (written after the rules, measured, then kept as regressions)", () => {
  /** Said only in one- and two-digit pieces: the file closes, but no single value repeats in a reply. */
  const PIECES = new Set(["Front door keypad code starts with 48, ends with 21", "Safe combination: left 22, right 8, left 15"]);
  it.each(HOLDOUT_R3)("%s", (t, value) => {
    const r = scanText(`# Note\n\n${t}\n`, "/v/note.md", { collectValues: true });
    expect(r.reasons, t).not.toEqual([]);
    if (!PIECES.has(t)) expect(redactSpoken(`It is ${value}.`, r.values), t).toBe(CLOSED_SPOKEN);
  });
  it.each(HOLDOUT_R3_OPEN)("stays open: %s", (t) => {
    expect(note(t)).toEqual([]);
  });
});

describe("notes Alef must quote stay open", () => {
  it.each([
    // The sentence the old spoken filter destroyed: a secret SCAN and two port numbers.
    "The resident learned that secret scans need rtk proxy and that the live Alef servers on ports 5178 and 5179 must never be restarted.",
    "The password is stored in PasswordManager.",
    "Secrets (JWT_SECRET, HEARTBEAT_PHRASE, VIEWER_PASSWORD) go to PasswordManager; values redacted.",
    "⚠⚠ **Never write a secret VALUE into memory** — Open: the **PasswordManager master code** is plaintext in the old Notion wiki (2 pages) and in vault git history; rotation is the only fix.",
    "**⚠⚠ Security — OPEN, confirmed 2026-09-21.** The PasswordManager **master code** sits in plaintext in the old wiki.",
    "⚠⚠ **Secret scans lie through RTK**: pre-push greps must use `rtk proxy` — a plain scan printed clean over a real key (✅ 2026-09-24).",
    "Gallery is PUBLIC (no password since the 2026-09-12 gate removal).",
    "Land first (June 2026), publish second; biography is the credential.",
    "Victor Rizkallah joined ACME as Growth Engineer.",
    "Pin the artifact to the sidebar.",
    "Claude Code 2.1.283 shipped on 2026-09-28.",
    "The code review on 2026-09-28 found 4 bugs.",
    "Run pwd to see the folder.",
    "The password is wrong.",
    "The Wi-Fi password is on the fridge.",
    "Postal code 1050 Brussels.",
    "Stack: Next.js / Tailwind",
    "Routing: OpenRouter: x-ai / grok-4.6.",
    "The API key lives in ~/.config/brain-server/.env (chmod 600), never in the vault.",
    "Order 4111 1111 1111 1112 shipped.",
    "The code for TICK-1889 is merged.",
    "| Test | Result |\n|---|---|\n| login | pass |",
    "| Check | Pass |\n|---|---|\n| build | ✅ |",
    "Password manager - see PasswordManager",
    "The front door is 3 m wide.",
    "Password changed in 2025. Maya was born in September 2025.",
    "The password is required for all new users.",
    "The access code is sent by SMS to the phone.",
    "Tunnel `alef` (UUID `3f2a9c1e-0b7d-4e21-9a55-1c2b3d4e5f60`) credentials at `~/.cloudflared/3f2a9c1e-0b7d-4e21-9a55-1c2b3d4e5f60.json`.",
    "A phone Claude Code session, 2026-09-21 — not on the Mac.",
    "The API key quota is 1000 requests per day.",
    // figures of speech, QA notes, statutes and doc placeholders (measured false positives)
    "The legal tech industry has a dirty secret: most implementations fail.",
    "Final pass: 99/99 checks + reactivate.",
    "9. **First pass: extract.** Read the whole document.",
    "| **California** | VOID | Non-compete void except in narrow business sale context. Cal. Bus. & Prof. Code 16600. |",
    "3. **OPENAI_API_KEY** — prompt for your key when you run setup (or skip and add later)",
    'echo "OPENROUTER_API_KEY=sk-or-..." >> .env   # key from openrouter.ai/keys',
    'export HCLOUD_API_TOKEN="xxxx-xxxx-xxxx-xxxx"',
    "## API keys\n\n```js\nconst browser = await chromium.launch({ slowMo: 50 });\n```",
    // the wider rules (lowercase pin, "to", parentheses, bare values, pairs, other languages) keep these open
    "Pin it to the top of the board.",
    "I pinned the artifact.",
    "Pin 2 on the ESP32 board drives the LED.",
    "Changed the password to something stronger.",
    "Reset the password to the default, then log in.",
    "Password (see PasswordManager).",
    "Wi-Fi password (optional)",
    "My password expires.",
    "The Wi-Fi password works fine now.",
    "API key usage is billed per request.",
    "Set the API key (OpenAI) in the env file.",
    "The front door is 80-90 cm wide.",
    "Alarm set for 07:30 tomorrow.",
    "La porte est ouverte.",
    "Le code de la route a changé en 2024.",
    "Mot de passe oublié ? Cliquez sur le lien.",
    "La palabra clave es marketing.",
    "Das Passwort ist falsch.",
    "Il y a deux ou trois portes.",
    "كلمة السر مطلوبة",
    "The meeting is at gate 12.",
    // measured false positives of a first cut of those rules, on the real ~/Documents/Code
    "  --tilt-pin: -1.2deg;",
    "  --shadow-pin: 0 2px 4px var(--shadow-paper-deep);",
    "`spark action pin 19733` came back \"action not applicable\".",
    "Spark refused to pin 19733 (\"action not applicable\").",
    "Pega un documento legal y extrae información clave: fechas, montos, partes y términos.",
    "- Password hashing",
    "- Optional password protection",
    "INPUT: email (string), password (string)",
    "- Secure credential storage",
    "Refers to the Application Default Credentials (ADC) for authentication.",
    "sudo passwd ubuntu",
    "You can reset your password to regain access to your account.",
    "[[50-Archives/rss-feeds/2026-04-20-show-hn-open-security-key-on-esp32-with-nfc|show hn open security key on esp32...]]",
    "Define done as a hard stop: gate before any code (checklist).",
    "| Password (owner) | Final signed documents, prevent editing |",
    "- Forgot password flows",
    "- In password mode, onboarding also supports plaintext storage.",
    // measured false positives of a first cut of the round-2 rules on the real vault and code
    // folders (invented look-alikes): quantities, prices, models, links, code, figures of speech
    "PasswordManager stores the master code; see the Groot note.",
    "PasswordManager's new feature: passkeys everywhere.",
    "- **Discord as the lobby OS:** 200M+ MAUs, 90% gaming usage.",
    "Bucket A safe $735K (incl $400K Portugal), Bucket B risk-liquid $60K.",
    "The deal would unlock $100B+ in frozen assets.",
    "Aqara U400 review: the smart lock has arrived.",
    "title: 9 Best Smart Locks (2026) for Front Doors",
    "- **Blockers to disarm:** CISO (SOC 2 II, ISO 27001, AES-256/TLS 1.3)",
    "Build runs check-i18n-parity (key-parity gate, ~1200 keys).",
    "- **De-gated:** /dev password gates deleted (open, unlisted: robots disallow + server noindex).",
    "Never share your secret keys in chat, add them via ExampleVendor’s “Secrets” feature.",
    "In a moment of trust, he stores all his passwords on Leila’s phone via PasswordManager.",
    "- `$(pwd)` — the project to publish",
    "Stale locks cleaned (only the live `41234.lock` remains).",
    "**Related:** [[10-Sessions/meetings/2024-12-17-intercom-x-examplevendor-ai-2552|intercom x examplevendor ai 2552]]",
    "![](https://img.example.com/x.jpg?format=jpg&crop=4000,2250,x0,y0,safe&width=1200)",
    "California made progress via SB 1047 (the Safe and Secure Innovation Act).",
    "**Done (v3, full browser /qa PASS on live):** 40 threads, 12 decisions.",
    "Are we going to pass? It's really towards the teams.",
    "  const [password, setPassword] = useState(\"\");",
    "const browser = await pw.firefox.launch();",
    "Along with 3000+ browsers and devices combinations to test.",
    "Grand Games reached $1bn weeks after CVC’s $2.5B deal for Dream Games.",
    "For instance, a simple login form with only username and password fields.",
    "The app should support the following user journey: 1. Authentication",
    "key = \"user:{0}\".format(user_id)",
    "Introducing Advanced Account Security: Passkey login, stronger recovery.",
    "Il codice civile, articolo 1453.",
    "La clave del éxito es la constancia.",
    "The wifi is called HomeNet.",
    "Unlock 5000 credits with the Pro plan.",
    "Gate 12 at Lisbon airport, boarding at 14:30.",
  ])("%s", (t) => {
    expect(note(t)).toEqual([]);
  });

  it("a web page's scripts are read as code, its text as prose", () => {
    expect(scanText('<html><script>var o={show_password:!0,e:"x"};function f(a){return a.password:!1}</script><p>Welcome</p></html>', "/v/page.html").reasons).toEqual([]);
    expect(scanText("<html><script>var x=1;</script><p>The gym password is purplewalrus.</p></html>", "/v/page.html").reasons).toEqual(["password"]);
  });
});

describe("code and config files: hardcoded secrets only", () => {
  it("closes literals, token shapes, env lines and key blocks", () => {
    expect(code('const password = "Xy7!abcd9";')).toEqual(["password"]);
    expect(code('apiKey: "abc123xyz"')).toEqual(["api-token"]);
    expect(code('{ "db_password": "hunter22" }', "/r/config.json")).toEqual(["password"]);
    expect(code("DB_PASSWORD=Xy7mmQq9zz", "/r/deploy.sh")).toEqual(["env-secret"]);
    expect(code("  password: Xy7mmQq9zz", "/r/app.yml")).toEqual(["env-secret"]);
    expect(code('const k = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";')).toEqual(["api-token"]);
  });
  it("leaves types, references, placeholders and UI labels alone", () => {
    for (const t of [
      "password: string;",
      "const password = req.body.password;",
      '"passwordLabel": "Password"',
      "API_KEY = os.environ['API_KEY']",
      'JWT_SECRET: "dev-secret-change-me"',
      'maxTokens: "1000"',
      'type: "password"',
      "token: z.string()",
      'autoComplete="current-password"',
    ])
      expect(code(t), t).toEqual([]);
    expect(code("OPENAI_API_KEY=your-key-here", "/r/deploy.sh")).toEqual([]);
    expect(code('{ "dependencies": { "@auth/core": "^0.34.2", "jsonwebtoken": "^9.0.2", "passport-local": "1.0.0" } }', "/r/package.json")).toEqual([]);
    expect(code('token_url: "https://oauth.example.org/token"', "/r/app.yml")).toEqual([]);
  });
  it("reads a minified long line around its anchors", () => {
    const min = `${"x".repeat(5000)}{"stripe_secret":"EXAMPLE-FAKE-0"}${"y".repeat(5000)}`;
    expect(code(min, "/r/bundle.json")).not.toEqual([]);
  });
});

describe("long transcript-style lines", () => {
  it("windows around anchors still see a credential deep inside", () => {
    const line = `${"lorem ipsum ".repeat(800)} the gym password is purplewalrus ${"dolor sit ".repeat(800)}`;
    expect(note(line)).toEqual(["password"]);
    expect(note(`${"lorem ipsum ".repeat(800)} secret scans on ports 5178 and 5179 ${"dolor ".repeat(800)}`)).toEqual([]);
  });
});

describe("file names and kinds", () => {
  it("a short name that says credentials, or a recovery document, closes a file", () => {
    expect(scanName("/v/Passwords.md")).toEqual(["credential-name"]);
    expect(scanName("/v/Wifi password 1a2b3c4d5e6f.md")).toEqual(["credential-name"]);
    expect(scanName("/v/PasswordManager Emergency Kit.pdf")).toEqual(["credential-name"]);
    expect(scanName("/v/2026-07-16-passwordmanager-lets-claude-log-you-into-websites-without-ever-seeing-your-passwords.md")).toEqual([]);
    expect(scanName("/v/notes.md")).toEqual([]);
  });
  it("kinds: prose, code, binary", () => {
    expect(fileKind("/v/a.md")).toBe("prose");
    expect(fileKind("/v/Makefile")).toBe("prose");
    expect(fileKind("/r/a.ts")).toBe("code");
    expect(fileKind("/r/a.PDF")).toBe("binary");
  });
  it("secret-shaped tokens exclude ids, versions, amounts and names", () => {
    for (const t of ["Xy7!abcd", "hunter22", "SunnyDay2024", "Tr0ub4dor&3", "1990#"]) expect(isSecretShaped(t), t).toBe(true);
    for (const t of ["grok-4.6", "claude-3-5-sonnet", "$10K", "MAX_TOKENS=0", "3f2a9c1e-0b7d-4e21-9a55-1c2b3d4e5f60", "sha256", "v2.1.283", "TICK-1889", "#38", "~/.ssh/id_rsa"]) expect(isSecretShaped(t), t).toBe(false);
  });
  it("numbers said in words become digits", () => {
    expect(spokenToDigits("Four eight two one.")).toBe("4821.");
    expect(spokenToDigits("It's forty-eight twenty-one, sir")).toBe("It's 4821, sir");
    expect(spokenToDigits("four thousand eight hundred and twenty-one")).toBe("4821");
    expect(spokenToDigits("double five six six")).toBe("5566");
    expect(spokenToDigits("one of them")).toBe("one of them");
  });
});

describe("deep mode rules for closed files and skipped folders", () => {
  it("one Read rule per closed file; glob and rule characters become single-character wildcards", () => {
    expect(denyRuleForPath("/Users/t/vault/notes/flat.md")).toBe("Read(//Users/t/vault/notes/flat.md)");
    expect(denyRuleForPath("/Users/t/vault/Notion wiki (old)/Family [draft]*.md")).toBe("Read(//Users/t/vault/Notion wiki ?old?/Family ?draft??.md)");
    const rules = excludedDenyRules(["/Users/t/vault/Café.md"]);
    expect(rules).toHaveLength(2); // NFC and NFD
    expect(rules.every((r) => /^Read\(\/\/Users\/t\/vault\/Caf/.test(r))).toBe(true);
  });
  it("skipped folders and raw transcripts are refused by class", () => {
    const rules = unscannedDenyRules();
    for (const r of ["Read(//**/node_modules/**)", "Read(//**/node_modules.nosync/**)", "Read(//**/.next/**)", "Read(//**/*.jsonl)", "Read(//**/.trash/**)"]) expect(rules).toContain(r);
    expect(isUnscannedPath("/Users/t/Documents/Code/app/node_modules/x/README.md")).toBe(true);
    expect(isUnscannedPath("/Users/t/Documents/Code/app/data/session.jsonl")).toBe(true);
    expect(isUnscannedPath("/Users/t/Documents/Code/app/src/build.ts")).toBe(false);
    expect(isUnscannedPath("/Users/t/Documents/Code/app/README.md")).toBe(false);
  });
  it("paths compare case- and Unicode-insensitively", () => {
    expect(pathKey("/Users/T/Vault/Café.md")).toBe(pathKey("/users/t/vault/CAFÉ.md"));
  });
});
