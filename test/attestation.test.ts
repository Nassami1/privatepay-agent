import test from 'node:test';
import assert from 'node:assert/strict';
import {
  simulatedAttestation,
  verifyAttestationReport,
} from '../agent/tee/attestation.js';
import type { RedactionResult } from '../agent/types.js';

const redaction: RedactionResult = {
  redactedText: 'redacted',
  redactedFields: ['EMAIL', 'IBAN'],
  replacements: 2,
};

function syntheticReport(nonce: string): unknown {
  return {
    gateway_attestation: {
      signing_address: '0xgateway',
      signing_algo: 'ecdsa',
      intel_quote: 'Q'.repeat(2000),
      report_data: 'data',
      request_nonce: nonce,
      event_log: JSON.stringify([{ imr: 0 }, { imr: 1 }]),
      info: { app_id: 'app-1', instance_id: 'instance-1' },
    },
    model_attestations: [
      {
        model_name: 'z-ai/glm-5.3-flash',
        signing_address: '0xmodel',
        request_nonce: nonce,
        intel_quote: 'M'.repeat(2000),
        event_log: [{ imr: 0 }],
        info: {},
      },
    ],
  };
}

test('simulated evidence is explicitly labelled and carries the required fields', () => {
  const evidence = simulatedAttestation({
    model: 'local-deterministic-extractor',
    redaction,
    reason: 'no key',
  });
  assert.equal(evidence.mode, 'simulated');
  assert.match(evidence.disclaimer, /SIMULATED_ATTESTATION/);
  assert.match(evidence.disclaimer, /not a real TEE attestation/i);
  assert.equal(evidence.verificationUrl, 'https://docs.near.ai/cloud/verification/');
  assert.deepEqual(evidence.redactedFields, ['EMAIL', 'IBAN']);
  assert.deepEqual(evidence.redacted_fields, ['EMAIL', 'IBAN']);
  assert.equal(evidence.verification_url, 'https://docs.near.ai/cloud/verification/');
  assert.equal(evidence.digest.length, 64);
});

test('real report passes structural checks and binds the nonce', () => {
  const nonce = 'a'.repeat(64);
  const evidence = verifyAttestationReport({
    report: syntheticReport(nonce),
    nonce,
    model: 'z-ai/glm-5.3-flash',
    redaction,
  });
  assert.equal(evidence.mode, 'real');
  assert.equal(evidence.checks.length, 7);
  assert.ok(evidence.checks.every((check) => check.ok));
  assert.equal(evidence.verificationUrl, 'https://cloud.near.ai/verify');
  assert.equal(evidence.environment?.gatewayAppId, 'app-1');
  assert.equal(evidence.environment?.eventLogEntries, 2);
  assert.equal(evidence.digest.length, 64);
});

test('rejects a report whose nonce does not match the client nonce', () => {
  assert.throws(
    () =>
      verifyAttestationReport({
        report: syntheticReport('b'.repeat(64)),
        nonce: 'c'.repeat(64),
        model: 'z-ai/glm-5.3-flash',
        redaction,
      }),
    /nonce_bound_to_request/,
  );
});

test('rejects a report for a different model', () => {
  const nonce = 'd'.repeat(64);
  assert.throws(
    () =>
      verifyAttestationReport({
        report: syntheticReport(nonce),
        nonce,
        model: 'some/other-model',
        redaction,
      }),
    /model_identity_matches/,
  );
});

test('rejects a report with no event log', () => {
  const nonce = 'e'.repeat(64);
  const report = syntheticReport(nonce) as {
    gateway_attestation: { event_log?: unknown };
  };
  delete report.gateway_attestation.event_log;
  assert.throws(
    () =>
      verifyAttestationReport({
        report,
        nonce,
        model: 'z-ai/glm-5.3-flash',
        redaction,
      }),
    /event_log_present/,
  );
});

test('rejects a report with no model attestation', () => {
  const nonce = 'f'.repeat(64);
  const report = syntheticReport(nonce) as { model_attestations: unknown[] };
  report.model_attestations = [];
  assert.throws(
    () =>
      verifyAttestationReport({
        report,
        nonce,
        model: 'z-ai/glm-5.3-flash',
        redaction,
      }),
    /model_attestation_present/,
  );
});
