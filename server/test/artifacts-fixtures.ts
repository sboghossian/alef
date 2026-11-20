// Transcript lines for the artifacts tests: an Artifact publish (call, frame-link, result).

export const S1 = "11111111-1111-4111-8111-111111111111";
export const S2 = "22222222-2222-4222-8222-222222222222";
export const URL_A = "https://claude.ai/artifact/Ab3dEf5h7K9mNp2QrStUvW";
export const UUID_A = "f2c9bc03-a9f0-4ff6-868d-4a60eacd89a7";

/** An assistant line with one Artifact tool_use. */
export function artifactCall(id: string, input: Record<string, unknown>, at: string): string {
  return JSON.stringify({ type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "tool_use", id, name: "Artifact", input }] } });
}

/** The user line answering it. `result` = toolUseResult (omit it for the text-only fallback). */
export function artifactResult(id: string, text: string, at: string, result?: Record<string, unknown>, isError = false): string {
  return JSON.stringify({
    type: "user",
    timestamp: at,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }] },
    ...(result ? { toolUseResult: result } : {}),
  });
}

export function publishLines(id: string, at: string, title: string, path: string, url = URL_A): string[] {
  return [
    artifactCall(id, { file_path: path, title }, at),
    JSON.stringify({ type: "frame-link", sessionId: S1, path, frameUrl: url, title, artifactCount: 1, timestamp: at }),
    artifactResult(id, `Published ${path} at ${url} (Version 1)`, at, { url, path, title, artifact_id: UUID_A, updated: false }),
  ];
}

