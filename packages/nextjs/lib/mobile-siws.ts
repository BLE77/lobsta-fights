import { randomBytes, createPublicKey, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { freshSupabase } from "./supabase";

const NONCE_TTL_MS = 10 * 60 * 1000;
const NONCE_ADMIN_KEY_PREFIX = "mobile_siws_nonce_v2:";

export interface MobileSiwsNonceRecord {
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

function nonceAdminKey(nonce: string): string {
  return `${NONCE_ADMIN_KEY_PREFIX}${nonce}`;
}

function parseNonceRecord(nonce: string, value: unknown): MobileSiwsNonceRecord | null {
  if (!value || typeof value !== "object") return null;
  const issuedAt = typeof (value as any).issuedAt === "string" ? (value as any).issuedAt : "";
  const expiresAt = typeof (value as any).expiresAt === "string" ? (value as any).expiresAt : "";
  if (!issuedAt || !expiresAt) return null;
  return { nonce, issuedAt, expiresAt };
}

async function deleteNonceRecord(nonce: string): Promise<MobileSiwsNonceRecord | null> {
  const sb = freshSupabase();
  const { data, error } = await sb
    .from("admin_config")
    .delete()
    .eq("key", nonceAdminKey(nonce))
    .select("value")
    .maybeSingle();
  if (error && error.code !== "PGRST116") {
    throw error;
  }
  return parseNonceRecord(nonce, data?.value ?? null);
}

export async function issueNonce(now = Date.now()): Promise<MobileSiwsNonceRecord> {
  const nonce = randomBytes(24).toString("base64url");
  const expiresAt = now + NONCE_TTL_MS;
  const record: MobileSiwsNonceRecord = {
    nonce,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
  const sb = freshSupabase();
  const { error } = await sb.from("admin_config").insert({
    key: nonceAdminKey(nonce),
    value: record,
    updated_at: new Date(now).toISOString(),
  });
  if (error) throw error;
  return record;
}

export async function readNonce(nonce: string, now = Date.now()): Promise<MobileSiwsNonceRecord | null> {
  const trimmedNonce = typeof nonce === "string" ? nonce.trim() : "";
  if (!trimmedNonce) return null;
  const sb = freshSupabase();
  const { data, error } = await sb
    .from("admin_config")
    .select("value")
    .eq("key", nonceAdminKey(trimmedNonce))
    .maybeSingle();
  if (error && error.code !== "PGRST116") {
    throw error;
  }
  const record = parseNonceRecord(trimmedNonce, data?.value ?? null);
  if (!record) return null;
  const expiresAtMs = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
    await deleteNonceRecord(trimmedNonce).catch(() => null);
    return null;
  }
  return record;
}

export async function consumeNonce(nonce: string, now = Date.now()): Promise<boolean> {
  const record = await deleteNonceRecord(nonce);
  if (!record) return false;
  const expiresAtMs = Date.parse(record.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > now;
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
