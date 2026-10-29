/**
 * Reads an SSE body off a fetch Response and yields complete events.
 * Handles both "data: {...}" lines and named events ("event: x" followed by
 * "data: ...", as Anthropic sends).
 */
export async function* sseEvents(
  response: Response,
): AsyncGenerator<{ event: string | null; data: string }> {
  if (!response.body) {
    throw new Error("Response has no body to stream");
  }
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let event: string | null = null;
  let dataLines: string[] = [];

  const flush = function* () {
    if (dataLines.length > 0) {
      const data = dataLines.join("\n");
      dataLines = [];
      const named = event;
      event = null;
      yield { event: named, data };
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        yield* flush();
      } else if (line.startsWith(":")) {
        // comment / keepalive
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
      index = buffer.indexOf("\n");
    }
  }
  yield* flush();
}

/** Throws ProviderError with the API's message when the response is not ok. */
export async function assertOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  let detail = `${response.status} ${response.statusText}`;
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string } | string;
        message?: string;
      };
      if (typeof parsed.error === "string") detail = parsed.error;
      else if (parsed.error?.message) detail = parsed.error.message;
      else if (parsed.message) detail = parsed.message;
    } catch {
      if (text) detail = text.slice(0, 300);
    }
  } catch {
    // keep the status line
  }
  throw new Error(`LLM provider error: ${detail}`);
}
