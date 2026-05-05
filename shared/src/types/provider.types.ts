// ============================================================
// Abstract Provider interface — every SMS provider must implement this
// ============================================================

export interface IProviderNumber {
  externalId: string;       // Provider's internal ID for this activation
  phoneNumber: string;      // The virtual phone number
  cost: number;             // Cost in cents
}

export interface IProviderSMS {
  code: string | null;      // null = not yet received
  fullText: string | null;  // Full SMS text
}

export interface IProviderService {
  name: string;             // e.g. "telegram"
  displayName: string;
  price: number;            // Provider base price (cents)
  count: number;            // Available numbers count
}

// The contract every provider adapter must fulfill
export interface ISmsProvider {
  readonly name: string;

  /** Rent a virtual number for a given service */
  getNumber(service: string, country: string): Promise<IProviderNumber>;

  /** Poll for received SMS */
  getSMS(externalId: string): Promise<IProviderSMS>;

  /** Cancel / release the number */
  cancel(externalId: string): Promise<void>;

  /** List available services + prices */
  listServices(country: string): Promise<IProviderService[]>;
}
