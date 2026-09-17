// App.tsx
// Root application: identity setup → chat interface.

import React, { useEffect, useState, useRef, useCallback } from 'react';
import './index.css';
import { getOrCreateIdentity, type Identity } from './core/crypto/DeviceIdentity';
import { decrypt, getSessionKey } from './core/crypto/MessageCipher';
import { buildPacket, BROADCAST_FP } from './core/mesh/MeshPacket';
import { transportManager } from './core/transport/TransportManager';
import { TransportStatusBar } from './components/TransportStatusBar';

// ── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  text: string;
  senderFp: string;
  isMine: boolean;
  timestamp: number;
  status: 'sending' | 'relayed' | 'delivered';
}

// ── Setup Screen ─────────────────────────────────────────────────────────────

const SetupScreen: React.FC<{ onReady: (identity: Identity) => void }> = ({ onReady }) => {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getOrCreateIdentity().then((id) => {
      setIdentity(id);
      setLoading(false);
    });
  }, []);

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <div className="setup-card__logo">MistRoom</div>
        <p className="setup-card__tagline">
          Anonymous, decentralized, end-to-end encrypted mesh messenger.<br />
          Your identity never leaves your device.
        </p>
        {loading ? (
          <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Generating identity…</p>
        ) : identity ? (
          <>
            <div>
              <p className="setup-card__label">Your Device Fingerprint</p>
              <div className="setup-card__fp">{identity.fingerprint}</div>
            </div>
            <button className="btn btn--primary" onClick={() => onReady(identity)}>
              Enter MistRoom
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
};

// ── Chat Screen ───────────────────────────────────────────────────────────────

const ChatScreen: React.FC<{ identity: Identity }> = ({ identity }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  // Start transport and listen for inbound packets
  useEffect(() => {
    transportManager.start();

    const unsub = transportManager.onPacket(async (packet) => {
      // Attempt to decrypt if we have a session key for the sender
      const senderFp = Array.from(packet.srcFp).map(b => b.toString(16).padStart(2,'0')).join('');
      const sessionKey = getSessionKey(senderFp);
      if (!sessionKey) return; // No shared key yet — future: key exchange handshake

      try {
        const plainBytes = await decrypt(sessionKey, packet.payload);
        const text = new TextDecoder().decode(plainBytes);
        setMessages((prev) => [
          ...prev,
          {
            id: packet.packetId,
            text,
            senderFp,
            isMine: false,
            timestamp: Date.now(),
            status: 'delivered',
          },
        ]);
      } catch {
        // Decryption failed (not for us, or tampered)
      }
    });

    return () => {
      unsub();
      transportManager.stop();
    };
  }, []);

  // Auto-scroll to bottom on new message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');

    // For demo: broadcast unencrypted (no peer key yet); real flow adds ECDH handshake
    const plainBytes = new TextEncoder().encode(text);
    const packet = buildPacket(identity.publicKey, BROADCAST_FP, plainBytes, {});

    const msgId = packet.packetId;
    const msg: ChatMessage = {
      id: msgId,
      text,
      senderFp: identity.fingerprint,
      isMine: true,
      timestamp: Date.now(),
      status: 'sending',
    };
    setMessages((prev) => [...prev, msg]);

    const tier = transportManager.send(packet);
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId ? { ...m, status: tier !== 'none' ? 'relayed' : 'sending' } : m
      )
    );
  }, [draft, identity]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const shortFp = (fp: string) => fp.slice(0, 6) + '…';
  const timeStr = (ts: number) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="app-shell">
      <TransportStatusBar fingerprint={identity.fingerprint} />

      <div className="chat-area">
        <div className="messages-list">
          {messages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state__icon">🌐</div>
              <h1 className="empty-state__title">No messages yet</h1>
              <p className="empty-state__sub">
                Send a message below. It will be encrypted and routed via the mesh network.
              </p>
            </div>
          ) : (
            messages.map((msg) => (
              <div key={msg.id} className={`bubble-row ${msg.isMine ? 'bubble-row--mine' : ''}`}>
                <div className="bubble-row__avatar">
                  {msg.senderFp.slice(0, 2).toUpperCase()}
                </div>
                <div className={`bubble ${msg.isMine ? 'bubble--mine' : ''}`}>
                  <div className="bubble__meta">
                    <span className="bubble__sender">{msg.isMine ? 'You' : shortFp(msg.senderFp)}</span>
                    <span className="bubble__time">{timeStr(msg.timestamp)}</span>
                    <span className={`bubble__status bubble__status--${msg.status}`}>
                      {msg.status}
                    </span>
                  </div>
                  <div className="bubble__text">{msg.text}</div>
                </div>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        <div className="compose-bar">
          <button className="btn btn--icon" title="Attach file">📎</button>
          <textarea
            className="compose-bar__input"
            placeholder="Type a message… (Enter to send)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button className="btn btn--icon" title="Voice note">🎤</button>
          <button className="btn btn--send" onClick={sendMessage} disabled={!draft.trim()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Root App ─────────────────────────────────────────────────────────────────

const App: React.FC = () => {
  const [identity, setIdentity] = useState<Identity | null>(null);

  if (!identity) {
    return <SetupScreen onReady={setIdentity} />;
  }

  return <ChatScreen identity={identity} />;
};

export default App;
