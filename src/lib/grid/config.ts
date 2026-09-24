import Decimal from "decimal.js";
import { z } from "zod";

const positiveDecimal = z.string().min(1).max(40)
  .regex(/^\d+(\.\d+)?$/, "Use a positive decimal number")
  .refine(value => { try { return new Decimal(value).gt(0); } catch { return false; } }, "Must be greater than zero");

export const configSchema = z.object({
  anchor: positiveDecimal,
  interval: positiveDecimal,
  quantity: positiveDecimal,
  maxSteps: z.number().int().min(1).max(10000),
  spacing: z.enum(["absolute", "percentage"]),
  baseOverflow: z.enum(["pending", "cancel-nearest", "cancel-farthest", "allow"]),
}).strict().refine(config => {
  try { return config.spacing !== "absolute" || new Decimal(config.anchor).gt(new Decimal(config.interval).times(2)); }
  catch { return false; }
}, { message: "The two initial buy prices must be above zero", path: ["interval"] });

export const simulationSchema = z.object({
  config: configSchema,
  fills: z.array(z.object({
    orderId: z.string().regex(/^grid-\d+$/).max(30),
    cumulativeQuantity: positiveDecimal,
  }).strict()).max(500),
  stop: z.boolean().optional(),
}).strict();
