import assert from 'node:assert/strict';
import { createInbound } from '../frontend/js/inbound.js';

async function runTests() {
  // Test case 1: good message renders once
  {
    const rendered = [];
    const state = {
      myPeerId: 'peerA',
      currentRoom: 'lobby',
      blockedPeerIds: new Set(),
      messagesHistory: [],
    };
    const deps = {
      state,
      verifySignature: async (msg) => true,
      decryptEnvelope: async (msg) => 'hello world',
      render: (msg) => rendered.push(msg),
      now: () => 1000,
    };
    const handleInbound = createInbound(deps);

    const msg = { id: 'm1', peer_id: 'peerB', room: 'lobby' };
    const res = await handleInbound(msg, 'Relay');

    assert.equal(res, true, 'Good message should return true');
    assert.equal(rendered.length, 1, 'Should render exactly once');
    assert.equal(rendered[0].text, 'hello world');
    assert.equal(rendered[0].route, 'Relay');
    assert.equal(state.messagesHistory.length, 1);
  }

  // Test case 2: same id arriving twice concurrently renders once
  {
    const rendered = [];
    const state = {
      myPeerId: 'peerA',
      currentRoom: 'lobby',
      blockedPeerIds: new Set(),
      messagesHistory: [],
    };
    const deps = {
      state,
      verifySignature: async (msg) => {
        await new Promise((r) => setTimeout(r, 20));
        return true;
      },
      decryptEnvelope: async (msg) => 'concurrent msg',
      render: (msg) => rendered.push(msg),
      now: () => 1000,
    };
    const handleInbound = createInbound(deps);

    const msg1 = { id: 'm2', peer_id: 'peerB', room: 'lobby' };
    const msg2 = { id: 'm2', peer_id: 'peerB', room: 'lobby' };

    const [res1, res2] = await Promise.all([
      handleInbound(msg1, 'Relay'),
      handleInbound(msg2, 'Relay'),
    ]);

    assert.equal(res1, true, 'First resolution should return true');
    assert.equal(res2, false, 'Second concurrent resolution should return false');
    assert.equal(rendered.length, 1, 'Should render only once despite concurrent arrival');
  }

  // Test case 3: bad signature not rendered and a later GOOD message with the same id is still rendered
  {
    const rendered = [];
    const state = {
      myPeerId: 'peerA',
      currentRoom: 'lobby',
      blockedPeerIds: new Set(),
      messagesHistory: [],
    };
    let sigShouldPass = false;
    const deps = {
      state,
      verifySignature: async (msg) => sigShouldPass,
      decryptEnvelope: async (msg) => 'valid content',
      render: (msg) => rendered.push(msg),
      now: () => 1000,
    };
    const handleInbound = createInbound(deps);

    const badMsg = { id: 'm3', peer_id: 'peerB', room: 'lobby' };
    const resBad = await handleInbound(badMsg, 'Relay');
    assert.equal(resBad, false, 'Bad signature message must return false');
    assert.equal(rendered.length, 0, 'Bad signature must not render');

    // Later good message with same id
    sigShouldPass = true;
    const goodMsg = { id: 'm3', peer_id: 'peerB', room: 'lobby' };
    const resGood = await handleInbound(goodMsg, 'Relay');
    assert.equal(resGood, true, 'Later good message with same id must return true');
    assert.equal(rendered.length, 1, 'Later good message must be rendered');
  }

  // Test case 4: undecryptable -> unreadable=true
  {
    const rendered = [];
    const state = {
      myPeerId: 'peerA',
      currentRoom: 'lobby',
      blockedPeerIds: new Set(),
      messagesHistory: [],
    };
    const deps = {
      state,
      verifySignature: async (msg) => true,
      decryptEnvelope: async (msg) => null,
      render: (msg) => rendered.push(msg),
      now: () => 1000,
    };
    const handleInbound = createInbound(deps);

    const undecryptableMsg = { id: 'm4', peer_id: 'peerB', room: 'lobby' };
    const res = await handleInbound(undecryptableMsg, 'P2P Direct');

    assert.equal(res, true, 'Undecryptable envelope still returns true as processed');
    assert.equal(rendered.length, 1, 'Render is still called');
    assert.equal(undecryptableMsg.unreadable, true, 'unreadable must be set to true');
    assert.equal(undecryptableMsg.text, null, 'text must be null');
    assert.equal(undecryptableMsg.route, 'P2P Direct');
  }

  // Test case 6: echo of own message already in messagesHistory must not render
  {
    const rendered = [];
    const state = {
      myPeerId: 'peerA',
      currentRoom: 'lobby',
      blockedPeerIds: new Set(),
      messagesHistory: [{ id: 'm-own-1', peer_id: 'peerA', text: 'my local msg' }],
    };
    const deps = {
      state,
      verifySignature: async () => true,
      decryptEnvelope: async () => 'my local msg',
      render: (msg) => rendered.push(msg),
      now: () => 1000,
    };
    const handleInbound = createInbound(deps);

    const echoMsg = { id: 'm-own-1', peer_id: 'peerA', room: 'lobby' };
    const res = await handleInbound(echoMsg, 'Relay');

    assert.equal(res, false, 'Echo of own message already in history must return false');
    assert.equal(rendered.length, 0, 'Render must not be called for own echo');
  }

  console.log('All inbound_test.mjs test cases passed.');
}

runTests();
