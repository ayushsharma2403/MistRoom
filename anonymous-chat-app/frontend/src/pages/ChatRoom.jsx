import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getGroup, getMessages } from '../services/api';
import { PeerMeshManager } from '../services/meshNetwork';

export default function ChatRoom() {
  const { groupId } = useParams();
  const navigate = useNavigate();

  const [group, setGroup] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [myIdentity, setMyIdentity] = useState(null);
  const [meshPeers, setMeshPeers] = useState([]);
  const [peerCount, setPeerCount] = useState(1);
  const [typingUsers, setTypingUsers] = useState({});
  const [showDrawer, setShowDrawer] = useState(false);
  const [copyToast, setCopyToast] = useState(false);

  const messagesEndRef = useRef(null);
  const meshRef = useRef(null);
  const typingTimeoutRef = useRef(null);

  // Generate persistent peerId for this session
  const getPeerId = () => {
    let pid = sessionStorage.getItem('cloak_peer_id');
    if (!pid) {
      pid = Math.random().toString(36).substring(2, 10);
      sessionStorage.setItem('cloak_peer_id', pid);
    }
    return pid;
  };

  const peerId = getPeerId();

  useEffect(() => {
    fetchRoomDetails();
    fetchHistory();

    // Initialize WebRTC P2P Mesh Manager
    const meshManager = new PeerMeshManager(groupId, peerId, {
      onAck: (identity) => setMyIdentity(identity),
      onState: (state) => {
        setMeshPeers(state.peers || []);
        setPeerCount(state.peerCount || 1);
      },
      onMessage: (msg) => {
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
      },
      onSystemMessage: (sysMsg) => {
        setMessages((prev) => [...prev, sysMsg]);
      },
      onTyping: (data) => {
        if (data.peerId === peerId) return;
        setTypingUsers((prev) => {
          const updated = { ...prev };
          if (data.isTyping) {
            updated[data.peerId] = data.alias;
          } else {
            delete updated[data.peerId];
          }
          return updated;
        });
      }
    });

    meshManager.connect();
    meshRef.current = meshManager;

    return () => {
      if (meshRef.current) {
        meshRef.current.disconnect();
      }
    };
  }, [groupId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, typingUsers]);

  const fetchRoomDetails = async () => {
    try {
      const data = await getGroup(groupId);
      setGroup(data);
    } catch (err) {
      setGroup({ groupId, name: `Room ${groupId}` });
    }
  };

  const fetchHistory = async () => {
    try {
      const history = await getMessages(groupId);
      setMessages(history);
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleInputChange = (e) => {
    setInputText(e.target.value);

    if (meshRef.current) {
      meshRef.current.sendP2PTyping(true);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => {
        if (meshRef.current) meshRef.current.sendP2PTyping(false);
      }, 2000);
    }
  };

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (!inputText.trim() || !myIdentity) return;

    const nowStr = new Date().toISOString();
    const msgId = 'p2p_' + Math.random().toString(36).substring(2, 10);

    const msgPayload = {
      id: msgId,
      groupId: groupId,
      text: inputText.trim(),
      senderId: peerId,
      senderName: myIdentity.alias,
      avatar: myIdentity.avatar,
      color: myIdentity.color,
      timestamp: nowStr
    };

    // 1. Render message locally in UI
    setMessages((prev) => [...prev, msgPayload]);

    // 2. Broadcast directly across WebRTC P2P DataChannels to all mesh peers
    if (meshRef.current) {
      meshRef.current.broadcastP2P(msgPayload);
      meshRef.current.sendP2PTyping(false);
    }

    setInputText('');
  };

  const addEmoji = (emoji) => {
    setInputText((prev) => prev + emoji);
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopyToast(true);
    setTimeout(() => setCopyToast(false), 2500);
  };

  const activeTypingCount = Object.keys(typingUsers).length;
  const activeTypingNames = Object.values(typingUsers).join(', ');

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      maxWidth: '1200px',
      margin: '0 auto',
      background: 'var(--bg-dark)'
    }}>
      {/* Toast Notification */}
      {copyToast && (
        <div style={{
          position: 'fixed',
          top: '20px',
          right: '20px',
          zIndex: 1000,
          background: 'rgba(16, 185, 129, 0.9)',
          color: '#ffffff',
          padding: '10px 20px',
          borderRadius: 'var(--radius-md)',
          fontWeight: 600,
          boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
          animation: 'fadeInUp 0.3s ease'
        }}>
          📋 P2P Share Link Copied!
        </div>
      )}

      {/* Top Header */}
      <header className="glass-panel" style={{
        borderRadius: 0,
        borderLeft: 'none',
        borderRight: 'none',
        borderTop: 'none',
        padding: '14px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        zIndex: 10
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <button className="btn-icon" onClick={() => navigate('/')} title="Back to Home">
            ←
          </button>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h2 style={{ fontSize: '1.1rem', fontWeight: 700 }}>{group?.name || `Room ${groupId}`}</h2>
              <span className="code-badge">{groupId}</span>
            </div>
            {myIdentity && (
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                Identity: <span style={{ color: myIdentity.color, fontWeight: 600 }}>{myIdentity.avatar} {myIdentity.alias}</span>
              </p>
            )}
          </div>
        </div>

        {/* Right Header Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span className="badge-online" style={{ borderColor: 'rgba(6, 182, 212, 0.4)', color: 'var(--accent-cyan)' }}>
            🌐 P2P Mesh ({peerCount})
          </span>

          <button className="btn-secondary" onClick={handleCopyLink} style={{ padding: '8px 14px', fontSize: '0.85rem' }}>
            🔗 Share Link
          </button>

          <button
            className="btn-icon"
            onClick={() => setShowDrawer(!showDrawer)}
            title="Toggle Mesh Peers List"
            style={{ color: showDrawer ? 'var(--primary)' : 'var(--text-muted)' }}
          >
            👥
          </button>
        </div>
      </header>

      {/* Main Container: Chat + P2P Mesh Drawer */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative' }}>
        {/* Chat Feed */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: 'rgba(9, 12, 21, 0.4)',
          overflow: 'hidden'
        }}>
          {/* Messages Scroll Area */}
          <div style={{
            flex: 1,
            padding: '20px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
          }}>
            {messages.length === 0 ? (
              <div style={{ textAlign: 'center', margin: 'auto', color: 'var(--text-dim)', padding: '40px' }}>
                <span style={{ fontSize: '2.5rem', display: 'block', marginBottom: '10px' }}>🌐</span>
                <p style={{ fontWeight: 600, color: 'var(--text-muted)' }}>P2P Mesh Network Ready</p>
                <p style={{ fontSize: '0.85rem' }}>Direct peer-to-peer data channels active. Send a message!</p>
              </div>
            ) : (
              messages.map((msg) => {
                if (msg.isSystem) {
                  return (
                    <div key={msg.id} style={{
                      textAlign: 'center',
                      fontSize: '0.8rem',
                      color: 'var(--text-dim)',
                      margin: '6px 0'
                    }}>
                      <span style={{
                        background: 'rgba(255, 255, 255, 0.05)',
                        padding: '4px 12px',
                        borderRadius: 'var(--radius-full)',
                        border: '1px solid rgba(255,255,255,0.05)'
                      }}>
                        {msg.text}
                      </span>
                    </div>
                  );
                }

                const isMe = msg.senderId === peerId;

                return (
                  <div
                    key={msg.id}
                    className="animate-fade-in"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: isMe ? 'flex-end' : 'flex-start',
                      maxWidth: '80%',
                      alignSelf: isMe ? 'flex-end' : 'flex-start'
                    }}
                  >
                    {!isMe && (
                      <span style={{
                        fontSize: '0.75rem',
                        color: msg.color || '#a855f7',
                        fontWeight: 600,
                        marginBottom: '4px',
                        marginLeft: '4px'
                      }}>
                        {msg.avatar} {msg.senderName}
                      </span>
                    )}

                    <div style={{
                      background: isMe
                        ? 'linear-gradient(135deg, var(--primary) 0%, #7c3aed 100%)'
                        : 'rgba(30, 41, 59, 0.85)',
                      color: '#ffffff',
                      padding: '12px 16px',
                      borderRadius: isMe ? '16px 16px 2px 16px' : '16px 16px 16px 2px',
                      border: isMe ? 'none' : '1px solid var(--border-glass)',
                      boxShadow: isMe ? '0 4px 12px var(--primary-glow)' : 'none',
                      wordBreak: 'break-word',
                      fontSize: '0.95rem'
                    }}>
                      {msg.text}
                    </div>

                    <span style={{
                      fontSize: '0.68rem',
                      color: 'var(--text-dim)',
                      marginTop: '4px',
                      marginRight: isMe ? '4px' : '0',
                      marginLeft: isMe ? '0' : '4px'
                    }}>
                      {msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                    </span>
                  </div>
                );
              })
            )}

            {/* Typing Banner */}
            {activeTypingCount > 0 && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '0.8rem',
                color: 'var(--accent-cyan)',
                fontStyle: 'italic',
                padding: '4px 8px'
              }}>
                <div className="typing-dots">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
                <span>{activeTypingNames} {activeTypingCount === 1 ? 'is' : 'are'} typing via P2P...</span>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Quick Emoji Bar & Input Bar */}
          <div className="glass-panel" style={{
            borderRadius: 0,
            borderLeft: 'none',
            borderRight: 'none',
            borderBottom: 'none',
            padding: '12px 20px'
          }}>
            {/* Quick Emojis */}
            <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', overflowX: 'auto' }}>
              {['🔥', '👍', '😂', '💀', '🎉', '❤️', '👀', '💯'].map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => addEmoji(emoji)}
                  style={{
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid var(--border-glass)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '4px 8px',
                    fontSize: '0.9rem',
                    cursor: 'pointer',
                    color: 'var(--text-main)',
                    transition: 'var(--transition-fast)'
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>

            {/* Input Form */}
            <form onSubmit={handleSendMessage} style={{ display: 'flex', gap: '10px' }}>
              <input
                type="text"
                className="input-glass"
                placeholder="Send P2P mesh encrypted message..."
                value={inputText}
                onChange={handleInputChange}
                autoFocus
              />
              <button type="submit" className="btn-primary" style={{ padding: '0 20px' }}>
                Send
              </button>
            </form>
          </div>
        </div>

        {/* P2P Mesh Peers List Drawer */}
        {showDrawer && (
          <div className="glass-panel" style={{
            width: '280px',
            borderRadius: 0,
            borderRight: 'none',
            borderTop: 'none',
            borderBottom: 'none',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            overflowY: 'auto'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 700 }}>Mesh Nodes</h3>
              <span className="badge-online" style={{ borderColor: 'rgba(6, 182, 212, 0.4)', color: 'var(--accent-cyan)' }}>
                {peerCount}
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {meshPeers.map((p) => {
                const isMe = p.peerId === peerId;
                return (
                  <div
                    key={p.peerId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '8px 12px',
                      borderRadius: 'var(--radius-sm)',
                      background: isMe ? 'rgba(139, 92, 246, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                      border: isMe ? '1px solid rgba(139, 92, 246, 0.3)' : '1px solid transparent'
                    }}
                  >
                    <span style={{ fontSize: '1.2rem' }}>{p.avatar}</span>
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <p style={{
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        color: p.color || 'var(--text-main)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}>
                        {p.alias} {isMe ? '(You)' : ''}
                      </p>
                      <span style={{ fontSize: '0.68rem', color: 'var(--accent-cyan)' }}>
                        {isMe ? 'Local Peer Node' : 'WebRTC Direct Link'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
