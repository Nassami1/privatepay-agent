/**
 * NEAR AI Cloud per-response signatures.
 *
 * The gateway signs `model:sha256(request bytes):sha256(response bytes)` with
 * the model-serving TEE key (or the gateway key). For `ecdsa` the signer uses
 * EIP-191; we recover the address and compare it with the attestation report's
 * signing address. The raw request and response bytes must be retained exactly:
 * hashing a re-serialized JSON body would not verify.
 *
 * If no signature is available after a short bounded retry, the caller treats
 * the inference as unverified and does not pay.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { SignatureEvidence } from '../types.js';

export interface RawResponseSignature {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
  signature_kind: string;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function expectedSignatureText(
  model: string,
  requestBody: string,
  responseBody: string,
): string {
  return `${model}:${sha256Hex(requestBody)}:${sha256Hex(responseBody)}`;
}

export function verifyResponseSignature(
  raw: RawResponseSignature,
  options: {
    expectedText: string;
    expectedSigner: string;
    expectedKind: 'provider_tee' | 'gateway';
  },
): SignatureEvidence {
  if (raw.text !== options.expectedText) {
    throw new Error('response signature is not bound to the exact request/response bytes');
  }
  if (raw.signature_kind !== options.expectedKind) {
    throw new Error(
      `response signature kind ${raw.signature_kind} does not match ${options.expectedKind}`,
    );
  }

  let recovered: string;
  let algorithm: 'ecdsa' | 'ed25519';
  if (raw.signing_algo === 'ecdsa') {
    algorithm = 'ecdsa';
    recovered = recoverEip191Address(raw.signature, raw.text);
  } else if (raw.signing_algo === 'ed25519') {
    algorithm = 'ed25519';
    recovered = verifyEd25519(raw.signing_address, raw.signature, raw.text);
  } else {
    throw new Error(`unsupported signature algorithm: ${raw.signing_algo}`);
  }

  if (recovered.toLowerCase() !== raw.signing_address.toLowerCase()) {
    throw new Error('response signature does not recover to the claimed signer');
  }
  if (recovered.toLowerCase() !== options.expectedSigner.toLowerCase()) {
    throw new Error('response signer does not match the preflight attestation evidence');
  }

  return {
    kind: options.expectedKind,
    signer: recovered,
    algorithm,
    text: raw.text,
    verified: true,
  };
}

function recoverEip191Address(signatureHex: string, text: string): string {
  const bytes = Buffer.from(signatureHex.replace(/^0x/, ''), 'hex');
  if (bytes.length !== 65) throw new Error('expected a 65-byte ECDSA signature');
  let recovery = bytes[64] ?? 0;
  if (recovery >= 27) recovery -= 27;
  if (recovery < 0 || recovery > 3) throw new Error('invalid ECDSA recovery id');

  const messageHash = eip191Hash(text);
  const signature = secp256k1.Signature.fromBytes(bytes.subarray(0, 64));
  const publicKey = signature.addRecoveryBit(recovery).recoverPublicKey(messageHash).toBytes(false);
  const address = keccak_256(publicKey.subarray(1)).subarray(-20);
  return `0x${Buffer.from(address).toString('hex')}`;
}

function eip191Hash(text: string): Uint8Array {
  const prefix = `\x19Ethereum Signed Message:\n${Buffer.byteLength(text)}`;
  return keccak_256(
    Buffer.concat([Buffer.from(prefix, 'utf8'), Buffer.from(text, 'utf8')]),
  );
}

function verifyEd25519(address: string, signatureHex: string, text: string): string {
  const rawKey = Buffer.from(address.replace(/^ed25519:/, ''), 'hex');
  if (rawKey.length !== 32) throw new Error('expected a 32-byte ed25519 public key');
  const der = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    rawKey,
  ]);
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  const ok = cryptoVerify(
    null,
    Buffer.from(text, 'utf8'),
    key,
    Buffer.from(signatureHex.replace(/^0x/, ''), 'hex'),
  );
  if (!ok) throw new Error('ed25519 response signature is invalid');
  return address.toLowerCase();
}

const SIGNATURE_RETRIES = 4;
const SIGNATURE_RETRY_MS = 500;

export async function fetchResponseSignature(
  baseUrl: string,
  apiKey: string,
  chatId: string,
  signingAlgo = 'ecdsa',
): Promise<RawResponseSignature> {
  const url = new URL(`${baseUrl}/v1/signature/${encodeURIComponent(chatId)}`);
  url.searchParams.set('signing_algo', signingAlgo);

  let lastError: unknown = null;
  for (let attempt = 0; attempt < SIGNATURE_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404) {
        lastError = new Error('signature not recorded yet (404)');
      } else if (!response.ok) {
        lastError = new Error(`signature endpoint HTTP ${response.status}`);
      } else {
        const payload = (await response.json()) as Partial<RawResponseSignature> & {
          error_code?: string;
          message?: string;
        };
        if (payload.error_code !== undefined) {
          lastError = new Error(`signature unavailable: ${payload.error_code}`);
        } else if (
          typeof payload.text === 'string' &&
          typeof payload.signature === 'string' &&
          typeof payload.signing_address === 'string' &&
          typeof payload.signing_algo === 'string' &&
          typeof payload.signature_kind === 'string'
        ) {
          return payload as RawResponseSignature;
        } else {
          lastError = new Error('signature response is missing fields');
        }
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < SIGNATURE_RETRIES - 1) {
      await sleep(SIGNATURE_RETRY_MS * (attempt + 1));
    }
  }
  throw new Error(
    `response signature unavailable after ${SIGNATURE_RETRIES} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
