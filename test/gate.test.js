/**
 * gate.test.js — the one hard rule, tested where it is enforced.
 *
 * If any of these fail, the desk is decorative.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeDesk } from './helpers.js';

test('a proposal without a stamp cannot be executed', async () => {
  const { approvals } = await makeDesk();
  const p = approvals.create({ symbol: 'NVDA', side: 'buy', qty: 100, entry: 180, stop: 174 });
  const claim = approvals.claimForExecution(p.id);
  assert.equal(claim.ok, false);
  assert.equal(claim.requires, 'SENTINEL_STAMP');
});

test('an unsigned or self-signed stamp is refused', async () => {
  const { approvals } = await makeDesk();
  const p = approvals.create({ symbol: 'TSLA', side: 'buy', qty: 10, entry: 400, stop: 380 });
  const decision = { approved: true, size: 10, stop: 380, target: 430, signedBy: 'pilot', conditions: [] };
  decision.signature = crypto.sign(null, Buffer.from(approvals.digestOf(p, decision), 'hex'), crypto.generateKeyPairSync('ed25519').privateKey).toString('base64');
  const out = approvals.stamp(p.id, decision);
  assert.equal(out.ok, false, 'a foreign key must not verify');
  assert.match(out.error, /signature invalid/);

  // same, but with a key we did not issue and the right signer name
  const noSig = approvals.stamp(p.id, { ...decision, signature: '' });
  assert.equal(noSig.ok, false);
});

test('the stamp is produced only by the holder of the private key', async () => {
  const { approvals, keys } = await makeDesk();
  const { signDigest } = await import('../server/keys.js');
  const p = approvals.create({ symbol: 'AAPL', side: 'buy', qty: 5, entry: 232, stop: 224 });
  const decision = { approved: true, size: 5, stop: 224, target: 244, signedBy: 'sentinel', conditions: [], reason: 'within limits' };
  decision.signature = signDigest(keys.privatePem, approvals.digestOf(p, decision));
  const out = approvals.stamp(p.id, decision);
  assert.equal(out.ok, true);
  assert.equal(out.proposal.status, 'stamped');
  // tampering with the decision after signing invalidates it
  const tampered = approvals.digestOf(out.proposal, { ...decision, size: 5000 });
  assert.notEqual(tampered, out.proposal.stamp.digest, 'stamp digest must cover the size');
});

test('stamped is not tradable until a human confirms', async () => {
  const { approvals, keys } = await makeDesk();
  const { signDigest } = await import('../server/keys.js');
  const p = approvals.create({ symbol: 'SPY', side: 'buy', qty: 3, entry: 640, stop: 630 });
  const decision = { approved: true, size: 3, stop: 630, target: 660, signedBy: 'sentinel' };
  decision.signature = signDigest(keys.privatePem, approvals.digestOf(p, decision));
  approvals.stamp(p.id, decision);
  assert.equal(approvals.claimForExecution(p.id).ok, false, 'stamp alone must not fire');
  assert.equal(approvals.confirmHuman(p.id).ok, true);
  assert.equal(approvals.claimForExecution(p.id).ok, true);
});

test('a consumed stamp cannot fund a second trade', async () => {
  const { approvals, keys, blotter } = await makeDesk();
  const { signDigest } = await import('../server/keys.js');
  const p = approvals.create({ symbol: 'QQQ', side: 'buy', qty: 2, entry: 567, stop: 555 });
  const decision = { approved: true, size: 2, stop: 555, signedBy: 'sentinel' };
  decision.signature = signDigest(keys.privatePem, approvals.digestOf(p, decision));
  approvals.stamp(p.id, decision);
  approvals.confirmHuman(p.id);
  const first = approvals.claimForExecution(p.id);
  assert.equal(first.ok, true);
  const fill = blotter.submit({ proposal: first.proposal, quote: { price: 567 } });
  assert.equal(fill.ok, true);
  approvals.markExecuted(p.id, { ok: true, ...fill });
  assert.equal(approvals.claimForExecution(p.id).ok, false, 'replay must fail');
});

test('veto path: the proposal dies with a reason and a signature', async () => {
  const { approvals, keys } = await makeDesk();
  const { signDigest } = await import('../server/keys.js');
  const p = approvals.create({ symbol: 'SMCI', side: 'buy', qty: 1000, entry: 44, stop: 22, context: { simulated: true } });
  const decision = { approved: false, signedBy: 'sentinel', reason: 'size breaches the concentration cap', conditions: [] };
  decision.signature = signDigest(keys.privatePem, approvals.digestOf(p, decision));
  const out = approvals.stamp(p.id, decision);
  assert.equal(out.ok, true);
  assert.equal(out.proposal.status, 'vetoed');
  assert.equal(approvals.claimForExecution(p.id).ok, false);
});

test('pilot refuses to execute while the gate is closed', async () => {
  const { master, registry, feed } = await makeDesk();
  await master.handleCommand('buy 100 shares of NVDA');
  // fresh desk: a drafted proposal has no stamp yet until Sentinel ran on it
  const rep = await registry.call('pilot', {
    text: 'execute it', intent: 'execute', symbol: 'NVDA', params: { proposalId: 'prop_missing' },
    feed, reports: {}, services: { bus: master.bus, journal: master.journal, approvals: master.approvals, blotter: master.blotter, keys: null },
  });
  assert.equal(rep.status, 'blocked');
  assert.match(rep.headline, /Refused to execute/);
});
