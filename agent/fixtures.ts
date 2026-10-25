/**
 * Demo invoices.
 *
 * The text intentionally contains realistic sensitive material (a personal
 * name, e-mail, IBAN, phone number, postal address) so the demo can prove two
 * things at once:
 *   1. the redactor removes it before anything leaves the process;
 *   2. none of it is ever printed, stored in an artifact, or written on-chain.
 *
 * `invoice_ref` is the only invoice identifier that may cross either boundary.
 */

export interface DemoInvoice {
  invoiceRef: string;
  text: string;
}

const SENSITIVE_MARKERS = [
  'Mara Fenwick',
  'ops.canary.7731@acme.example',
  'DE89 3704 0044 0532 0130 7731',
  '+49 30 7731 8899',
  '41 Canary Wharf Road',
];

/** Used by tests to assert that no raw invoice text leaks to stdout/artifacts. */
export const DEMO_LEAK_CANARIES = SENSITIVE_MARKERS;

export const INVOICES: Record<
  'success' | 'overLimit' | 'notWhitelisted' | 'risky',
  DemoInvoice
> = {
  success: {
    invoiceRef: 'INV-2026-1042',
    text: [
      'INVOICE INV-2026-1042',
      'From: Acme Design Studio GmbH',
      'Bill to: Mara Fenwick',
      'Email: ops.canary.7731@acme.example',
      'IBAN: DE89 3704 0044 0532 0130 7731',
      'Phone: +49 30 7731 8899',
      'Address: 41 Canary Wharf Road',
      'Amount: 3 USDC',
      'Pay to: alice.samimmi.testnet',
      'Purpose: design retainer for October',
    ].join('\n'),
  },
  overLimit: {
    invoiceRef: 'INV-2026-1043',
    text: [
      'INVOICE INV-2026-1043',
      'From: Northwind Traders Ltd',
      'Bill to: Mara Fenwick',
      'Email: ops.canary.7731@acme.example',
      'Subtotal: 4 USDC',
      'Total due: 50 USDC',
      'Pay to: alice.samimmi.testnet',
      'Purpose: server migration for October',
    ].join('\n'),
  },
  notWhitelisted: {
    invoiceRef: 'INV-2026-1044',
    text: [
      'INVOICE INV-2026-1044',
      'From: Unverified Supplier',
      'Bill to: Mara Fenwick',
      'Amount: 1 USDC',
      'Pay to: eve.samimmi.testnet',
      'Purpose: sample order',
    ].join('\n'),
  },
  risky: {
    invoiceRef: 'INV-2026-1045',
    text: [
      'INVOICE INV-2026-1045',
      'From: Unknown Party',
      'Bill to: Mara Fenwick',
      'Amount: 2 USDC',
      'Pay to: alice.samimmi.testnet',
      'Purpose: urgent gift card purchase',
    ].join('\n'),
  },
};
