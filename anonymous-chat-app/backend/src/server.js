import express from "express";
import http from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
import cors from "cors";
import mongoose from "mongoose";

import Message from "./models/Message.js";
import Member from "./models/Member.js";
import Group from "./models/Group.js";



dotenv.config();
const app = express();
const server = http.createServer(app);


// Allow frontend requests
app.use(cors());
app.use(express.json());


// Socket.io setup
const io = new Server(server, {
    cors: {
        origin: "*",    // allow all origins for now
        methods: ["GET", "POST"]
    }
});


// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("MongoDB connected"))
    .catch(err => console.error("MongoDB error: ", err));



// REST endpoint: fetch old messages
app.get("/messages/:groupId", async (req, res) => {
    try {
        const {groupId} = req.params;
        const messages = await Message.find({groupId}).sort({ timestamp: 1 });
        res.json(messages);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch messages" });
    }
    
})

// REST endpoint: create new group
app.post("/groups", async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ error: "Group name is required" });
        }

        // Use a short random id for the group; collisions are unlikely but still possible.
        const groupId = Math.random().toString(36).substring(2, 8);
        const group = new Group({ name: name.trim(), groupId });
        await group.save();

        res.json({ groupId, link: `/group/${groupId}` });
    } catch (err) {
        console.error("Error creating group:", err);
        res.status(500).json({ error: "Failed to create group" });
    }
});

// Show members for a group
app.get("/members/:groupId", async (req, res) => {
    try {
        const { groupId } = req.params;
        const members = await Member.find({ groupId });
        res.json(members);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch members" });
    }
});

// Add a member to a group (anonymous join)
app.post("/members", async (req, res) => {
    try {
        const { groupId, memberId } = req.body;
        if (!groupId || !memberId) {
            return res.status(400).json({ error: "groupId and memberId are required" });
        }

        // Upsert; do not create duplicates for the same member
        const member = await Member.findOneAndUpdate(
            { groupId, memberId },
            { $set: { joinedAt: new Date() } },
            { upsert: true, new: true }
        );

        res.json(member);
    } catch (err) {
        console.error("Error adding member:", err);
        res.status(500).json({ error: "Failed to add member" });
    }
});

// List of all groups
app.get("/groups", async (req, res) => {
    try {
        const groups = await Group.find().sort({ createdAt: -1 });
        res.json(groups);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch groups" });
    }
});

// Delete a group
app.delete("/groups/:groupId", async (req, res) => {
    try {
        const { groupId } = req.params;
        const deleted = await Group.findOneAndDelete({ groupId });

        if (!deleted) {
            return res.status(404).json({ error: "Group not found" });
        }

        res.json({ message: "Group deleted successfully" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to delete group" });
    }
});



// Socket.io events
io.on("connection", (socket) => {
    console.log("A user connected: ", socket.id);

    // Expect payload { groupId, memberId } so we can persist the anonymous member
    // `ack` is an optional callback from the client that confirms join is recorded.
    socket.on("joinGroup", async ({ groupId, memberId }, ack) => {
        socket.join(groupId);
        console.log(`User ${socket.id} joined group ${groupId}`);

        try {
            // Persist member join so the member list can be shown
            await Member.findOneAndUpdate(
                { groupId, memberId },
                { $set: { joinedAt: new Date() } },
                { upsert: true, new: true }
            );

            if (typeof ack === "function") {
                ack({ ok: true });
            }
        } catch (err) {
            console.error("Error saving member join:", err);
            if (typeof ack === "function") {
                ack({ ok: false, error: err.message });
            }
        }
    });

    socket.on("sendMessage", async ({ groupId, text }) => {
        try {
            // Save message in MongoDB (preserve timestamp)
            const msg = new Message({ groupId, text });
            await msg.save();

            // Broadcast message to group with saved timestamp and id
            io.to(groupId).emit("newMessage", {
                _id: msg._id,
                text: msg.text,
                timestamp: msg.timestamp
            });
        } catch (err) {
            console.error("Error saving message: ", err);
        }
    });

    socket.on("disconnect", () => {
        console.log("User disconnected: ", socket.id);
    });
});


// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});