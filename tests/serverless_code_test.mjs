import assert from 'node:assert';
import { canon, computePairingCode } from '../frontend/js/pairing_code.js';

// Test canon: trim + normalize CRLF/CR to LF
const rawOffer = '  v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n  ';
const rawAnswer = '\r\nv=0\r\no=- 67890 2 IN IP4 127.0.0.1\ns=-\nt=0 0\r\n';

const canonOffer = canon(rawOffer);
const canonAnswer = canon(rawAnswer);

assert.strictEqual(canonOffer, 'v=0\no=- 12345 2 IN IP4 127.0.0.1\ns=-\nt=0 0');
assert.strictEqual(canonAnswer, 'v=0\no=- 67890 2 IN IP4 127.0.0.1\ns=-\nt=0 0');

// Test that CRLF and LF inputs produce identical canonical forms and identical pairing codes
const rawOfferLF = rawOffer.replace(/\r\n/g, '\n');
const rawAnswerCRLF = rawAnswer.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

const code1 = computePairingCode(rawOffer, rawAnswer);
const code2 = computePairingCode(rawOfferLF, rawAnswerCRLF);

assert.strictEqual(code1, code2, 'Pairing codes must match regardless of line ending format');
assert.strictEqual(typeof code1, 'string');
assert.strictEqual(code1.length, 6, 'Pairing code must be exactly 6 characters');
assert.match(code1, /^\d{6}$/, 'Pairing code must be 6 digits (zero-padded)');

// Test deterministic fixed SDP pair output
const fixedOffer = 'v=0\no=Alice 1000 2 IN IP4 127.0.0.1\ns=-\nt=0 0\nm=application 9 DTLS/SCTP 5000';
const fixedAnswer = 'v=0\no=Bob 2000 2 IN IP4 127.0.0.1\ns=-\nt=0 0\nm=application 9 DTLS/SCTP 5000';

const fixedCode = computePairingCode(fixedOffer, fixedAnswer);
assert.strictEqual(fixedCode.length, 6);
assert.match(fixedCode, /^\d{6}$/);

// Calling multiple times produces same result
assert.strictEqual(computePairingCode(fixedOffer, fixedAnswer), fixedCode);

console.log('Serverless code tests passed. Derived code:', fixedCode);
