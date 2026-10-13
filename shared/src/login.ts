import type { Evidence, StepResult } from './index.js';

export const DEMO_LOGIN_USERNAME = 'owner';
export const DEMO_LOGIN_PASSWORD = 'BizPlus@123';
export type LoginSource = 'login' | 'live_test';
export interface LoginConfig {
  mode: 'controlled_demo'; demo: true; manualOnly: true; defaultCredentials: boolean; customCredentials: boolean;
  /** These public synthetic defaults are omitted when backend credentials are configured. */
  username?: string; password?: string;
}
export interface LoginRequest { username: string; password: string; source?: LoginSource; incidentId?: string; labRevision?: string }
export interface LoginRecoveryResult {
  id: string; status: 'verified' | 'failed'; actor: 'human'; attemptedAt: string; completedAt: string; durationMs: number;
  verification: StepResult; evidence: Evidence[];
}
export interface LoginIncidentContext { source: LoginSource; manualOnly: true; labRevision?: string }
export interface LoginResult {
  status: 'successful' | 'rejected'; message: string; runId: string; incidentId: string | null;
  error?: string; code?: 'LOGIN_REJECTED'; recovery?: LoginRecoveryResult;
}
