import type { Assertion } from './index.js';

export interface LiveTarget { id: string; name: string; url: string; expectedStatus: number; containsText?: string }
export interface LiveRun { id: string; targetId: string; url: string; status: 'queued' | 'running' | 'passed' | 'failed'; httpStatus: number | null; durationMs: number; startedAt: string; completedAt: string | null; error: string | null; message: string; assertions: Assertion[]; evidence: { responseBytes: number; title?: string; excerpt?: string }; fingerprint: string | null }
export interface LiveTargetList { targets: LiveTarget[]; configured: boolean }
export interface LiveRunList { runs: LiveRun[] }
