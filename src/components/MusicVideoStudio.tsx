import { useState, useEffect, useRef } from 'react';
import { Check, ChevronDown, ChevronRight, Download, Film, Music, Play, Upload, X } from 'lucide-react';
import {
  musicVideoService,
  MusicVideoConfig,
  MusicVideoStatus,
  MusicVideoStage,
  MusicVideoScene,
  MusicVideoRuntimeInfo,
  MusicRuntimeDownloadState,
} from '../services/musicVideoApi';

type MusicRuntimeFull = MusicVideoRuntimeInfo & { download: MusicRuntimeDownloadState };

const fmtSize = (b: number): string => {
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(0)} MB`;
  return `${b} bytes`;
};

interface MusicVideoStudioProps {
  onError: (title: string, message: string) => void;
  onGenerateStart?: () => void;
  onGenerateEnd?: () => void;
  onSuccess?: (title: string, message: string) => void;
}

type SourceMode = 'generate' | 'upload';

const RESOLUTIONS = [
  { label: '704 × 480', value: '704x480' },
  { label: '1280 × 736', value: '1280x736' },
  { label: '1344 × 768', value: '1344x768' },
];

const STAGES: { key: MusicVideoStage; label: string }[] = [
  { key: 'song', label: 'Song' },
  { key: 'plan', label: 'Scene plan' },
  { key: 'stills', label: 'Stills' },
  { key: 'clips', label: 'Clips' },
  { key: 'assemble', label: 'Assemble' },
];

const DEFAULT_STYLE_PROMPT =
  'dark cinematic teal-green grade, moody workshop, volumetric light, no text, no watermark';

const stageIndex = (stage: MusicVideoStage): number => {
  if (stage === 'done') return STAGES.length;
  if (stage === 'error') return -1;
  const idx = STAGES.findIndex(s => s.key === stage);
  return idx === -1 ? -1 : idx;
};

const fmtTime = (s: number): string => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

export function MusicVideoStudio(props: MusicVideoStudioProps) {
  const { onError, onGenerateStart, onGenerateEnd, onSuccess } = props;

  const [config, setConfig] = useState<MusicVideoConfig | null>(null);

  // Source
  const [mode, setMode] = useState<SourceMode>('generate');
  const [songPrompt, setSongPrompt] = useState<string>('');
  const [duration, setDuration] = useState<number>(180);
  const [sampleMode, setSampleMode] = useState<boolean>(false);
  const [thinking, setThinking] = useState<boolean>(false);
  const [audioBase64, setAudioBase64] = useState<string>('');
  const [audioName, setAudioName] = useState<string>('');
  const [lyricsOpen, setLyricsOpen] = useState<boolean>(false);
  const [lyrics, setLyrics] = useState<string>('');
  const [lrc, setLrc] = useState<string>('');

  // Style
  const [stylePrompt, setStylePrompt] = useState<string>(DEFAULT_STYLE_PROMPT);
  const [sceneCount, setSceneCount] = useState<number>(9);
  const [resolution, setResolution] = useState<string>('704x480');
  const [titleLine1, setTitleLine1] = useState<string>('');
  const [titleLine2, setTitleLine2] = useState<string>('');

  // Job
  const [running, setRunning] = useState<boolean>(false);
  const [jobId, setJobId] = useState<string>('');
  const [status, setStatus] = useState<MusicVideoStatus | null>(null);
  const [elapsed, setElapsed] = useState<number>(0);
  const elapsedRef = useRef<number>(0);

  // ─── Boot: pipeline config ─────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const c = await musicVideoService.config();
      setConfig(c);
    })();
  }, []);

  // Music runtime setup: poll while it's not installed (covers download and
  // import progress); refresh config once it lands so the banner clears.
  const [runtime, setRuntime] = useState<MusicRuntimeFull | null>(null);
  const [importPath, setImportPath] = useState<string>('');
  useEffect(() => {
    let alive = true;
    let iv: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      const r = await musicVideoService.runtime();
      if (!alive) return;
      setRuntime(r);
      if (r?.installed) {
        const c = await musicVideoService.config();
        if (alive) setConfig(c);
        if (iv) { clearInterval(iv); iv = null; }
      }
    };
    tick();
    iv = setInterval(tick, 2000);
    return () => { alive = false; if (iv) clearInterval(iv); };
  }, []);

  // Poll job status every 2s while running; stops on done/error and on unmount
  useEffect(() => {
    if (!running || !jobId) return;
    let alive = true;
    let failures = 0;
    const tick = async () => {
      try {
        const s = await musicVideoService.status(jobId);
        if (!alive) return;
        failures = 0;
        setStatus(s);
        if (s.stage === 'done') {
          setRunning(false);
          onGenerateEnd?.();
          if (s.result) {
            onSuccess?.(
              'Music Video Ready',
              `${s.result.duration_s}s @ ${s.result.width}x${s.result.height} — ${s.result.filename}`
            );
          }
        } else if (s.stage === 'error') {
          setRunning(false);
          onGenerateEnd?.();
          onError('Music Video Error', s.error || 'Music video generation failed.');
        }
      } catch (err: any) {
        if (!alive) return;
        failures += 1;
        if (failures >= 3) {
          setRunning(false);
          onGenerateEnd?.();
          onError('Music Video Error', err.message || 'Lost contact with the music video server.');
        }
      }
    };
    tick();
    const iv = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, jobId]);

  // Elapsed timer during generation
  useEffect(() => {
    if (!running) return;
    elapsedRef.current = 0;
    setElapsed(0);
    const iv = setInterval(() => {
      elapsedRef.current += 1;
      setElapsed(elapsedRef.current);
    }, 1000);
    return () => clearInterval(iv);
  }, [running]);

  const handleAudioUpload = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
      setAudioBase64(base64);
      setAudioName(file.name);
    };
    reader.readAsDataURL(file);
  };

  const handleGenerate = async () => {
    if (running) return;
    if (runtime && !runtime.installed && runtime.download.phase !== 'ready') {
      onError(
        'Music Pipeline Not Installed',
        'The AI music engine needs a one-time ~2.0 GB runtime. Use the Music pipeline setup panel above to download it (or import a music-runtime.tar.xz you already have), then try again. It unpacks automatically on first use.'
      );
      return;
    }
    if (mode === 'generate' && !songPrompt.trim()) {
      onError('Missing Song Prompt', 'Describe the song you want the AI to generate.');
      return;
    }
    if (mode === 'upload' && !audioBase64) {
      onError('Missing Audio', 'Upload an audio file to build the music video from.');
      return;
    }
    setRunning(true);
    setJobId('');
    setStatus(null);
    setElapsed(0);
    onGenerateStart?.();
    try {
      const id = await musicVideoService.start({
        songPrompt: mode === 'generate' ? songPrompt.trim() : undefined,
        audioBase64: mode === 'upload' ? audioBase64 : undefined,
        audioName: mode === 'upload' ? audioName : undefined,
        lyrics: lyrics.trim() || undefined,
        lrc: lrc.trim() || undefined,
        sceneCount,
        stylePrompt: stylePrompt.trim() || undefined,
        resolution,
        titleCard:
          titleLine1.trim() || titleLine2.trim()
            ? { line1: titleLine1, line2: titleLine2 }
            : undefined,
        generateSong:
          mode === 'generate'
            ? { enabled: true, duration, sampleMode, thinking }
            : undefined,
      });
      setJobId(id);
    } catch (err: any) {
      onError('Music Video Error', err.message || 'Failed to start music video generation.');
      setRunning(false);
      onGenerateEnd?.();
    }
  };

  const handleCancel = async () => {
    if (jobId) await musicVideoService.cancel(jobId);
    setRunning(false);
    onGenerateEnd?.();
  };

  const currentIdx = status ? stageIndex(status.stage) : -1;
  const showSceneRows = !!(
    status &&
    status.scenes.length &&
    (status.stage === 'clips' || status.stage === 'assemble' || status.stage === 'done')
  );
  const aceOk = !!config?.ace.configured;
  const videoOk = !!config?.video.ok;
  const ffmpegOk = !!config?.ffmpeg.found;

  return (
    <div className="studio-layout">
      {/* ─── Canvas / Preview ─────────────────────────────────────────────── */}
      <div className="glass-panel studio-canvas" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="canvas-header" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Music size={16} />
          <span style={{ fontWeight: 700, fontSize: '13px' }}>Music Video Canvas</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
            <span className={`badge-pill ${aceOk ? '' : 'btn-danger'}`}>ACE {aceOk ? 'READY' : 'OFF'}</span>
            <span className={`badge-pill ${videoOk ? '' : 'btn-danger'}`}>VIDEO {videoOk ? 'OK' : 'OFF'}</span>
            <span className={`badge-pill ${ffmpegOk ? '' : 'btn-danger'}`}>FFMPEG {ffmpegOk ? 'OK' : 'MISSING'}</span>
          </div>
        </div>

        <div className="canvas-viewport" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '18px', overflowY: 'auto' }}>
          {running && status?.stage !== 'done' ? (
            <div style={{ width: '100%', maxWidth: '560px' }}>
              <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                <div className="futuristic-spinner spin-anim" style={{ margin: '0 auto 14px' }} />
                <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: '18px' }}>
                  Building {Math.floor(elapsed / 60)}m {elapsed % 60}s
                </div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '6px' }}>
                  {status?.message || 'Starting music video pipeline…'}
                </div>
              </div>

              {/* Stage step list */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {STAGES.map((s, i) => {
                  const done = currentIdx > i;
                  const active = currentIdx === i;
                  return (
                    <div
                      key={s.key}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        padding: '8px 12px',
                        borderRadius: '10px',
                        border: '1px solid',
                        borderColor: active
                          ? 'var(--accent, #4ade80)'
                          : done
                            ? 'rgba(74, 222, 128, 0.35)'
                            : 'rgba(255,255,255,0.08)',
                        color: active || done ? 'var(--text-primary, #fff)' : 'var(--text-secondary)',
                        fontWeight: active ? 700 : 500,
                        fontSize: '13px',
                      }}
                    >
                      {done ? (
                        <Check size={15} color="var(--accent, #4ade80)" />
                      ) : active ? (
                        <span className="futuristic-spinner spin-anim" style={{ width: 12, height: 12 }} />
                      ) : (
                        <span style={{ width: 12, height: 12, display: 'inline-block' }} />
                      )}
                      {s.label}
                      {active && status && (
                        <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text-secondary)' }}>
                          {status.progress}%
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Per-scene rows once clips start */}
              {showSceneRows && (
                <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {status!.scenes.map((sc, i) => (
                    <SceneRow key={`${sc.name}-${i}`} scene={sc} index={i} />
                  ))}
                </div>
              )}
            </div>
          ) : status?.stage === 'done' && status.result ? (
            <div style={{ width: '100%', maxWidth: '720px', textAlign: 'center' }}>
              <video
                key={status.result.url}
                src={status.result.url}
                controls
                autoPlay
                style={{ width: '100%', borderRadius: '12px', background: '#000' }}
              />
            </div>
          ) : (
            <div className="empty-canvas-state" style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
              <div className="empty-icon-circle" style={{ margin: '0 auto 12px' }}>
                <Play size={26} />
              </div>
              <div style={{ fontWeight: 600 }}>No music video yet</div>
              <div style={{ fontSize: '12px', marginTop: '4px' }}>
                Generate a song with AI or upload your own audio, then hit Generate — scenes, stills and clips are assembled automatically.
              </div>
            </div>
          )}
        </div>

        {status?.stage === 'done' && status.result && (
          <div style={{ display: 'flex', gap: '10px', padding: '0 18px 16px' }}>
            <a
              className="btn-secondary"
              href={status.result.url}
              download={status.result.filename}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', textDecoration: 'none' }}
            >
              <Download size={15} /> Download MP4
            </a>
            <div className="spec-label" style={{ marginLeft: 'auto', alignSelf: 'center' }}>
              {status.result.width}×{status.result.height} · {status.result.duration_s}s · {status.result.filename}
            </div>
          </div>
        )}

        {status?.stage === 'error' && (
          <div className="badge-pill btn-danger" style={{ margin: '0 18px 16px', display: 'block', textAlign: 'center' }}>
            {status.error || 'Generation failed.'}
          </div>
        )}
      </div>

      {/* ─── Controls ─────────────────────────────────────────────────────── */}
      <div className="glass-panel studio-controls" style={{ overflowY: 'auto' }}>
        {/* Music runtime setup — one-time download or import */}
        {runtime && !runtime.installed && (
          <div
            className="control-group"
            style={{
              border: '1px solid rgba(234, 179, 8, 0.35)',
              background: 'rgba(234, 179, 8, 0.08)',
              padding: '12px',
              borderRadius: '10px',
            }}
          >
            <div className="control-label" style={{ color: '#eab308' }}>
              <Download size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
              Music pipeline setup
            </div>
            {runtime.download.phase === 'downloading' || runtime.download.phase === 'importing' ? (
              <>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                  {runtime.download.phase === 'downloading' ? 'Downloading' : 'Importing'} music pipeline ({runtime.download.source === 'import' ? 'import' : 'from GitHub'}) —{' '}
                  {runtime.download.total ? `${fmtSize(runtime.download.received)} / ${fmtSize(runtime.download.total)}` : fmtSize(runtime.download.received)}
                </div>
                <div style={{ height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: runtime.download.total ? `${Math.min(100, (runtime.download.received / runtime.download.total) * 100)}%` : '100%',
                      background: 'var(--accent, #4ade80)',
                      transition: 'width 0.5s ease',
                      opacity: runtime.download.total ? 1 : 0.5,
                    }}
                  />
                </div>
              </>
            ) : runtime.download.phase === 'ready' ? (
              <div style={{ fontSize: '12px', color: 'var(--text-primary)' }}>
                ✓ Music pipeline downloaded — it unpacks automatically the first time you generate music.
              </div>
            ) : runtime.download.phase === 'error' ? (
              <>
                <div style={{ fontSize: '12px', color: '#f87171', marginBottom: '8px' }}>
                  {runtime.download.error || 'Music pipeline download failed.'}
                </div>
                <button
                  className="btn-primary"
                  style={{ fontSize: '12px', padding: '6px 14px' }}
                  onClick={() => musicVideoService.startRuntimeDownload()}
                >
                  Retry download
                </button>
              </>
            ) : runtime.archivePresent ? (
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                Music pipeline archive found ({fmtSize(runtime.archiveBytes)}) — it unpacks automatically on first use.
              </div>
            ) : (
              <>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                  Music generation needs a one-time <strong>~2.0 GB</strong> runtime download (AI song engine — model weights are separate and free).
                </div>
                <button
                  className="btn-primary"
                  style={{ fontSize: '12px', padding: '6px 14px', marginRight: '8px' }}
                  onClick={() => musicVideoService.startRuntimeDownload()}
                >
                  <Download size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                  Download music pipeline
                </button>
                <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                  <input
                    className="styled-input"
                    style={{ flex: 1, fontSize: '11px' }}
                    placeholder="…or import a downloaded music-runtime.tar.xz: paste its full path"
                    value={importPath}
                    onChange={(e) => setImportPath(e.target.value)}
                  />
                  <button
                    className="btn-secondary"
                    style={{ fontSize: '11px', padding: '4px 10px', whiteSpace: 'nowrap' }}
                    onClick={async () => {
                      if (!importPath.trim()) return;
                      const r = await musicVideoService.importRuntime(importPath.trim());
                      if (!r.ok) onError('Music Pipeline Import', r.error || 'Import failed.');
                    }}
                  >
                    Import
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {/* Source */}
        <div className="control-group">
          <div className="control-label">Audio Source</div>
          <div className="ratio-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <button
              className={`ratio-btn ${mode === 'generate' ? 'active' : ''}`}
              disabled={running}
              onClick={() => setMode('generate')}
            >
              <Music size={13} style={{ marginRight: 6, verticalAlign: -2 }} /> Generate with AI
            </button>
            <button
              className={`ratio-btn ${mode === 'upload' ? 'active' : ''}`}
              disabled={running}
              onClick={() => setMode('upload')}
            >
              <Upload size={13} style={{ marginRight: 6, verticalAlign: -2 }} /> Upload audio
            </button>
          </div>

          {mode === 'generate' ? (
            <>
              <textarea
                className="styled-textarea"
                rows={3}
                value={songPrompt}
                disabled={running}
                onChange={(e) => setSongPrompt(e.target.value)}
                placeholder="Describe the song: genre, mood, tempo, instruments…"
                style={{ marginTop: '10px' }}
              />
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '6px' }}>
                Duration: {duration}s
              </div>
              <input
                className="slider-input"
                type="range"
                min={10}
                max={600}
                step={5}
                value={duration}
                disabled={running}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
              <div style={{ display: 'flex', gap: '16px', marginTop: '8px' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={sampleMode} disabled={running} onChange={(e) => setSampleMode(e.target.checked)} />
                  Sample mode
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={thinking} disabled={running} onChange={(e) => setThinking(e.target.checked)} />
                  Thinking
                </label>
              </div>
            </>
          ) : (
            <div style={{ marginTop: '10px' }}>
              {audioBase64 ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <Music size={18} color="var(--accent, #4ade80)" />
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {audioName || 'audio'}
                  </span>
                  {!running && (
                    <button className="icon-btn" onClick={() => { setAudioBase64(''); setAudioName(''); }} title="Remove">
                      <X size={14} />
                    </button>
                  )}
                </div>
              ) : (
                <label className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <Upload size={14} /> Upload audio file
                  <input
                    type="file"
                    accept="audio/*"
                    style={{ display: 'none' }}
                    onChange={(e) => handleAudioUpload(e.target.files?.[0] || null)}
                  />
                </label>
              )}
            </div>
          )}
        </div>

        {/* Lyrics / LRC (optional, collapsible) */}
        <div className="control-group">
          <button
            className="btn-secondary"
            disabled={running}
            onClick={() => setLyricsOpen(o => !o)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', width: '100%', justifyContent: 'flex-start' }}
          >
            {lyricsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Lyrics &amp; LRC (optional)
          </button>
          {lyricsOpen && (
            <div style={{ marginTop: '10px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>Lyrics (plain text)</div>
              <textarea
                className="styled-textarea"
                rows={4}
                value={lyrics}
                disabled={running}
                onChange={(e) => setLyrics(e.target.value)}
                placeholder="Verse 1: …"
              />
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px', marginTop: '8px' }}>
                LRC (timed — preferred for alignment)
              </div>
              <textarea
                className="styled-textarea"
                rows={4}
                value={lrc}
                disabled={running}
                onChange={(e) => setLrc(e.target.value)}
                placeholder={'[00:12.00] First lyric line\n[00:17.50] Second lyric line'}
              />
            </div>
          )}
        </div>

        {/* Style */}
        <div className="control-group">
          <div className="control-label">Style Prompt</div>
          <textarea
            className="styled-textarea"
            rows={2}
            value={stylePrompt}
            disabled={running}
            onChange={(e) => setStylePrompt(e.target.value)}
            placeholder="dark cinematic teal-green grade, moody workshop…"
          />
        </div>

        <div className="control-group">
          <div className="control-label">Scenes: {sceneCount}</div>
          <input
            className="slider-input"
            type="range"
            min={4}
            max={19}
            step={1}
            value={sceneCount}
            disabled={running}
            onChange={(e) => setSceneCount(Number(e.target.value))}
          />
        </div>

        <div className="control-group">
          <div className="control-label">Resolution</div>
          <select
            className="select-input"
            value={resolution}
            disabled={running}
            onChange={(e) => setResolution(e.target.value)}
          >
            {RESOLUTIONS.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>

        <div className="control-group">
          <div className="control-label">Title Card (optional)</div>
          <input
            className="styled-input"
            value={titleLine1}
            disabled={running}
            onChange={(e) => setTitleLine1(e.target.value)}
            placeholder="Line 1"
          />
          <input
            className="styled-input"
            value={titleLine2}
            disabled={running}
            onChange={(e) => setTitleLine2(e.target.value)}
            placeholder="Line 2"
            style={{ marginTop: '8px' }}
          />
        </div>

        <button
          className="generate-btn"
          onClick={handleGenerate}
          disabled={running}
          style={{ marginTop: '4px' }}
        >
          {running ? `Building… ${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : 'Generate Music Video'}
        </button>

        {running && (
          <button
            className="btn-secondary"
            onClick={handleCancel}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', width: '100%', justifyContent: 'center', marginTop: '10px' }}
          >
            <X size={15} /> Cancel
          </button>
        )}

        {/* Scene table after clips */}
        {status && status.scenes.length > 0 && showSceneRows && (
          <div className="control-group" style={{ marginTop: '16px' }}>
            <div className="control-label">Scene Plan ({status.scenes.length})</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {status.scenes.map((sc, i) => (
                <SceneRow key={`${sc.name}-${i}`} scene={sc} index={i} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SceneRow({ scene, index }: { scene: MusicVideoScene; index: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '6px 10px',
        borderRadius: '10px',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      {scene.stillUrl ? (
        <img
          src={scene.stillUrl}
          alt={scene.name}
          style={{ width: 72, height: 48, objectFit: 'cover', borderRadius: 6, background: '#000' }}
        />
      ) : (
        <div
          style={{
            width: 72,
            height: 48,
            borderRadius: 6,
            background: 'rgba(255,255,255,0.05)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Film size={14} color="var(--text-secondary)" />
        </div>
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {index + 1}. {scene.name}
        </div>
        <div style={{ fontSize: '10px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {fmtTime(scene.startTime)} · {scene.duration}s
        </div>
      </div>
      {scene.clipUrl ? (
        <span className="badge-pill" style={{ fontSize: '10px' }}>
          <Check size={10} style={{ verticalAlign: -1, marginRight: 3 }} /> Clip
        </span>
      ) : scene.stillUrl ? (
        <span className="badge-pill" style={{ fontSize: '10px' }}>Still</span>
      ) : (
        <span className="badge-pill" style={{ fontSize: '10px' }}>Pending</span>
      )}
    </div>
  );
}

export default MusicVideoStudio;
