import os
import asyncio
from datetime import datetime
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv()

MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017/CloakRoom")

mongo_client = None
db = None
is_mongo_connected = False

# Fallback in-memory storage if MongoDB is not available locally
memory_groups = {}  # groupId -> group_dict
memory_messages = {} # groupId -> list of message_dicts

async def init_db():
    global mongo_client, db, is_mongo_connected
    try:
        mongo_client = AsyncIOMotorClient(MONGO_URI, serverSelectionTimeoutMS=2000)
        # Test connection
        await mongo_client.admin.command('ping')
        db = mongo_client.get_default_database()
        if db is None or db.name == "admin":
            db = mongo_client["CloakRoom"]
        is_mongo_connected = True
        print(f"[Database] Connected to MongoDB at {MONGO_URI}")
    except Exception as e:
        is_mongo_connected = False
        print(f"[Database] MongoDB unavailable ({e}). Operating in resilient In-Memory mode.")

# Group Data Access
async def save_group(group_data: dict):
    if is_mongo_connected:
        try:
            await db["groups"].insert_one(group_data)
            return
        except Exception as e:
            print(f"[Database Error] Failed to save group to Mongo: {e}")
    memory_groups[group_data["groupId"]] = group_data

async def get_group(group_id: str):
    if is_mongo_connected:
        try:
            group = await db["groups"].find_one({"groupId": group_id}, {"_id": 0})
            if group:
                return group
        except Exception as e:
            print(f"[Database Error] Mongo get_group failed: {e}")
    return memory_groups.get(group_id)

async def get_all_groups():
    if is_mongo_connected:
        try:
            cursor = db["groups"].find({}, {"_id": 0}).sort("createdAt", -1).limit(50)
            return await cursor.to_list(length=50)
        except Exception as e:
            print(f"[Database Error] Mongo get_all_groups failed: {e}")
    groups = list(memory_groups.values())
    groups.sort(key=lambda g: g.get("createdAt", ""), reverse=True)
    return groups

# Message Data Access
async def save_message(msg_data: dict):
    if is_mongo_connected:
        try:
            await db["messages"].insert_one(msg_data)
            return
        except Exception as e:
            print(f"[Database Error] Mongo save_message failed: {e}")
    
    gid = msg_data["groupId"]
    if gid not in memory_messages:
        memory_messages[gid] = []
    memory_messages[gid].append(msg_data)

async def get_group_messages(group_id: str, limit: int = 100):
    if is_mongo_connected:
        try:
            cursor = db["messages"].find({"groupId": group_id}, {"_id": 0}).sort("timestamp", 1).limit(limit)
            return await cursor.to_list(length=limit)
        except Exception as e:
            print(f"[Database Error] Mongo get_group_messages failed: {e}")
    
    return memory_messages.get(group_id, [])[-limit:]
