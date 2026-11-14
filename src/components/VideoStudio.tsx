import React, { useState, useEffect, useRef } from 'react';
import { Download, Film, Play, RefreshCw, Sparkles, Upload, X } from 'lucide-react';
import {
  videoService,
  VideoModelInfo,
  VideoResult,
  VideoFileInfo,
} from '../services/videoApi';

interface VideoStudioProps {
  onError: (title: string, message: string) => void;
  onGenerateStart?: () => void;
  onGenerateEnd?: () => void;
  onSuccess?: (title: string, message: string) => void;
}

const RESOLUTIONS = [
  { label: '704 × 480', value: '704x480', note: 'LTX 12GB-safe' },
  { label: '832 × 480', value: '832x480', note: 'Wan 12GB-safe' },
  { label: '1280 × 720', value: '1280x720', note: 'Wan HD (may OOM)' },
];

export const VideoStudio: React.FC<VideoStudioProps> = ({
  onError,
  onGenerateStart,
  onGenerateEnd,
  onSuccess,
}) => {
  const [models, setModels] = useState<VideoModelInfo[]>([]);
  const [modelId, setModelId] = useState<string>('ltx-video-2b-0.9.5');
  const [serverOk, setServerOk] = useState<boolean>(false);
  const [serverBusy, setServerBusy] = useState<boolean>(false);
  const [serverJob, setServerJob] = useState<string>('');
  const [serverErr, setServerErr] = useState<string>('');

  const [prompt, setPrompt] = useState<string>(
    'A slow cinematic dolly shot across a neon-lit rainy street at night, reflections on wet asphalt, volumetric haze, film grain'
  );
  const [negativePrompt, setNegativePrompt] = useState<string>('blurry, distorted, watermark, text overlay, flickering');
  const [seconds, setSeconds] = useState<number>(10);
  const [fps, setFps] = useState<number>(24);
  const [resolution, setResolution] = useState<string>('704x480');
  const [steps, setSteps] = useState<number>(40);
  const [guidance, setGuidance] = useState<number>(3.0);
  const [chunkSeconds, setChunkSeconds] = useState<number>(5);
  const [seed, setSeed] = useState<number>(-1);

  const [firstFrame, setFirstFrame] = useState<string>('');
  const firstFrameName = useRef<string>('');

  const [generating, setGenerating] = useState<boolean>(false);
  const [elapsed, setElapsed] = useState<number>(0);
  const [current, setCurrent] = useState<VideoResult | null>(null);
  const [files, setFiles] = useState<VideoFileInfo[]>([]);

  // ─── Boot: models + health + files ─────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const h = await videoService.health();
      setServerOk(!!h.ok);
      setServerBusy(!!h.busy);
      setServerJob(h.job || '');
      setServerErr(h.error || '');
      const ms = await videoService.models();
      setModels(ms);
      if (ms.length && !ms.some(m => m.id === modelId)) setModelId(ms[0].id);
      refreshFiles();
    })();
  }, []);

  // Poll server status while idle/generating
  useEffect(() => {
    const iv = setInterval(async () => {
      const h = await videoService.health();
      setServerOk(!!h.ok);
      setServerBusy(!!h.busy);
      setServerJob(h.job || '');
      if (h.ok) setServerErr('');
    }, 5000);
    return () => clearInterval(iv);
  }, []);

  // Elapsed timer during generation
  useEffect(() => {
    if (!generating) return;
    const started = Date.now() - elapsed * 1000;
    const iv = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [generating]);

  const refreshFiles = async () => {
    const f = await videoService.files();
    setFiles(f);
  };

  const activeModel = models.find(m => m.id === modelId);
  const maxSeconds = activeModel?.video?.max_seconds || 60;

  const applyModelDefaults = (id: string) => {
    setModelId(id);
    const m = models.find(x => x.id === id);
    if (m?.video?.recommended_resolution) {
      const rec = m.video.recommended_resolution.split('(')[0].trim();
      if (RESOLUTIONS.some(r => r.value === rec)) setResolution(rec);
    }
    if (m?.video?.default_steps) setSteps(m.video.default_steps);
    if (m?.video?.default_guidance) setGuidance(m.video.default_guidance);
    setSeconds(s => Math.min(s, m?.video?.max_seconds || 60));
  };

  const handleFirstFrameUpload = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      firstFrameName.current = file.name;
      setFirstFrame(String(reader.result || ''));
    };
    reader.readAsDataURL(file);
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      onError('Missing Prompt', 'Describe the video you want to generate.');
      return;
    }
    if (generating) return;
    setGenerating(true);
    setElapsed(0);
    onGenerateStart?.();
    try {
      const result = await videoService.generate({
        prompt: prompt.trim(),
        negative_prompt: negativePrompt.trim() || undefined,
        first_frame: firstFrame || undefined,
        seconds,
        fps,
        resolution,
        model: modelId,
        seed: seed >= 0 ? seed : undefined,
        steps,
        guidance_scale: guidance,
        chunk_seconds: chunkSeconds,
      });
      setCurrent(result);
      refreshFiles();
      onSuccess?.(
        'Video Generated',
        `${result.duration_s}s @ ${result.width}x${result.height}, ${result.segments} segment(s) — saved to outputs/videos`
      );
    } catch (err: any) {
      onError('Video Generation Error', err.message || 'Generation failed on the video server.');
    } finally {
      setGenerating(false);
      onGenerateEnd?.();
    }
  };

  const fmtSize = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

  return (
    <div className="studio-layout">
      {/* ─── Canvas / Preview ─────────────────────────────────────────────── */}
      <div className="glass-panel studio-canvas" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="canvas-header" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Film size={16} />
          <span style={{ fontWeight: 700, fontSize: '13px' }}>Video Canvas</span>
          <span className={`badge-pill ${serverOk ? '' : 'btn-danger'}`} style={{ marginLeft: 'auto' }}>
            {serverOk ? (serverBusy ? 'BUSY' : 'ENGINE READY') : 'SERVER OFFLINE'}
          </span>
        </div>

        <div className="canvas-viewport" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '18px' }}>
          {generating ? (
            <div style={{ textAlign: 'center' }}>
              <div className="futuristic-spinner spin-anim" style={{ margin: '0 auto 14px' }} />
              <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: '18px' }}>
                Rendering {Math.floor(elapsed / 60)}m {elapsed % 60}s
              </div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '6px', maxWidth: '420px' }}>
                {serverJob ? `Segment chain: ${serverJob}…` : 'Chunked continuous I2V on 4070 Ti — segments conditioned on last frame'}
              </div>
            </div>
          ) : current ? (
            <video
              key={current.url}
              src={videoService.fileUrl(current.filename)}
              controls
              autoPlay
              loop
              style={{ width: '100%', maxHeight: '100%', borderRadius: '12px', background: '#000' }}
            />
          ) : (
            <div className="empty-canvas-state" style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
              <div className="empty-icon-circle" style={{ margin: '0 auto 12px' }}>
                <Play size={26} />
              </div>
              <div style={{ fontWeight: 600 }}>No video yet</div>
              <div style={{ fontSize: '12px', marginTop: '4px' }}>
                Write a prompt, pick a model and hit Generate. First frame is auto-drafted via the native FLUX GGUF lane.
              </div>
            </div>
          )}
        </div>

        {current && !generating && (
          <div style={{ display: 'flex', gap: '10px', padding: '0 18px 16px' }}>
            <a
              className="btn-secondary"
              href={videoService.fileUrl(current.filename)}
              download={current.filename}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', textDecoration: 'none' }}
            >
              <Download size={15} /> Download MP4
            </a>
            <button className="btn-secondary" onClick={refreshFiles} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
              <RefreshCw size={15} /> Refresh Library
            </button>
            <div className="spec-label" style={{ marginLeft: 'auto', alignSelf: 'center' }}>
              {current.model} · {current.segments} seg · {current.chunk_seconds}s chunks · {current.width}×{current.height} · {current.duration_s}s
            </div>
          </div>
        )}
      </div>

      {/* ─── Controls ─────────────────────────────────────────────────────── */}
      <div className="glass-panel studio-controls" style={{ overflowY: 'auto' }}>
        <div className="control-group">
          <div className="control-label">Video Engine</div>
          <div className="ratio-grid">
            {models.map(m => (
              <button
                key={m.id}
                className={`ratio-btn ${modelId === m.id ? 'active' : ''}`}
                onClick={() => applyModelDefaults(m.id)}
                title={m.video?.pipeline || m.id}
              >
                <Sparkles size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
                {m.id.replace('ltx-video-2b-0.9.5', 'LTX-Video 2B').replace('wan2.2-ti2v-5b', 'Wan 2.2 TI2V 5B').replace('minimax-h3-freevideo', 'MiniMax H3')}
              </button>
            ))}
            {!models.length && (
              <button className="ratio-btn active">
                <Sparkles size={13} style={{ marginRight: 6, verticalAlign: -2 }} /> LTX-Video 2B
              </button>
            )}
          </div>
          {activeModel?.video?.repo && (
            <div style={{ color: 'var(--text-secondary)', fontSize: '11px', marginTop: '6px' }}>
              {activeModel.video.repo} · {activeModel.video.pipeline}
            </div>
          )}
        </div>

        <div className="control-group">
          <div className="control-label">Prompt</div>
          <textarea
            className="styled-textarea"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the shot: subject, camera move, lighting, mood…"
          />
        </div>

        <div className="control-group">
          <div className="control-label">Negative Prompt</div>
          <textarea
            className="styled-textarea"
            rows={2}
            value={negativePrompt}
            onChange={(e) => setNegativePrompt(e.target.value)}
          />
        </div>

        <div className="control-group">
          <div className="control-label">
            Duration: {seconds}s · {fps}fps
            {activeModel?.video?.max_seconds ? '' : ` · ${Math.max(1, Math.ceil(seconds / Math.max(1, chunkSeconds)))} segment(s)`}
          </div>
          <input
            className="slider-input"
            type="range"
            min={2}
            max={maxSeconds}
            step={1}
            value={seconds}
            onChange={(e) => setSeconds(Math.min(Number(e.target.value), maxSeconds))}
          />
        </div>

        <div className="control-group">
          <div className="control-label">Resolution</div>
          <div className="ratio-grid">
            {RESOLUTIONS.map(r => (
              <button
                key={r.value}
                className={`ratio-btn ${resolution === r.value ? 'active' : ''}`}
                onClick={() => setResolution(r.value)}
                title={r.note}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <div className="control-label">Sampling</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>Steps: {steps}</div>
              <input className="slider-input" type="range" min={8} max={60} step={2} value={steps}
                onChange={(e) => setSteps(Number(e.target.value))} />
            </div>
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>Guidance: {guidance.toFixed(1)}</div>
              <input className="slider-input" type="range" min={1} max={9} step={0.5} value={guidance}
                onChange={(e) => setGuidance(Number(e.target.value))} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '10px' }}>
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>Chunk length: {chunkSeconds}s</div>
              <input className="slider-input" type="range" min={1} max={5} step={1} value={chunkSeconds}
                onChange={(e) => setChunkSeconds(Number(e.target.value))} />
            </div>
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>Seed (-1 = random)</div>
              <input className="styled-input" type="number" value={seed}
                onChange={(e) => setSeed(Number(e.target.value) || -1)} />
            </div>
          </div>
        </div>

        <div className="control-group">
          <div className="control-label">First Frame (optional)</div>
          {firstFrame ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <img src={firstFrame} style={{ width: 84, height: 56, objectFit: 'cover', borderRadius: 8 }} />
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{firstFrameName.current || 'custom frame'}</span>
              <button className="icon-btn" onClick={() => setFirstFrame('')} title="Remove">
                <X size={14} />
              </button>
            </div>
          ) : (
            <label className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <Upload size={14} /> Upload image
              <input type="file" accept="image/*" style={{ display: 'none' }}
                onChange={(e) => handleFirstFrameUpload(e.target.files?.[0] || null)} />
            </label>
          )}
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '6px' }}>
            Empty → auto first frame via native FLUX GGUF lane, then every chunk carries motion from the last frame.
          </div>
        </div>

        <button
          className="generate-btn"
          onClick={handleGenerate}
          disabled={generating || serverBusy}
          style={{ marginTop: '4px' }}
        >
          {generating ? `Generating… ${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : serverBusy ? 'Engine busy — wait for current job' : 'Generate Video'}
        </button>

        {serverErr && (
          <div className="badge-pill btn-danger" style={{ marginTop: '10px', display: 'block', textAlign: 'center' }}>
            {serverErr}
          </div>
        )}

        {/* Generated library */}
        {files.length > 0 && (
          <div className="control-group" style={{ marginTop: '16px' }}>
            <div className="control-label">Generated Library ({files.length})</div>
            <div className="gallery-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
              {files.slice(0, 12).map(f => (
                <button
                  key={f.name}
                  className="gallery-card"
                  style={{ textAlign: 'left', padding: '8px' }}
                  onClick={() => setCurrent({
                    url: f.url, filename: f.name, model: modelId, segments: 0,
                    chunk_seconds: chunkSeconds, segment_frames: 0, fps,
                    width: 0, height: 0, duration_s: 0,
                  })}
                  title={`${f.name} · ${fmtSize(f.size_bytes)}`}
                >
                  <div style={{ fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <Film size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                    {f.name}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                    {fmtSize(f.size_bytes)} · {new Date(f.modified).toLocaleString()}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default VideoStudio;
