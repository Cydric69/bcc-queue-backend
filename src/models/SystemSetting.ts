// models/SystemSetting.ts
import mongoose, { Schema, Model } from "mongoose";

export const SYSTEM_SETTINGS_ID = "global";

export interface ISystemSetting {
  _id: string;
  queueOpen: boolean;
  defaultDailyLimit: number;
  defaultOpenTime: string;
  defaultCloseTime: string;
  defaultBreaks: { start: string; end: string; label: string }[];
  updatedBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const SystemSettingSchema = new Schema(
  {
    _id: { type: String, required: true },
    queueOpen: { type: Boolean, default: true },
    defaultDailyLimit: { type: Number, default: 500, min: 1, max: 500 },
    defaultOpenTime: { type: String, default: "08:00" },
    defaultCloseTime: { type: String, default: "17:00" },
    defaultBreaks: {
      type: [
        {
          _id: false,
          start: { type: String, required: true },
          end: { type: String, required: true },
          label: { type: String, default: "" },
        },
      ],
      default: [],
    },
    updatedBy: { type: String, default: "" },
  },
  {
    timestamps: true,
    _id: false,
  },
);

const SystemSetting: Model<any> =
  mongoose.models?.SystemSetting ||
  mongoose.model("SystemSetting", SystemSettingSchema);

export default SystemSetting;
