/**
 * Tests for the Music Video API client (musicVideoApi.ts) — the /api/musicvideo
 * proxy contract: config, start (jobId extraction + error paths), status,
 * cancel, and file URL building. All fetch calls are mocked; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { musicVideoService } from '../services/musicVideoApi';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
  } as unknown as Response;
}

describe('musicVideoService', () => {
  it('config() returns the parsed config object', async () => {
    const cfg = {
      ace: { url: 'http://127.0.0.1:8001', configured: true },
      video: { ok: true },
      ffmpeg: { found: true }
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(cfg));
    await expect(musicVideoService.config()).resolves.toEqual(cfg);
    expect(fetchMock).toHaveBeenCalledWith('/api/musicvideo/config');
  });

  it('config() returns null when the backend is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(musicVideoService.config()).resolves.toBeNull();
  });

  it('config() returns {error} object shape for non-JSON bodies instead of throwing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('gateway timeout', false, 504));
    const cfg = await musicVideoService.config();
    expect(cfg).toEqual({ error: 'gateway timeout' });
  });

  it('start() POSTs the params and returns the jobId as a string', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ jobId: 42 }));
    const jobId = await musicVideoService.start({
      songPrompt: 'lofi code and tech',
      generateSong: { enabled: true, duration: 255, sampleMode: false, thinking: false }
    });
    expect(jobId).toBe('42');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/musicvideo/start');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).songPrompt).toBe('lofi code and tech');
  });

  it('start() throws with the server error message on failure', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'no video engine' }, false, 500));
    await expect(musicVideoService.start({})).rejects.toThrow('no video engine');
  });

  it('start() surfaces non-JSON error bodies as the thrown message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('plain text 502', false, 502));
    await expect(musicVideoService.start({})).rejects.toThrow('plain text 502');
  });

  it('start() throws when the response carries no jobId', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(musicVideoService.start({})).rejects.toThrow('no jobId');
  });

  it('status() encodes the jobId and returns the status object', async () => {
    const st = { jobId: 'j1', stage: 'clips', progress: 40, message: 'clip 2/3', scenes: [] };
    fetchMock.mockResolvedValueOnce(jsonResponse(st));
    await expect(musicVideoService.status('j 1')).resolves.toEqual(st);
    expect(fetchMock).toHaveBeenCalledWith('/api/musicvideo/status?job=j%201');
  });

  it('status() throws on HTTP failure with server error text', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'job vanished' }, false, 404));
    await expect(musicVideoService.status('gone')).rejects.toThrow('job vanished');
  });

  it('cancel() returns true on 2xx and false when unreachable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ canceled: true }));
    await expect(musicVideoService.cancel('j1')).resolves.toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/musicvideo/cancel?job=j1');
    fetchMock.mockRejectedValueOnce(new Error('down'));
    await expect(musicVideoService.cancel('j1')).resolves.toBe(false);
  });

  it('fileUrl() percent-encodes the file name', () => {
    expect(musicVideoService.fileUrl('night compile final.mp4')).toBe(
      '/api/musicvideo/file/night%20compile%20final.mp4'
    );
  });
});
