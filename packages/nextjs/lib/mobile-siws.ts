import { randomBytes, createPublicKey, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

const NONCE_TTL_MS = 10 * 60 * 1000;
const nonceStore = new Map<string, number>();

function cleanExpiredNonces(now = Date.now()) {
  for (const [nonce, expiresAt] of nonceStore.entries()) {
    if (expiresAt <= now) nonceStore.delete(nonce);
  }
}

export function issueNonce(now = Date.now()) {
  cleanExpiredNonces(now);
  const nonce = randomBytes(24).toString("base64url");
  const expiresAt = now + NONCE_TTL_MS;
  nonceStore.set(nonce, expiresAt);
  return {
    nonce,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function consumeNonce(nonce: string, now = Date.now()) {
  cleanExpiredNonces(now);
  const expiresAt = nonceStore.get(nonce);
  if (!expiresAt || expiresAt <= now) return false;
  nonceStore.delete(nonce);
  return true;
}

export function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

export function toBase58Address(addressBase64: string): string {
  const addressBytes = decodeBase64(addressBase64);
  return new PublicKey(addressBytes).toBase58();
}

export function verifyEd25519Bytes(params: {
  publicKeyBytes: Uint8Array;
  messageBytes: Uint8Array;
  signatureBytes: Uint8Array;
}): boolean {
  const pubKeyObj = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(params.publicKeyBytes),
    ]),
    format: "der",
    type: "spki",
  });
  return verify(
    null,
    Buffer.from(params.messageBytes),
    pubKeyObj,
    Buffer.from(params.signatureBytes),
  );
}

export type MobileSiwsPayload = {
  domain?: string;
  statement?: string;
  nonce?: string;
  issuedAt?: string;
  uri?: string;
  version?: string;
  chainId?: string;
};

export type MobileSiwsResult = {
  address: string;
  signed_message: string;
  signature: string;
  signature_type?: string;
};
