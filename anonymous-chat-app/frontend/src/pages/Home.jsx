import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { createGroup, getGroups } from '../services/api';

export default function Home() {
  const [roomName, setRoomName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [recentRooms, setRecentRooms] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    fetchRecentRooms();
  }, []);

  const fetchRecentRooms = async () => {
    try {
      const data = await getGroups();
      setRecentRooms(data.slice(0, 6));
    } catch (err) {
      console.error('Failed to load recent rooms:', err);
    }
  };

  const handleCreateRoom = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const result = await createGroup(roomName);
      if (result && result.groupId) {
        navigate(`/group/${result.groupId}`);
      }
    } catch (err) {
      setError('Failed to create room. Please try again.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleJoinRoom = (e) => {
    e.preventDefault();
    const cleanCode = joinCode.trim().toLowerCase();
    if (!cleanCode) {
      setError('Please enter a valid room code.');
      return;
    }
    navigate(`/group/${cleanCode}`);
  };

  return (
    <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '40px 20px' }}>
      {/* Header / Hero */}
      <div style={{ textAlign: 'center', marginBottom: '48px' }}>
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          background: 'rgba(139, 92, 246, 0.1)',
          border: '1px solid rgba(139, 92, 246, 0.3)',
          padding: '6px 16px',
          borderRadius: '9999px',
          color: '#c084fc',
          fontSize: '0.85rem',
          fontWeight: 600,
          marginBottom: '20px'
        }}>
          <span>🛡️</span> Zero Logs &bull; Instant WebSockets &bull; Fully Anonymous
        </div>

        <h1 style={{
          fontSize: '3rem',
          fontWeight: 800,
          background: 'linear-gradient(135deg, #ffffff 0%, #a855f7 50%, #06b6d4 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          marginBottom: '16px',
          letterSpacing: '-1px'
        }}>
          CloakRoom
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '1.15rem', maxWidth: '600px', margin: '0 auto' }}>
          Create instant, disposable anonymous chat rooms in seconds. No sign-ups, no passwords, no digital paper trail.
        </p>
      </div>

      {error && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.15)',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          color: '#fca5a5',
          padding: '12px 18px',
          borderRadius: 'var(--radius-md)',
          marginBottom: '24px',
          textAlign: 'center',
          fontSize: '0.95rem'
        }}>
          ⚠️ {error}
        </div>
      )}

      {/* Main Action Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gap: '24px',
        marginBottom: '48px'
      }}>
        {/* Create Room Card */}
        <div className="glass-panel" style={{ padding: '32px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
            <span style={{ fontSize: '1.8rem' }}>⚡</span>
            <div>
              <h2 style={{ fontSize: '1.3rem', fontWeight: 700 }}>Create a Secret Room</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Start a fresh anonymous group space</p>
            </div>
          </div>

          <form onSubmit={handleCreateRoom} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '8px' }}>
                Room Name (Optional)
              </label>
              <input
                type="text"
                className="input-glass"
                placeholder="e.g. Cyberpunk Lounge, Secret Ops"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                maxLength={40}
              />
            </div>

            <button type="submit" className="btn-primary" disabled={loading} style={{ width: '100%' }}>
              {loading ? 'Creating Room...' : '🚀 Create Room Now'}
            </button>
          </form>
        </div>

        {/* Join Room Card */}
        <div className="glass-panel" style={{ padding: '32px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
            <span style={{ fontSize: '1.8rem' }}>🔑</span>
            <div>
              <h2 style={{ fontSize: '1.3rem', fontWeight: 700 }}>Join via Room Code</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Enter a 6-character invite code</p>
            </div>
          </div>

          <form onSubmit={handleJoinRoom} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '8px' }}>
                Room Code
              </label>
              <input
                type="text"
                className="input-glass"
                placeholder="e.g. x8k9m2"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                style={{ fontFamily: 'var(--font-mono)', letterSpacing: '2px', textTransform: 'lowercase' }}
                maxLength={10}
              />
            </div>

            <button type="submit" className="btn-secondary" style={{ width: '100%' }}>
              👉 Join Room
            </button>
          </form>
        </div>
      </div>

      {/* Public / Recent Rooms */}
      {recentRooms.length > 0 && (
        <div style={{ marginTop: '32px' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '16px' }}>
            🌐 Recent Public Sanctums
          </h3>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: '16px'
          }}>
            {recentRooms.map((room) => (
              <div
                key={room.groupId}
                className="glass-card"
                onClick={() => navigate(`/group/${room.groupId}`)}
                style={{ padding: '20px', cursor: 'pointer' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                  <h4 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-main)' }}>{room.name}</h4>
                  <span className="code-badge">{room.groupId}</span>
                </div>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                  Created {new Date(room.createdAt).toLocaleDateString()}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
