// ============================================================
// Order / SMS Activation types
// ============================================================

export enum OrderStatus {
  PENDING   = 'PENDING',    // Waiting for SMS
  RECEIVED  = 'RECEIVED',   // SMS received successfully
  CANCELED  = 'CANCELED',   // Canceled by user or timeout
  EXPIRED   = 'EXPIRED',    // Provider-side expiry
}

export interface IOrder {
  id: string;
  userId: string;
  provider: string;         // e.g. "mock", "5sim", "smsactivate"
  externalId: string;       // Provider-assigned order ID
  phoneNumber: string;
  service: string;          // e.g. "telegram", "whatsapp"
  country: string;
  status: OrderStatus;
  smsCode: string | null;   // Received SMS code
  price: number;            // Cost in cents
  createdAt: Date;
  updatedAt: Date;
}

export interface ICreateOrderPayload {
  service: string;
  country: string;
  provider?: string;        // Optional: let system choose best provider
}
