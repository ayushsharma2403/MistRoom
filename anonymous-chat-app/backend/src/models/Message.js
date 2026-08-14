import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
    groupId: {
        type: String,
        required: true
    },
    text: {
        type: String,
        required: true
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
    // No senderId --> anonymity preserved
});

export default mongoose.models.Message || mongoose.model("Message", messageSchema);
