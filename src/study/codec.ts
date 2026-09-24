/**
 * plan.md §25.4 A2 — the study kit's wire codec: JSON → raw deflate → base64url.
 *
 * Shared by the browser page and `scripts/study.ts`, which is why it uses only
 * the Web platform's own `ReadableStream` / `CompressionStream` / `btoa`
 * (present in every current browser and in Node ≥ 18) and no Node import: one
 * implementation cannot disagree with itself about what a link means.
 *
 * Everything that comes back through `unpack` is a stranger's input — a link a
 * participant pasted — so decompression is capped, malformed input yields
 * `null` rather than throwing, and the caller still has to validate the shape.
 */

/** Ceiling on *inflated* bytes; a study pack is ~15 kB, so this is generous and still bomb-proof. */
export const MAX_INFLATED_BYTES = 200_000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * A one-chunk stream, built directly rather than via `Blob.stream()` — jsdom's
 * `Blob` has no `.stream()`, and this needs to behave identically in a browser,
 * in Node and under the unit tests.
 */
function streamOf(bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Drains a stream into one buffer, or `null` the moment it exceeds `cap` bytes. */
async function readAll(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const packed = await readAll(
    streamOf(bytes).pipeThrough(new CompressionStream('deflate-raw')),
    Number.MAX_SAFE_INTEGER,
  );
  return packed ?? new Uint8Array(0);
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    return await readAll(streamOf(bytes).pipeThrough(new DecompressionStream('deflate-raw')), MAX_INFLATED_BYTES);
  } catch {
    return null; // not valid deflate data
  }
}

/** Any JSON-serialisable value → a URL-safe string. */
export async function pack(value: unknown): Promise<string> {
  return toBase64Url(await deflate(new TextEncoder().encode(JSON.stringify(value))));
}

/** The inverse of `pack`. `null` for anything that is not a well-formed packed JSON value. */
export async function unpack(code: string): Promise<unknown> {
  const bytes = fromBase64Url(code.trim());
  if (!bytes) return null;
  const inflated = await inflate(bytes);
  if (!inflated) return null;
  try {
    return JSON.parse(new TextDecoder().decode(inflated)) as unknown;
  } catch {
    return null;
  }
}
