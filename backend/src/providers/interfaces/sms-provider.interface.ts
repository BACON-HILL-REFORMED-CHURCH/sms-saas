// ============================================================
// ISmsProvider — the contract every provider adapter must fulfill
//
// Adding a new provider (e.g. TextVerified):
//   1. Create backend/src/providers/adapters/textverified.provider.ts
//   2. Implement this interface
//   3. Register in providers.module.ts
//   No other files need to change. ✅
// ============================================================

export interface IProviderNumber {
  externalId: string;     // Provider's ID for this activation
  phoneNumber: string;    // The virtual phone number (+1...)
  cost: number;           // Cost in cents (provider base price, before margin)
}

export interface IProviderSMS {
  code: string | null;    // Extracted OTP / code (null if not yet received)
  fullText: string | null;// Complete SMS body
}

export interface IProviderService {
  name: string;           // Slug: "telegram", "whatsapp", "google"
  displayName: string;    // Human label: "Telegram"
  price: number;          // Base price in cents
  count: number;          // Available numbers
}

export interface ISmsProvider {
  /** Unique identifier used to reference this provider */
  readonly name: string;

  /** Rent a virtual number for a given service + country */
  getNumber(service: string, country: string): Promise<IProviderNumber>;

  /** Poll for received SMS — returns null code if SMS not yet arrived */
  getSMS(externalId: string): Promise<IProviderSMS>;

  /** Cancel / release the activation (triggers refund on some providers) */
  cancel(externalId: string): Promise<void>;

  /** List available services with prices for a given country */
  listServices(country: string): Promise<IProviderService[]>;
}
