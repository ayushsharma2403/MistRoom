import mongoose from "mongoose";

const memberSchema = new mongoose.Schema({
    groupId: {
        type: String,
        required: true
    },
    memberId: {
        type: String,
        required: true
    },
    joinedAt: {
        type: Date,
        default: Date.now
    }
});

// Prevent duplicate entries for the same member in the same group
memberSchema.index({ groupId: 1, memberId: 1 }, { unique: true });

export default mongoose.models.Member || mongoose.model("Member", memberSchema);
