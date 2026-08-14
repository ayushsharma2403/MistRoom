export class ChatWebSocket {
  constructor(groupId, memberId, onMessageCallback, onStateCallback, onTypingCallback, onAckCallback) {
    this.groupId = groupId;
    this.memberId = memberId;
    this.onMessageCallback = onMessageCallback;
    this.onStateCallback = onStateCallback;
    this.onTypingCallback = onTypingCallback;
    this.onAckCallback = onAckCallback;
    
    this.ws = null;
    this.isConnected = false;
    this.reconnectTimer = null;
  }

  connect() {
    const wsUrl = `ws://127.0.0.1:8000/ws/${this.groupId}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.isConnected = true;
      console.log(`[WebSocket] Connected to group ${this.groupId}`);
      
      // Send join handshake
      this.send({
        type: 'join',
        memberId: this.memberId
      });
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleEvent(data);
      } catch (err) {
        console.error('[WebSocket] Parse error:', err);
      }
    };

    this.ws.onclose = () => {
      this.isConnected = false;
      console.log('[WebSocket] Connection closed. Attempting reconnect in 3s...');
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[WebSocket] Error:', err);
      this.ws.close();
    };
  }

  handleEvent(data) {
    switch (data.type) {
      case 'joined_ack':
        if (this.onAckCallback) this.onAckCallback(data);
        break;
      case 'room_state':
        if (this.onStateCallback) this.onStateCallback(data);
        break;
      case 'newMessage':
        if (this.onMessageCallback) this.onMessageCallback(data);
        break;
      case 'user_typing':
        if (this.onTypingCallback) this.onTypingCallback(data);
        break;
      default:
        console.log('[WebSocket] Unhandled message:', data);
    }
  }

  send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  sendMessage(text) {
    this.send({
      type: 'sendMessage',
      text: text
    });
  }

  sendTypingStatus(isTyping) {
    this.send({
      type: 'typing',
      isTyping: isTyping
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.isConnected) {
        this.connect();
      }
    }, 3000);
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
    }
  }
}
