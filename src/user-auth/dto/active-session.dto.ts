export interface ActiveSessionDto {
  id: string;
  username: string;
  userAgent: string;
  browser: string;
  os: string;
  deviceType: string;
  ip?: string;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}
