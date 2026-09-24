export type Side = "buy" | "sell";
export type BaseOverflow = "pending" | "cancel-nearest" | "cancel-farthest" | "allow";
export type Config = {
  anchor: string;
  interval: string;
  quantity: string;
  maxSteps: number;
  spacing: "absolute" | "percentage";
  baseOverflow: BaseOverflow;
};
export type Order = {
  id: string;
  side: Side;
  role: "base" | "target";
  level: number;
  price: string;
  quantity: string;
  filled: string;
  cancelPending: boolean;
};
export type Action = { kind: "place" | "cancel"; orderId: string };
export type Snapshot = {
  status: "new" | "running" | "stopping" | "stopped";
  filledSteps: number;
  stopReason: string | null;
  orders: Order[];
};
export type Fill = { orderId: string; cumulativeQuantity: string };
export type Simulation = Snapshot & { logs: string[] };
