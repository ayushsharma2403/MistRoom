from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime

class GroupCreate(BaseModel):
    name: Optional[str] = Field(None, description="Optional custom name for the anonymous room")

class GroupResponse(BaseModel):
    groupId: str
    name: str
    createdAt: str

class MessageCreate(BaseModel):
    groupId: str
    text: str
    senderId: Optional[str] = None
    senderName: Optional[str] = "Anonymous"
    avatar: Optional[str] = "👻"
    color: Optional[str] = "#a855f7"

class MessageResponse(BaseModel):
    id: str
    groupId: str
    text: str
    senderId: str
    senderName: str
    avatar: str
    color: str
    timestamp: str

class MemberInfo(BaseModel):
    memberId: str
    alias: str
    avatar: str
    color: str
    joinedAt: str
