import React, { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { ImageStudio } from './components/ImageStudio';
import { VideoStudio } from './components/VideoStudio';
import { ChatStudio } from './components/ChatStudio';
import { ModelManager } from './components/ModelManager';
import { GalleryStudio, GalleryItem } from './components/GalleryStudio';
import { SettingsStudio } from './components/SettingsStudio';
import { AboutStudio } from './components/AboutStudio';
import { ErrorModal, ModalProps } from './components/ErrorModal';
import { llmService, LLMStatus } from './services/llmApi';
import './index.css';

export function App() {
  const [activeTab, setActiveTab] = useState<'image' | 'video' | 'chat' | 'gallery' | 'models' | 'about' | 'settings'>('image');

  // Backend Status
  const [llmStatus, setLlmStatus] = useState<LLMStatus>({ connected: false, type: 'embedded-llama', models: [] });

  // Gallery
  const [gallery, setGallery] = useState<GalleryItem[]>(() => {
    try {
      const saved = localStorage.getItem('solframe_gallery');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Cross-Studio Prompt Transfer
  const [studioPrompt, setStudioPrompt] = useState<string>('');

  // Modal Dialogue
  const [modal, setModal] = useState<ModalProps>({
    show: false,
    type: 'error',
    title: '',
    message: '',
    onClose: () => setModal(prev => ({ ...prev, show: false }))
  });

  // Library Health Status
  const [libraryData, setLibraryData] = useState<{
    allReady: boolean;
    missingCount: number;
  }>({
    allReady: true,
    missingCount: 0
  });

  const [isEngineRunning, setIsEngineRunning] = useState<boolean>(false);
  const [generationProgress, setGenerationProgress] = useState<{ step: number; total: number } | null>(null);
  // True once a generation finishes while the user was on a different tab —
  // drives the sidebar's "ready to view" badge, cleared as soon as they
  // actually look at the Image Studio tab.
  const [imageReady, setImageReady] = useState<boolean>(false);

  // Update Availability (checked once per session — see /api/check-update)
  const [updateInfo, setUpdateInfo] = useState<{ updateAvailable: boolean; latestVersion: string; releaseUrl: string } | null>(null);

  const checkLibrariesHealth = () => {
    fetch('/api/libraries-status')
      .then(res => res.json())
      .then(data => {
        setLibraryData({
          allReady: data.allReady !== undefined ? data.allReady : true,
          missingCount: data.missingCount || 0
        });
      })
      .catch(() => {});
  };

  // Initial Boot & Health Checks
  const refreshBackendStatus = async () => {
    checkLibrariesHealth();

    const lStatus = await llmService.detectBackend();
    setLlmStatus(lStatus);
  };

  useEffect(() => {
    refreshBackendStatus();
    const interval = setInterval(refreshBackendStatus, 15000);
    return () => clearInterval(interval);
  }, []);

  // Once per session — the backend itself caches this for an hour, and a
  // new release doesn't need sub-hour freshness.
  useEffect(() => {
    fetch('/api/check-update')
      .then(res => res.json())
      .then(data => {
        if (data.updateAvailable) {
          setUpdateInfo({ updateAvailable: true, latestVersion: data.latestVersion, releaseUrl: data.releaseUrl });
        }
      })
      .catch(() => {});
  }, []);

  // Download progress is tracked via polling /api/download-progress in ModelManager

  // Save gallery changes
  useEffect(() => {
    localStorage.setItem('solframe_gallery', JSON.stringify(gallery));
  }, [gallery]);

  useEffect(() => {
    if (activeTab === 'image') setImageReady(false);
  }, [activeTab]);

  const handleImageGenerated = (image: GalleryItem) => {
    setIsEngineRunning(false);
    setGallery(prev => [image, ...prev]);
    // Only flag "ready to view" if they're not already looking at the
    // canvas — otherwise the sidebar dial would flash a badge for a result
    // the user is staring at that very moment.
    setImageReady(activeTab !== 'image');
    triggerSuccess('Artwork Generated', `Saved to gallery: ${image.prompt.slice(0, 30)}...`);
  };

  const handleGenerateStart = () => {
    setIsEngineRunning(true);
    setImageReady(false);
    setGenerationProgress(null);
  };

  const handleGenerateEnd = () => {
    setIsEngineRunning(false);
  };

  const handleGenerateProgress = (progress: { step: number; total: number }) => {
    setGenerationProgress(progress);
  };

  const handleDeleteImage = (id: string) => {
    setGallery(prev => prev.filter(img => img.id !== id));
  };

  const handleReuseSettings = (item: GalleryItem) => {
    setStudioPrompt(item.prompt);
    setActiveTab('image');
  };

  const handleSendToImageStudio = (text: string) => {
    const cleaned = text.replace(/```(?:markdown|prompt|txt)?/g, '').replace(/```/g, '').trim();
    setStudioPrompt(cleaned);
    setActiveTab('image');
    setModal({
      show: true,
      type: 'success',
      title: 'Prompt Loaded to Image Studio',
      message: `Extracted prompt:\n\n"${cleaned.substring(0, 160)}..."`,
      onClose: () => setModal(prev => ({ ...prev, show: false }))
    });
  };

  const handleDownloadModel = async (url: string, filename: string, targetFolder: string) => {
    try {
      // Use backend curl downloader with live progress
      const res = await fetch('/api/download-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: url.replace('https://huggingface.co/', '').split('/resolve/')[0].split('/raw/')[0],
          filename: url.split('/resolve/main/')[1] || url.split('/raw/main/')[1] || filename,
          targetFolder,
          customFilename: filename
        })
      });
      const data = await res.json();
      if (data.success) {
        triggerSuccess('Download Started', `Downloading ${filename} to ${targetFolder}`);
        return;
      }
    } catch (e) {}

    // Fallback: direct browser download
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.target = '_blank';
    a.click();
  };

  const triggerError = (title: string, message: string) => {
    setModal({
      show: true,
      type: 'error',
      title,
      message,
      onClose: () => setModal(prev => ({ ...prev, show: false }))
    });
  };

  const triggerSuccess = (title: string, message: string) => {
    setModal({
      show: true,
      type: 'success',
      title,
      message,
      onClose: () => setModal(prev => ({ ...prev, show: false }))
    });
  };

  return (
    <div className="app-container">
      {/* Sidebar Navigation */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        isEngineRunning={isEngineRunning}
        librariesReady={libraryData.allReady}
        missingLibrariesCount={libraryData.missingCount}
        updateAvailable={!!updateInfo?.updateAvailable}
        generationProgress={generationProgress}
        imageReady={imageReady}
      />

      {/* Main Studio Viewport */}
      <main className="workspace-area">
        {/* Kept mounted (not conditionally rendered) so the generated image,
            in-flight generation, and form state survive switching tabs —
            only its visibility toggles, matching the request that a result
            stays until the user explicitly clears it. */}
        <div style={{ display: activeTab === 'image' ? 'contents' : 'none' }}>
          <ImageStudio
            onImageGenerated={handleImageGenerated}
            onError={triggerError}
            initialPrompt={studioPrompt}
            onGenerateStart={handleGenerateStart}
            onGenerateEnd={handleGenerateEnd}
            onGenerateProgress={handleGenerateProgress}
          />
        </div>

        {activeTab === 'video' && (
          <VideoStudio
            onError={triggerError}
            onSuccess={triggerSuccess}
            onGenerateStart={handleGenerateStart}
            onGenerateEnd={handleGenerateEnd}
          />
        )}

        {activeTab === 'chat' && (
          <ChatStudio
            llmStatus={llmStatus}
            onSendToImageStudio={handleSendToImageStudio}
            onError={triggerError}
            onNavigateToHub={() => setActiveTab('models')}
          />
        )}

        {activeTab === 'gallery' && (
          <GalleryStudio
            gallery={gallery}
            onDeleteImage={handleDeleteImage}
            onReuseSettings={handleReuseSettings}
          />
        )}

        {activeTab === 'models' && (
          <ModelManager
            onDownloadModel={handleDownloadModel}
            onNavigateToStudio={() => setActiveTab('image')}
            onNavigateToChat={() => setActiveTab('chat')}
            onSuccess={triggerSuccess}
            onError={triggerError}
          />
        )}

        {activeTab === 'about' && (
          <AboutStudio updateInfo={updateInfo} />
        )}

        {activeTab === 'settings' && (
          <SettingsStudio
            llmStatus={llmStatus}
            onRefreshStatus={refreshBackendStatus}
            onSuccess={triggerSuccess}
            onError={triggerError}
          />
        )}

      </main>

      {/* Global Dialog Modal */}
      <ErrorModal
        show={modal.show}
        type={modal.type}
        title={modal.title}
        message={modal.message}
        onClose={() => setModal(prev => ({ ...prev, show: false }))}
        actionText={modal.actionText}
        onAction={modal.onAction}
      />
    </div>
  );
}

export default App;
