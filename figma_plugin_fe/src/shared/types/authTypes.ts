// Shared authentication types used by both UI store and code state management
export interface PersistableAuthState {
  userId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: number | null;
  authProvider: 'FIGMA' | 'GITHUB' | 'AUTH0' | null;
}
