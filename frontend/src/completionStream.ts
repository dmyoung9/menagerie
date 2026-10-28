export async function streamCompletion(
  model: string,
  prompt: string,
  signal: AbortSignal,
  append: (text: string) => void,
) {
  const response = await fetch('/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      max_tokens: 128,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    let detail = text;
    try {
      const data = JSON.parse(text);
      detail = data.error?.message || data.detail || text;
    } catch {
      /* Keep a non-JSON upstream error. */
    }
    throw new Error(`Request failed (${response.status}): ${detail}`);
  }
  if (!response.body)
    throw new Error('The gateway returned no response stream.');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let pending = '',
    received = false,
    done = false;
  const event = (block: string) => {
    const payload = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!payload) return;
    if (payload.trim() === '[DONE]') {
      done = true;
      return;
    }
    const data = JSON.parse(payload);
    if (data.error) throw new Error(data.error.message || String(data.error));
    const text = data.choices?.[0]?.delta?.content;
    if (typeof text === 'string' && text) {
      received = true;
      append(text);
    }
  };
  try {
    while (!done) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      // Normalize CRLF only after complete lines have arrived, including split chunks.
      pending = pending.replaceAll('\r\n', '\n');
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        event(pending.slice(0, end));
        pending = pending.slice(end + 2);
        if (done) break;
      }
      if (chunk.done) {
        if (pending.trim()) event(pending);
        break;
      }
    }
    if (!done)
      throw new Error(
        'The response stream ended unexpectedly. Retry or inspect deployment logs.',
      );
    if (!received)
      throw new Error(
        'The model returned no text. Inspect deployment logs and model configuration.',
      );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
