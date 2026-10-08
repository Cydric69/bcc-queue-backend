import mongoose, { Model } from "mongoose";

export interface ICounterBreak {
  start: string; // "HH:mm"
  end: string; // "HH:mm"
  label?: string;
}

export interface ICounterSettings {
  isOpen: boolean;
  openTime: string;
  closeTime: string;
  breaks: ICounterBreak[];
  dailyLimit: number;
}

export interface IStaffLite {
  roleName: string;
  status: "active" | "inactive" | "suspended";
  cashierWindow?: string;
  counterSettings?: Partial<ICounterSettings>;
}

const staffSchema = new mongoose.Schema<IStaffLite>(
  {
    roleName: String,
    status: String,
    cashierWindow: String,
    counterSettings: {
      isOpen: Boolean,
      openTime: String,
      closeTime: String,
      breaks: [{ _id: false, start: String, end: String, label: String }],
      dailyLimit: Number,
    },
  },
  { strict: false },
);

// Reuse the model if it is already registered
const Staff: Model<IStaffLite> =
  (mongoose.models.Staff as Model<IStaffLite>) ||
  mongoose.model<IStaffLite>("Staff", staffSchema);

export default Staff;
