import React from 'react';
import {
  RotateCcw,
  Search,
  ArrowRight,
  Plus,
} from 'lucide-react';
import { CreativityMode, LayoutMode } from '../types/graph';

interface ControlBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  status: string;
  currentLevel: number;
  maxLevels: number;
  onMaxLevelsChange: (lvl: number) => void;
  topKIn: number;
  onTopKInChange: (k: number) => void;
  topKOut: number;
  onTopKOutChange: (k: number) => void;
  creativityMode: CreativityMode;
  onCreativityModeChange: (m: CreativityMode) => void;
  layoutMode: LayoutMode;
  onLayoutModeChange: (m: LayoutMode) => void;
  onStartLiveExpansion: (customQuery?: string) => void;
  onControlSession: (action: 'pause' | 'resume' | 'step' | 'stop') => void;
  onResetToZhangPreset: () => void;
  nodeCount: number;
  edgeCount: number;
  statusMessage: string;
}

export const ControlBar: React.FC<ControlBarProps> = ({
  query,
  onQueryChange,
  layoutMode,
  onLayoutModeChange,
  onStartLiveExpansion,
  onControlSession,
  onResetToZhangPreset,
  nodeCount,
  edgeCount,
}) => {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onStartLiveExpansion(query);
  };

  return (
    <header className="fixed top-4 left-6 right-6 z-30 pointer-events-none flex items-center justify-between gap-4">
      {/* Left: Floating Apple Glass Brand Pill */}
      <button
        onClick={onResetToZhangPreset}
        className="pointer-events-auto apple-glass rounded-full px-4 py-2 flex items-baseline gap-2.5 hover:scale-[1.01] active:scale-[0.99] transition"
      >
        <span className="font-serif-editorial text-lg font-medium tracking-tight text-[#1D1D1F]">
          LemmaLoop
        </span>
        <span className="text-[11px] text-[#86868B] font-mono-metric hidden sm:inline">
          {nodeCount} papers · {edgeCount} links
        </span>
      </button>

      {/* Center: Floating Apple Glass Search Capsule */}
      <form
        onSubmit={handleSubmit}
        className="pointer-events-auto flex-1 max-w-lg apple-glass rounded-full pl-4 pr-1.5 py-1.5 flex items-center transition focus-within:ring-2 focus-within:ring-black/10"
      >
        <Search className="w-3.5 h-3.5 text-[#86868B] shrink-0 mr-2.5" />
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Paper title or Google Scholar link..."
          className="w-full bg-transparent text-[13px] text-[#1D1D1F] placeholder-[#86868B] focus:outline-none"
        />
        <button
          type="submit"
          className="ml-2 shrink-0 inline-flex items-center gap-1 px-3.5 py-1.5 rounded-full bg-[#1D1D1F] hover:bg-[#333336] text-white text-xs font-medium transition shadow-sm"
        >
          <span>Seed</span>
          <ArrowRight className="w-3 h-3" />
        </button>
      </form>

      {/* Right: Floating Apple Glass View & Level Capsule */}
      <div className="pointer-events-auto apple-glass rounded-full p-1 flex items-center gap-1">
        <div className="flex items-center bg-black/[0.04] p-0.5 rounded-full text-xs">
          <button
            type="button"
            onClick={() => onLayoutModeChange('level_flow')}
            className={`px-3 py-1 rounded-full transition font-medium ${
              layoutMode === 'level_flow'
                ? 'bg-white text-[#1D1D1F] shadow-sm'
                : 'text-[#86868B] hover:text-[#1D1D1F]'
            }`}
          >
            Flow
          </button>
          <button
            type="button"
            onClick={() => onLayoutModeChange('force_radial')}
            className={`px-3 py-1 rounded-full transition font-medium ${
              layoutMode === 'force_radial'
                ? 'bg-white text-[#1D1D1F] shadow-sm'
                : 'text-[#86868B] hover:text-[#1D1D1F]'
            }`}
          >
            Orbit
          </button>
        </div>

        <button
          onClick={() => onControlSession('step')}
          title="Grow +1 Level"
          className="inline-flex items-center gap-1 px-3 py-1 rounded-full hover:bg-black/[0.05] text-[#1D1D1F] text-xs font-medium transition"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Level</span>
        </button>

        <button
          onClick={onResetToZhangPreset}
          title="Reset to Bounded gaps between primes (2014)"
          className="p-1.5 rounded-full text-[#86868B] hover:text-[#1D1D1F] hover:bg-black/[0.05] transition"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>
    </header>
  );
};
