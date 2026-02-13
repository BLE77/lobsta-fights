import { createHash, randomUUID } from "node:crypto";

/** Generate a new API key (returned to user once, then only stored as hash) */
export function generateApiKey(): { plaintext: string; hash: string } {
  const plaintext = randomUUID();
  const hash = hashApiKey(plaintext);
  return { plaintext, hash };
}

/** Hash an API key for storage/comparison */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
