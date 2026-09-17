// TransportStatusBar.tsx
// Shows live connection status for all transport tiers.

import React, { useEffect, useState } from 'react';
import { transportManager, type TransportStatus } from '../core/transport/TransportManager';

interface Props {
  fingerprint: string;
}

export const TransportStatusBar: React.FC<Props> = ({ fingerprint }) => {
  const [status, setStatus] = useState<TransportStatus>(transportManager.status);

  useEffect(() => {
    const unsub = transportManager.onStatusChange(setStatus);
    return unsub;
  }, []);

  const shortFp = fingerprint.slice(0, 8) + '…' + fingerprint.slice(-4);

  return (
    <header className="transport-bar">
      <span className="transport-bar__logo">MistRoom</span>

      <div className="transport-tier">
        <span className={`transport-tier__dot ${status.ws === 'connected' ? 'transport-tier__dot--on' : ''}`} />
        <span>Relay</span>
      </div>

      <div className="transport-tier">
        <span className={`transport-tier__dot ${status.webrtc > 0 ? 'transport-tier__dot--on' : ''}`} />
        <span>P2P {status.webrtc > 0 ? `(${status.webrtc})` : ''}</span>
      </div>

      <div className="transport-tier">
        <span className={`transport-tier__dot ${status.ble > 0 ? 'transport-tier__dot--partial' : ''}`} />
        <span>BLE {status.ble > 0 ? `(${status.ble})` : ''}</span>
      </div>

      <span className="identity-badge" title={fingerprint}>{shortFp}</span>
    </header>
  );
};
