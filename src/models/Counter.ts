// app/models/Counter.ts
import mongoose, { Schema, Model } from "mongoose";

// Interface for the counter data
export interface ICounterData {
  _id: string;
  seq: number;
  date: Date;
  staffId?: string;
  department?: string;
  transactionTypes?: Record<string, number>;
  createdAt?: Date;
  updatedAt?: Date;
}

const CounterSchema = new Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
    date: { type: Date, required: true },
    // Written via $setOnInsert by the distribution actions; without these in
    // the schema, strict mode strips them and department-filtered counter
    // queries silently match nothing.
    staffId: { type: String, index: true },
    department: { type: String, index: true },
    transactionTypes: {
      type: Map,
      of: Number,
      default: {},
    },
  },
  {
    timestamps: true,
    _id: false, // Prevent auto-generation of ObjectId since we use String _id
  },
);

// Add indexes for better performance
CounterSchema.index({ date: 1 });
CounterSchema.index({ createdAt: 1 });

// Use type assertion to bypass the _id type conflict
const Counter: Model<any> =
  mongoose.models?.Counter || mongoose.model("Counter", CounterSchema);

export default Counter;
