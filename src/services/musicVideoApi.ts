/**
 * Solframe Music Video API client (/api/musicvideo proxy).
 * Song in -> AI music video out: song generation or uploaded audio,
 * scene plan, stills, per-scene clips, final assembly.
 */

export interface MusicVideoConfig {
  ace: { url: string; configured: boolean };
  video: { ok: boolean };
  ffmpeg: { found: boolean };
}

export interface MusicVideoTitleCard {
  line1: string;
  line2: string;
}

export interface MusicVideoGenerateSong {
  enabled: boolean;
  duration: number;
  sampleMode: boolean;
  thinking: boolean;
}

export interface MusicVideoStartParams {
  title?: string;
  songPrompt?: string;
  audioBase64?: string;
  audioName?: string;
  lyrics?: string;
  lrc?: string;
  sceneCount?: number;
  stylePrompt?: string;
  resolution?: string;
  titleCard?: MusicVideoTitleCard;
  generateSong?: MusicVideoGenerateSong;
}

export type MusicVideoStage =
  | 'queued'
  | 'song'
  | 'plan'
  | 'stills'
  | 'clips'
  | 'assemble'
  | 'done'
  | 'error';

export interface MusicVideoScene {
  name: string;
  prompt: string;
  startTime: number;
  duration: number;
  stillUrl?: string;
  clipUrl?: string;
}

export interface MusicVideoResult {
  url: string;
  filename: string;
  duration_s: number;
  width: number;
  height: number;
}

export interface MusicVideoStatus {
  jobId: string;
  stage: MusicVideoStage;
  progress: number;
  message: string;
  scenes: MusicVideoScene[];
  result?: MusicVideoResult;
  error?: string;
}

async function json(res: Response): Promise<any> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}

export const musicVideoService = {
  async config(): Promise<MusicVideoConfig | null> {
    try {
      const r = await fetch('/api/musicvideo/config');
      return await json(r);
    } catch {
      return null;
    }
  },

  async start(params: MusicVideoStartParams): Promise<string> {
    const r = await fetch('/api/musicvideo/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const d = await json(r);
    if (!r.ok) {
      throw new Error(d?.error || `music video start failed (HTTP ${r.status})`);
    }
    const jobId = d?.jobId;
    if (!jobId) throw new Error('music video server returned no jobId');
    return String(jobId);
  },

  async status(jobId: string): Promise<MusicVideoStatus> {
    const r = await fetch(`/api/musicvideo/status?job=${encodeURIComponent(jobId)}`);
    const d = await json(r);
    if (!r.ok) {
      throw new Error(d?.error || `music video status failed (HTTP ${r.status})`);
    }
    return d as MusicVideoStatus;
  },

  async cancel(jobId: string): Promise<boolean> {
    try {
      const r = await fetch(`/api/musicvideo/cancel?job=${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
      });
      return r.ok;
    } catch {
      return false;
    }
  },

  fileUrl(name: string): string {
    return `/api/musicvideo/file/${encodeURIComponent(name)}`;
  },
};
