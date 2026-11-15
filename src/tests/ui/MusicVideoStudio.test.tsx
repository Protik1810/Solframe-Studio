/**
 * Render tests for MusicVideoStudio — the Music Video Mode tab. Service calls
 * are mocked at the module boundary (same pattern as ModelManager.test.tsx);
 * verifies the config handshake, engine status badges, the idle canvas, and
 * the job lifecycle entry point (Generate -> jobId -> scene polling).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MusicVideoStudio } from '../../components/MusicVideoStudio';
import { musicVideoService } from '../../services/musicVideoApi';

vi.mock('../../services/musicVideoApi', () => ({
  musicVideoService: {
    config: vi.fn(),
    start: vi.fn(),
    status: vi.fn(),
    cancel: vi.fn(),
    fileUrl: vi.fn((name: string) => `/api/musicvideo/file/${encodeURIComponent(name)}`),
  },
}));

const okConfig = {
  ace: { url: 'http://127.0.0.1:8001', configured: true },
  video: { ok: true },
  ffmpeg: { found: true },
};

const midFlightStatus = {
  jobId: 'j1',
  stage: 'clips',
  progress: 55,
  message: 'rendering clip 2/3',
  scenes: [
    { name: 's01', prompt: 'workshop dawn', startTime: 0, duration: 12, stillUrl: '/x/s01.png' },
    { name: 's02', prompt: 'code rain', startTime: 12, duration: 14, stillUrl: '/x/s02.png' },
  ],
};

function renderStudio() {
  return render(
    <MusicVideoStudio
      onError={vi.fn()}
      onSuccess={vi.fn()}
      onGenerateStart={vi.fn()}
      onGenerateEnd={vi.fn()}
    />
  );
}

describe('MusicVideoStudio', () => {
  beforeEach(() => {
    (musicVideoService.config as any).mockResolvedValue(okConfig);
    (musicVideoService.start as any).mockResolvedValue('j1');
    (musicVideoService.status as any).mockResolvedValue({
      jobId: 'j1', stage: 'queued', progress: 0, message: 'queued', scenes: [],
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('fetches the backend config on mount and shows engine badges', async () => {
    renderStudio();
    expect(screen.getByText('Music Video Canvas')).toBeTruthy();
    await waitFor(() => expect(musicVideoService.config).toHaveBeenCalled());
    // with the mocked config all three engines report ready; badge text is
    // split across nodes ("ACE " + "ON"), so match on the whole document text
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/ACE\s*READY/i);
    });
    expect(document.body.textContent).toMatch(/VIDEO\s*OK/i);
  });

  it('shows FFMPEG MISSING when the backend reports it absent', async () => {
    (musicVideoService.config as any).mockResolvedValue({
      ace: { url: 'http://127.0.0.1:8001', configured: true },
      video: { ok: true },
      ffmpeg: { found: false },
    });
    renderStudio();
    // badge text is split across nodes ("ACE " + "ON"); match on the whole body
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/FFMPEG\s*MISSING/i);
    });
  });

  it('renders the idle canvas with the generate button before any job', async () => {
    renderStudio();
    expect(screen.getByText('Generate Music Video')).toBeTruthy();
    expect(screen.getByText(/no music video yet/i)).toBeTruthy();
  });

  it('starts a job on Generate and polls scenes into the canvas', { testTimeout: 12000 }, async () => {
    (musicVideoService.status as any).mockResolvedValue(midFlightStatus);
    renderStudio();
    await waitFor(() => expect(musicVideoService.config).toHaveBeenCalled());
    // the song prompt is required in generate mode — fill it, then click
    fireEvent.change(screen.getByPlaceholderText(/describe the song/i), {
      target: { value: 'lofi code and tech' },
    });
    fireEvent.click(screen.getByText('Generate Music Video'));
    await waitFor(() => expect(musicVideoService.start).toHaveBeenCalled(), { timeout: 3000 });
    expect((musicVideoService.start as any).mock.calls[0][0].songPrompt).toBe('lofi code and tech');
    // polling runs on a 2s interval; default waitFor timeout is 1s
    // scene rows render scene names (s01/s02) once clips stage is active;
    // polling runs on a 2s interval, so give it a wider window
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/Scene Plan \(2\)/);
    }, { timeout: 6000 });
    expect(document.body.textContent).toMatch(/s01/);
    expect(document.body.textContent).toMatch(/s02/);
  });
});
