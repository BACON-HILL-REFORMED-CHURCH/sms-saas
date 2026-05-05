// ============================================================
// User & Role types shared between backend and frontend
// ============================================================

export enum UserRole {
  USER = 'USER',
  ADMIN = 'ADMIN',
}

export interface IUser {
  id: string;
  email: string;
  role: UserRole;
  balance: number;        // stored in cents to avoid float issues
  isEmailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Public-safe user object (no password)
export type PublicUser = Omit<IUser, never>;

export interface IRegisterPayload {
  email: string;
  password: string;
}

export interface ILoginPayload {
  email: string;
  password: string;
}

export interface IAuthResponse {
  accessToken: string;
  user: PublicUser;
}
