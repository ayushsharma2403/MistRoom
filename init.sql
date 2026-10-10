-- Database initialization schema for MistRoom
CREATE DATABASE IF NOT EXISTS mistroom CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE mistroom;

-- Rooms table
CREATE TABLE IF NOT EXISTS rooms (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(100) NOT NULL DEFAULT 'Main Mesh',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Ephemeral active peer presence table
CREATE TABLE IF NOT EXISTS active_peers (
    peer_id VARCHAR(64) PRIMARY KEY,
    room_id VARCHAR(64) NOT NULL DEFAULT 'default',
    nickname VARCHAR(64) NOT NULL,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_room (room_id)
) ENGINE=InnoDB;

-- Zero-Logging Ephemeral Encrypted Message Cache
-- Notice: only encrypted ciphertext, iv, and triage tags are stored.
-- No plaintext, no user IPs, no identifiable private data is ever retained.
CREATE TABLE IF NOT EXISTS ephemeral_messages (
    id VARCHAR(64) PRIMARY KEY,
    room_id VARCHAR(64) NOT NULL DEFAULT 'default',
    sender VARCHAR(64) NOT NULL,
    ciphertext TEXT NOT NULL,
    iv VARCHAR(64) NOT NULL,
    cat VARCHAR(32) NOT NULL DEFAULT 'general',
    prio INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_room_time (room_id, created_at)
) ENGINE=InnoDB;
