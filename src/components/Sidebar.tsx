import React, { useState, useEffect } from "react";
import { Image, MessageSquare, Images, Database, Settings, Palette, Info, Clapperboard } from "lucide-react";
import { ThemeModal, AppThemeId, APP_THEMES } from "./ThemeModal";

export type TabType = "image" | "video" | "chat" | "gallery" | "models" | "about" | "settings";

interface SidebarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  isEngineRunning?: boolean;
  librariesReady?: boolean;
  missingLibrariesCount?: number;
  updateAvailable?: boolean;
  generationProgress?: { step: number; total: number } | null;
  imageReady?: boolean;
}

function applyTheme(theme: AppThemeId) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("solframe-theme", theme);
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  isEngineRunning = false,
  librariesReady = true,
  missingLibrariesCount = 0,
  updateAvailable = false,
  generationProgress = null,
  imageReady = false
}) => {
  const [currentTheme, setCurrentTheme] = useState<AppThemeId>(() => {
    return (localStorage.getItem("solframe-theme") as AppThemeId) || "cinema";
  });
  const [isThemeModalOpen, setIsThemeModalOpen] = useState(false);

  useEffect(() => {
    applyTheme(currentTheme);
  }, []);

  const handleSelectTheme = (themeId: AppThemeId) => {
    setCurrentTheme(themeId);
    applyTheme(themeId);
  };

  const activeThemeMeta = APP_THEMES.find((t) => t.id === currentTheme) || APP_THEMES[0];

  const genPercent = generationProgress && generationProgress.total > 0
    ? Math.min(100, Math.max(0, (generationProgress.step / generationProgress.total) * 100))
    : 0;
  const genRadius = 17;
  const genCircumference = 2 * Math.PI * genRadius;
  const genDashOffset = genCircumference * (1 - genPercent / 100);

  const hasMissingLibraries = !librariesReady || missingLibrariesCount > 0;
  const indicatorClass = hasMissingLibraries
    ? "engine-indicator-missing"
    : isEngineRunning
    ? "engine-indicator-running"
    : "engine-indicator-ready";

  const indicatorTooltip = hasMissingLibraries
    ? `⚠️ ${missingLibrariesCount} Acceleration Library Missing (Click to Open Library Manager)`
    : isEngineRunning
    ? "⚡ Inference Engine Active (Generating on GPU/CPU)"
    : "🟡 Hardware Libraries Loaded & Ready (Idle)";

  return (
    <>
      <aside className="sidebar glass-panel">
        {/* Brand Logo & Emblem */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            cursor: "pointer",
            paddingBottom: "8px"
          }}
          onClick={() => setActiveTab("image")}
          title="Solframe Studio — Generative AI Workspace"
        >
          <div
            style={{
              width: "44px",
              height: "44px",
              borderRadius: "14px",
              background: "linear-gradient(135deg, var(--accent) 0%, var(--accent-secondary, #8b5cf6) 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 0 22px var(--accent-glow)",
              overflow: "hidden",
              border: "1px solid rgba(255, 255, 255, 0.2)",
              transition: "transform 0.2s, box-shadow 0.2s"
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "scale(1.05)";
              e.currentTarget.style.boxShadow = "0 0 28px var(--accent-glow)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "scale(1)";
              e.currentTarget.style.boxShadow = "0 0 22px var(--accent-glow)";
            }}
          >
            <img
              src={activeThemeMeta.emblem}
              alt="Solframe Logo"
              style={{ width: "100%", height: "100%", objectFit: "contain", padding: "5px" }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).src = "/logo.png";
                (e.currentTarget as HTMLImageElement).style.objectFit = "cover";
                (e.currentTarget as HTMLImageElement).style.padding = "0";
              }}
            />
          </div>
        </div>

        {/* Navigation Tabs */}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", width: "100%", alignItems: "center" }}>
          <button
            className={`sidebar-icon ${activeTab === "image" ? "active" : ""}`}
            onClick={() => setActiveTab("image")}
            title={
              isEngineRunning
                ? `Generating artwork — step ${generationProgress?.step ?? 0}/${generationProgress?.total ?? 0}`
                : imageReady
                ? "Your artwork is ready to view!"
                : "Image Studio (FLUX.2 & SDXL Lightning)"
            }
            style={{ position: "relative" }}
          >
            {(isEngineRunning || imageReady) && (
              <svg
                width="40"
                height="40"
                viewBox="0 0 40 40"
                style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%) rotate(-90deg)", pointerEvents: "none" }}
              >
                <circle
                  cx="20"
                  cy="20"
                  r={genRadius}
                  fill="none"
                  stroke="rgba(255,255,255,0.08)"
                  strokeWidth="2.5"
                />
                <circle
                  cx="20"
                  cy="20"
                  r={genRadius}
                  fill="none"
                  stroke={imageReady ? "#10b981" : "var(--accent)"}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={genCircumference}
                  strokeDashoffset={imageReady ? 0 : genDashOffset}
                  style={{
                    transition: "stroke-dashoffset 0.3s ease",
                    filter: imageReady ? "drop-shadow(0 0 4px #10b981)" : "drop-shadow(0 0 3px var(--accent-glow))"
                  }}
                />
              </svg>
            )}
            <Image size={22} />
            {imageReady && (
              <span
                style={{
                  position: "absolute",
                  top: "4px",
                  right: "4px",
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  backgroundColor: "#10b981",
                  boxShadow: "0 0 8px #10b981",
                  border: "1px solid rgba(255,255,255,0.4)"
                }}
              />
            )}
          </button>

          <button
            className={`sidebar-icon ${activeTab === "video" ? "active" : ""}`}
            onClick={() => setActiveTab("video")}
            title="Video Studio (LTX-Video & Wan 2.2 — chunked continuous I2V)"
          >
            <Clapperboard size={22} />
          </button>

          <button
            className={`sidebar-icon ${activeTab === "chat" ? "active" : ""}`}
            onClick={() => setActiveTab("chat")}
            title="Uncensored LLM Chat (llama.cpp)"
          >
            <MessageSquare size={22} />
          </button>

          <button
            className={`sidebar-icon ${activeTab === "gallery" ? "active" : ""}`}
            onClick={() => setActiveTab("gallery")}
            title="Generated Artwork Gallery"
          >
            <Images size={22} />
          </button>

          <button
            className={`sidebar-icon ${activeTab === "models" ? "active" : ""}`}
            onClick={() => setActiveTab("models")}
            title="Model Hub & System Models"
          >
            <Database size={22} />
          </button>

          {/* About Tab */}
          <button
            className={`sidebar-icon ${activeTab === "about" ? "active" : ""}`}
            onClick={() => setActiveTab("about")}
            title={updateAvailable ? "About Solframe Studio — Update available!" : "About Solframe Studio, Libraries & Creator Protik"}
            style={{ position: "relative" }}
          >
            <Info size={22} />
            {updateAvailable && (
              <span
                style={{
                  position: "absolute",
                  top: "6px",
                  right: "6px",
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  backgroundColor: "var(--accent)",
                  boxShadow: "0 0 8px var(--accent)",
                  border: "1px solid rgba(255,255,255,0.4)"
                }}
              />
            )}
          </button>
        </div>

        <div style={{ flex: 1 }} />

        {/* Visual Theme Gallery Trigger */}
        <div style={{ marginBottom: "10px", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <button
            className="sidebar-icon"
            onClick={() => setIsThemeModalOpen(true)}
            title={`Visual Themes: Active '${activeThemeMeta.name}' (Click to open theme gallery)`}
            style={{
              position: "relative",
              border: `1px solid ${activeThemeMeta.colors.accent}40`,
              background: `radial-gradient(circle, ${activeThemeMeta.colors.accent}20 0%, transparent 80%)`
            }}
          >
            <Palette size={20} color={activeThemeMeta.colors.accent} />
            {/* Active Theme Color Indicator Dot */}
            <span
              style={{
                position: "absolute",
                top: "8px",
                right: "8px",
                width: "7px",
                height: "7px",
                borderRadius: "50%",
                backgroundColor: activeThemeMeta.colors.accent,
                boxShadow: `0 0 8px ${activeThemeMeta.colors.accent}`
              }}
            />
          </button>
        </div>

        {/* Engine & Acceleration Library Status Indicator */}
        <div style={{ marginBottom: "12px", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div
            className={indicatorClass}
            title={indicatorTooltip}
            style={{
              width: "11px",
              height: "11px",
              borderRadius: "50%",
              cursor: "pointer",
              transition: "transform 0.2s"
            }}
            onClick={() => setActiveTab("about")}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "scale(1.3)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "scale(1)";
            }}
          />
        </div>

        {/* Settings Tab */}
        <button
          className={`sidebar-icon ${activeTab === "settings" ? "active" : ""}`}
          onClick={() => setActiveTab("settings")}
          title="Hardware & Engine Settings"
        >
          <Settings size={22} />
        </button>
      </aside>


      {/* Visual Theme Gallery Modal */}
      <ThemeModal
        isOpen={isThemeModalOpen}
        onClose={() => setIsThemeModalOpen(false)}
        currentTheme={currentTheme}
        onSelectTheme={handleSelectTheme}
      />
    </>
  );
};