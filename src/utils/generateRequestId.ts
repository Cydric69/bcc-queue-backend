// src/utils/generateRequestId.ts

/**
 * Generates a request ID in the format: DR-YYMM-XXXX
 * where YYMM = year+month, XXXX = zero-padded daily sequence.
 * Caller is responsible for uniqueness retry on collision.
 */
export function buildRequestId(seq: number, now = new Date()): string {
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const padded = String(seq).padStart(4, "0");
  return `DR-${yy}${mm}-${padded}`;
}

/**
 * Finds the next available sequence for the current month by looking at
 * the highest existing requestId.
 */
export async function nextRequestSequence(model: {
  findOne: Function;
}): Promise<number> {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `DR-${yy}${mm}-`;

  const last = await model
    .findOne({ requestId: { $regex: `^${prefix}` } })
    .sort({ requestId: -1 })
    .lean();

  if (!last?.requestId) return 1;
  const tail = last.requestId.slice(prefix.length);
  const n = parseInt(tail, 10);
  return Number.isFinite(n) ? n + 1 : 1;
}
