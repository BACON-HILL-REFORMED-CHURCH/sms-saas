// ============================================================
// Wallet & Transaction types
// ============================================================

export enum TransactionType {
  DEPOSIT   = 'DEPOSIT',    // User added funds
  DEBIT     = 'DEBIT',      // Funds used for activation
  REFUND    = 'REFUND',     // Refund after cancel
  ADMIN_ADJ = 'ADMIN_ADJ',  // Manual admin adjustment
}

export interface ITransaction {
  id: string;
  userId: string;
  type: TransactionType;
  amount: number;           // Positive = credit, negative = debit (cents)
  balanceAfter: number;     // Balance snapshot after operation
  description: string;
  orderId: string | null;   // Linked order (if applicable)
  createdAt: Date;
}

export interface IDepositPayload {
  amount: number;           // In cents
  method: 'manual' | 'crypto_mock';
}
