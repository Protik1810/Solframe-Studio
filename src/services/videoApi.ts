/**
 * Solframe Video Generation API client (port 8766 via /api/video proxy).
 */

export interface VideoModelInfo {
  id: string;
  owned_by?: string;
  video?: {
    pipeline?: string;
    repo?: string;
    native_clip_s?: number;
    fps?: number[];
    max_seconds?: number;
    recommended_resolution?: string;
    default_steps?: number;
    default_guidance?: number;
    chunking?: string;
    [k: string]: any;
  };
}

export interface VideoJobParams {
  prompt: string;
  negative_prompt?: string;
  first_frame?: string;   // http(s) URL, data: URL, local path or /v1/files/<name>
  seconds?: number;
  fps?: number;
  resolution?: string;    // "WxH"
  model?: string;
  seed?: number;
  steps?: number;
  guidance_scale?: number;
  chunk_seconds?: number;
}

export interface VideoResult {
  url: string;
  filename: string;
  model: string;
  segments: number;
  chunk_seconds: number;
  segment_frames: number;
  fps: number;
  width: number;
  height: number;
  duration_s: number;
  probe?: any;
}

export interface VideoFileInfo {
  name: string;
  url: string;
  size_bytes: number;
  modified: string;
}

async function json(res: Response): Promise<any> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}

export const videoService = {
  async health(): Promise<{ ok: boolean; busy?: boolean; job?: string; error?: string }> {
    try {
      const r = await fetch('/api/video/health');
      return await json(r);
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },

  async models(): Promise<VideoModelInfo[]> {
    try {
      const r = await fetch('/api/video/models');
      const d = await json(r);
      return d?.data || [];
    } catch {
      return [];
    }
  },

  async files(): Promise<VideoFileInfo[]> {
    try {
      const r = await fetch('/api/video/files');
      const d = await json(r);
      return d?.data || [];
    } catch {
      return [];
    }
  },

  fileUrl(name: string): string {
    return `/api/video/file/${encodeURIComponent(name)}`;
  },

  /** Long-running: resolves when generation completes (can be several minutes). */
  async generate(params: VideoJobParams): Promise<VideoResult> {
    const r = await fetch('/api/video/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const d = await json(r);
    if (!r.ok) {
      throw new Error(d?.error || `video generation failed (HTTP ${r.status})`);
    }
    const item = d?.data?.[0];
    if (!item) throw new Error('video server returned no data');
    return item as VideoResult;
  },
};
