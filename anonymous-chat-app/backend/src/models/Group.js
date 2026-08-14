import mongoose from "mongoose";

const groupSchema = new mongoose.Schema({
    groupId: {
        type: String,
        unique: true
    },
    name: {
        type: String,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

export default mongoose.models.Group || mongoose.model("Group", groupSchema);
