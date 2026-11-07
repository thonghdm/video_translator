import React, { useState, useEffect } from 'react';
import { countRender } from '../lib/renderProbe';
import {
  Play,
  Pause,
  Download,
  Sparkles,
  Cpu,
  Zap,
  ShieldCheck,
  Layers,
  Globe,
  ChevronRight,
  CheckCircle2,
  ArrowRight,
  Terminal,
  Sliders,
  Eye,
  X,
  Monitor,
  Check,
  FolderOpen,
  Flame,
  Laptop,
  HardDrive,
  RotateCcw
} from 'lucide-react';

interface LandingPageProps {
  onOpenVideo: () => void;
  onOpenYouTube: () => void;
  onSwitchToPlayer?: () => void;
  hasLoadedVideo?: boolean;
  /** false khi trang bị ẩn (đang ở chế độ xem video) -> dừng toàn bộ timer demo chạy ngầm */
  isActive?: boolean;
}

interface DemoSubtitle {
  time: number;
  en: string;
  vi: string;
}

const DEMO_TIMELINE: DemoSubtitle[] = [
  {
    time: 0,
    en: "Welcome to this deep dive into High-Performance Concurrency in Go.",
    vi: "Chào mừng các bạn đến với bài phân tích chuyên sâu về Lập trình đồng thời hiệu năng cao trong Go."
  },
  {
    time: 4,
    en: "Today we will explore how goroutines communicate safely via channels.",
    vi: "Hôm nay chúng ta sẽ tìm hiểu cách các goroutine giao tiếp an toàn thông qua channels."
  },
  {
    time: 8,
    en: "Notice how lock contention drops to zero when utilizing channel buffering.",
    vi: "Hãy chú ý sự tranh chấp khóa (lock contention) giảm về 0 khi dùng hàng đợi channel đệm."
  },
  {
    time: 12,
    en: "Next, we will integrate a two-tier lookahead scheduler with a local LLM.",
    vi: "Tiếp theo, chúng ta sẽ tích hợp bộ lập lịch đón đầu 2 tầng với mô hình ngôn ngữ lớn chạy cục bộ."
  },
  {
    time: 16,
    en: "This guarantees near-zero latency even when streaming 4K video feeds.",
    vi: "Cơ chế này đảm bảo độ trễ gần như bằng 0 ngay cả khi phát trực tiếp các luồng video 4K."
  }
];

const LandingPageComponent: React.FC<LandingPageProps> = ({
  onOpenVideo,
  onOpenYouTube,
  onSwitchToPlayer,
  hasLoadedVideo = false,
  isActive = true
}) => {
  countRender("LandingPage");
  // Demo player state
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [demoTime, setDemoTime] = useState<number>(2);
  const [demoMode, setDemoMode] = useState<'bilingual' | 'vi' | 'en'>('bilingual');
  const [showDownloadModal, setShowDownloadModal] = useState<boolean>(false);
  const [downloadTab, setDownloadTab] = useState<'installer' | 'portable' | 'cli'>('installer');
  const [copiedCmd, setCopiedCmd] = useState<boolean>(false);

  // Auto-tick demo player
  // Chỉ chạy khi trang đang hiển thị: LandingPage không unmount khi sang chế độ player (chỉ ẩn bằng CSS)
  useEffect(() => {
    if (!isPlaying || !isActive) return;
    const interval = setInterval(() => {
      setDemoTime((prev) => (prev >= 19.5 ? 0 : prev + 0.25));
    }, 250);
    return () => clearInterval(interval);
  }, [isPlaying, isActive]);

  // Current subtitle for demo
  const currentSub = DEMO_TIMELINE.slice().reverse().find((s) => demoTime >= s.time) || DEMO_TIMELINE[0];

  const isWebEnvironment = typeof window !== 'undefined' && !window.go?.main?.App;

  const handleTryNow = () => {
    if (isWebEnvironment) {
      setShowDownloadModal(true);
    } else {
      onOpenVideo();
    }
  };

  const handleTryYouTube = () => {
    if (isWebEnvironment) {
      setShowDownloadModal(true);
    } else {
      onOpenYouTube();
    }
  };

  const handleCopyCli = () => {
    navigator.clipboard.writeText('git clone https://github.com/thonghdm/video_translator.git\ncd video_translator\n./run-dev.bat');
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 2500);
  };

  return (
    <div className="min-h-full w-full bg-[#0a0c10] text-[#f1f2f6] overflow-y-auto selection:bg-amber-500 selection:text-black">
      {/* 1. Header Navigation Bar */}
      <nav className="sticky top-0 z-40 w-full backdrop-blur-md bg-[#0d0f14]/85 border-b border-neutral-800/80 px-6 py-3.5 flex items-center justify-between transition-all">
        <div className="flex items-center space-x-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-amber-500 to-yellow-300 flex items-center justify-center shadow-lg shadow-amber-500/20 text-black font-black text-lg">
            S
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-extrabold text-base tracking-tight text-white">SubTrans</span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30">
                v2.0 PRO
              </span>
            </div>
            <p className="text-[11px] text-neutral-400 hidden sm:block">AI Real-time Video Translator</p>
          </div>
        </div>

        {/* Navigation anchors */}
        <div className="hidden md:flex items-center space-x-6 text-xs font-medium text-neutral-300">
          <a href="#features" className="hover:text-amber-400 transition-colors">Tính năng vượt trội</a>
          <a href="#demo" className="hover:text-amber-400 transition-colors">Demo trực quan</a>
          <a href="#benchmarks" className="hover:text-amber-400 transition-colors">Hiệu năng & So sánh</a>
          <a href="#specs" className="hover:text-amber-400 transition-colors">Yêu cầu phần cứng</a>
        </div>

        {/* Right CTA */}
        <div className="flex items-center space-x-3">
          {!isWebEnvironment && onSwitchToPlayer && (
            <button
              onClick={onSwitchToPlayer}
              className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-neutral-800 hover:bg-neutral-700 text-amber-400 border border-amber-500/40 transition-colors flex items-center space-x-1.5"
            >
              <Play className="w-3.5 h-3.5 fill-amber-400" />
              <span>{hasLoadedVideo ? 'Quay lại Trình phát' : 'Vào Trình phát'}</span>
            </button>
          )}

          <button
            onClick={() => setShowDownloadModal(true)}
            className="hidden sm:flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-900 hover:bg-neutral-800 text-neutral-200 border border-neutral-700 transition-colors"
          >
            <Download className="w-3.5 h-3.5 text-amber-400" />
            <span>Tải bản Setup</span>
          </button>

          <button
            onClick={handleTryNow}
            className="flex items-center space-x-2 px-4 py-1.5 rounded-lg text-xs font-bold bg-gradient-to-r from-amber-500 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-black shadow-lg shadow-amber-500/25 hover:shadow-amber-500/40 transition-all transform active:scale-95"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span>Dùng thử ngay</span>
          </button>
        </div>
      </nav>

      {/* 2. Hero Section */}
      <section className="relative pt-12 pb-20 px-6 max-w-7xl mx-auto flex flex-col items-center text-center overflow-hidden">
        {/* Glow ambient background */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[650px] h-[350px] bg-gradient-to-tr from-amber-500/15 to-yellow-400/5 blur-[120px] rounded-full pointer-events-none -z-10" />

        {/* Release Pill Badge */}
        <div className="inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-neutral-900/90 border border-amber-500/30 text-amber-300 text-xs font-medium mb-6 backdrop-blur shadow-sm hover:border-amber-500/60 transition-colors cursor-default">
          <Sparkles className="w-3.5 h-3.5 text-amber-400 animate-spin" style={{ animationDuration: '6s' }} />
          <span>Bộ cài siêu nhẹ ~20MB • Tự động tải Model %LOCALAPPDATA% • In-App Updater</span>
          <ChevronRight className="w-3.5 h-3.5 text-neutral-400" />
        </div>

        {/* Main Headline */}
        <h1 className="text-3xl sm:text-5xl lg:text-6xl font-black tracking-tight text-white max-w-4xl leading-[1.15]">
          Xem Video Khóa Học Nước Ngoài <br />
          <span className="bg-gradient-to-r from-amber-400 via-yellow-300 to-amber-200 bg-clip-text text-transparent">
            Không Chờ Đợi Độ Trễ Phụ Đề
          </span>
        </h1>

        {/* Subtitle */}
        <p className="mt-5 text-sm sm:text-base text-neutral-300 max-w-2xl leading-relaxed">
          Phần mềm Desktop dịch phụ đề video tự động theo thời gian thực (Real-time). Tích hợp AI cục bộ 
          <span className="text-amber-300 font-semibold"> Qwen 2.5 1.5B</span>, bộ lập lịch đón đầu 2 tầng thông minh và thuật toán ánh xạ chuỗi 
          <span className="text-amber-300 font-mono font-semibold"> ⟦|⟧</span> chống lệch ngữ cảnh 100%.
        </p>

        {/* Quick Value Props Tags */}
        <div className="mt-6 flex flex-wrap justify-center gap-2.5 max-w-3xl text-xs text-neutral-300">
          <div className="flex items-center space-x-1.5 px-3 py-1 rounded-md bg-neutral-900/80 border border-neutral-800">
            <Zap className="w-3.5 h-3.5 text-amber-400" />
            <span>Đón đầu Playhead trước 30s</span>
          </div>
          <div className="flex items-center space-x-1.5 px-3 py-1 rounded-md bg-neutral-900/80 border border-neutral-800">
            <Download className="w-3.5 h-3.5 text-cyan-400" />
            <span>Bộ cài siêu nhẹ (~20 MB)</span>
          </div>
          <div className="flex items-center space-x-1.5 px-3 py-1 rounded-md bg-neutral-900/80 border border-neutral-800">
            <RotateCcw className="w-3.5 h-3.5 text-amber-400" />
            <span>In-App Updater (Giữ 100% Model AI)</span>
          </div>
          <div className="flex items-center space-x-1.5 px-3 py-1 rounded-md bg-neutral-900/80 border border-neutral-800">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span>100% Offline & Bảo mật tuyệt đối</span>
          </div>
          <div className="flex items-center space-x-1.5 px-3 py-1 rounded-md bg-neutral-900/80 border border-neutral-800">
            <Cpu className="w-3.5 h-3.5 text-purple-400" />
            <span>Vulkan GPU Acceleration</span>
          </div>
          <div className="flex items-center space-x-1.5 px-3 py-1 rounded-md bg-neutral-900/80 border border-neutral-800">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            <span>0.0% Tỉ lệ mất câu (0/11 drop)</span>
          </div>
        </div>

        {/* Hero CTA Action Buttons */}
        <div className="mt-8 flex flex-col sm:flex-row items-center gap-3.5 w-full sm:w-auto">
          <button
            onClick={handleTryNow}
            className="w-full sm:w-auto flex items-center justify-center space-x-2 px-6 py-3 rounded-xl bg-gradient-to-r from-amber-500 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-black font-bold text-sm shadow-xl shadow-amber-500/25 hover:shadow-amber-500/40 transition-all transform active:scale-95"
          >
            <FolderOpen className="w-4 h-4" />
            <span>Mở video trải nghiệm ngay</span>
            <ArrowRight className="w-4 h-4 ml-1" />
          </button>

          <button
            onClick={handleTryYouTube}
            className="w-full sm:w-auto flex items-center justify-center space-x-2 px-5 py-3 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-neutral-100 font-semibold text-sm border border-neutral-700 hover:border-neutral-600 transition-all"
          >
            <Globe className="w-4 h-4 text-red-400" />
            <span>Dán link YouTube</span>
          </button>

          <button
            onClick={() => setShowDownloadModal(true)}
            className="w-full sm:w-auto flex items-center justify-center space-x-2 px-5 py-3 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-neutral-200 font-medium text-sm border border-neutral-800 hover:border-amber-500/40 transition-all"
          >
            <Download className="w-4 h-4 text-amber-400" />
            <span>Tải bộ cài Windows (~20MB)</span>
          </button>
        </div>

        {/* Real-time Metrics Bar */}
        <div className="mt-12 w-full max-w-4xl grid grid-cols-2 sm:grid-cols-4 gap-4 p-4 rounded-2xl bg-[#11141b]/80 border border-neutral-800/80 backdrop-blur-sm shadow-2xl">
          <div className="flex flex-col items-center justify-center p-3">
            <span className="text-2xl sm:text-3xl font-black text-amber-400">~20 MB</span>
            <span className="text-[11px] font-medium text-neutral-400 uppercase tracking-wider mt-1">Bộ cài siêu nhẹ</span>
          </div>
          <div className="flex flex-col items-center justify-center p-3 border-l border-neutral-800/80">
            <span className="text-2xl sm:text-3xl font-black text-emerald-400">100%</span>
            <span className="text-[11px] font-medium text-neutral-400 uppercase tracking-wider mt-1">Đúng hạn Playhead</span>
          </div>
          <div className="flex flex-col items-center justify-center p-3 border-l border-neutral-800/80">
            <span className="text-2xl sm:text-3xl font-black text-cyan-400">&lt; 0.18s</span>
            <span className="text-[11px] font-medium text-neutral-400 uppercase tracking-wider mt-1">Độ trễ phản hồi (p50)</span>
          </div>
          <div className="flex flex-col items-center justify-center p-3 border-l border-neutral-800/80">
            <span className="text-2xl sm:text-3xl font-black text-white">1.1 GB</span>
            <span className="text-[11px] font-medium text-neutral-400 uppercase tracking-wider mt-1">Model Offline (%LOCALAPPDATA%)</span>
          </div>
        </div>
      </section>

      {/* 3. Interactive Mock Video Player (Live Demo) */}
      <section id="demo" className="py-16 px-6 max-w-5xl mx-auto">
        <div className="text-center mb-8">
          <div className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-semibold mb-2">
            <Eye className="w-3.5 h-3.5" />
            <span>Mô phỏng Trực quan</span>
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold text-white">
            Trải Nghiệm Trình Phát Phụ Đề Trực Tuyến
          </h2>
          <p className="text-xs sm:text-sm text-neutral-400 max-w-xl mx-auto mt-2">
            Xem cơ chế hiển thị song ngữ với overlay chống mỏi mắt và tính năng streaming từng dòng theo thời gian thực.
          </p>
        </div>

        {/* Mock Player Frame */}
        <div className="rounded-2xl border border-neutral-800 bg-[#12151d] overflow-hidden shadow-2xl shadow-black/80 flex flex-col">
          {/* Top Player Status Bar */}
          <div className="h-10 bg-[#171a22] border-b border-neutral-800 px-4 flex items-center justify-between text-xs">
            <div className="flex items-center space-x-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="font-mono text-neutral-300 font-semibold text-[11px]">
                Lecture-04-Concurrency-Patterns.mp4
              </span>
              <span className="text-[10px] bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 px-2 py-0.5 rounded font-mono">
                Đón đầu +32.4s
              </span>
            </div>

            {/* Subtitle Mode Switcher */}
            <div className="flex items-center bg-neutral-900 p-0.5 rounded-lg border border-neutral-800 text-[11px]">
              <button
                onClick={() => setDemoMode('bilingual')}
                className={`px-2.5 py-1 rounded-md font-semibold transition-all ${
                  demoMode === 'bilingual' ? 'bg-amber-500 text-black shadow' : 'text-neutral-400 hover:text-white'
                }`}
              >
                Song ngữ
              </button>
              <button
                onClick={() => setDemoMode('vi')}
                className={`px-2.5 py-1 rounded-md font-semibold transition-all ${
                  demoMode === 'vi' ? 'bg-amber-500 text-black shadow' : 'text-neutral-400 hover:text-white'
                }`}
              >
                Tiếng Việt
              </button>
              <button
                onClick={() => setDemoMode('en')}
                className={`px-2.5 py-1 rounded-md font-semibold transition-all ${
                  demoMode === 'en' ? 'bg-amber-500 text-black shadow' : 'text-neutral-400 hover:text-white'
                }`}
              >
                Tiếng Anh
              </button>
            </div>
          </div>

          {/* Player Screen Mock */}
          <div className="relative aspect-video w-full bg-gradient-to-br from-[#07090d] via-[#10131a] to-[#07090d] flex flex-col items-center justify-center p-8 overflow-hidden select-none">
            {/* Ambient Tech Grid Background */}
            <div className="absolute inset-0 opacity-15 bg-[radial-gradient(#amber_1px,transparent_1px)] [background-size:24px_24px] pointer-events-none" />

            {/* Coding Lecture Visual Graphic */}
            <div className="w-full max-w-lg bg-[#0b0e14]/90 border border-neutral-800/90 rounded-xl p-5 shadow-2xl backdrop-blur font-mono text-[11px] sm:text-xs text-neutral-300 leading-relaxed space-y-2">
              <div className="flex items-center justify-between pb-2 border-b border-neutral-800 text-neutral-400 text-[10px]">
                <span>pipeline.go - Go High Concurrency Architecture</span>
                <span className="text-amber-400">Vulkan GPU Offloaded</span>
              </div>
              <div className="text-emerald-400 font-semibold">func (p *Pipeline) TwoTierLookahead() &#123;</div>
              <div className="pl-4 text-cyan-300">// Tier 1: Urgent 3 items near current playhead</div>
              <div className="pl-4">urgentBatch := p.filterUrgent(curPlayhead, 3)</div>
              <div className="pl-4 text-amber-300">p.engine.TranslateBatch(urgentBatch, " ⟦|⟧ ")</div>
              <div className="pl-4 text-neutral-400">// Tier 2: Background lookahead 8 items</div>
              <div className="pl-4">go p.scheduleBackgroundAhead(8)</div>
              <div className="text-emerald-400">&#125;</div>
            </div>

            {/* Overlay Subtitle Box */}
            <div className="absolute bottom-6 left-6 right-6 flex flex-col items-center pointer-events-none transition-all">
              <div className="bg-black/85 backdrop-blur-md px-6 py-3 rounded-xl max-w-2xl text-center border border-white/10 shadow-2xl space-y-1">
                {(demoMode === 'en' || demoMode === 'bilingual') && (
                  <p className="text-neutral-300 text-xs sm:text-sm font-medium drop-shadow leading-relaxed">
                    {currentSub.en}
                  </p>
                )}
                {(demoMode === 'vi' || demoMode === 'bilingual') && (
                  <p className="text-amber-400 text-sm sm:text-base font-bold drop-shadow leading-relaxed">
                    {currentSub.vi}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Bottom Player Controller */}
          <div className="h-14 bg-[#141720] border-t border-neutral-800 px-4 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <button
                onClick={() => setIsPlaying(!isPlaying)}
                className="w-8 h-8 rounded-lg bg-amber-500 hover:bg-amber-400 text-black flex items-center justify-center transition-transform active:scale-90"
              >
                {isPlaying ? <Pause className="w-4 h-4 fill-black" /> : <Play className="w-4 h-4 fill-black ml-0.5" />}
              </button>
              <span className="text-xs font-mono text-neutral-300">
                00:{String(Math.floor(demoTime)).padStart(2, '0')} / 00:20
              </span>
            </div>

            {/* Simulated Seek Bar */}
            <div className="flex-1 mx-6 flex items-center">
              <div className="w-full h-1.5 bg-neutral-800 rounded-full relative overflow-hidden cursor-pointer">
                {/* Completed cache buffer */}
                <div className="absolute top-0 bottom-0 left-0 w-3/4 bg-amber-500/25" />
                {/* Current progress */}
                <div
                  className="h-full bg-amber-400 transition-all duration-200"
                  style={{ width: `${(demoTime / 20) * 100}%` }}
                />
              </div>
            </div>

            <div className="flex items-center space-x-3 text-xs text-neutral-400">
              <span className="hidden sm:inline font-mono text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded">
                Delimiter ⟦|⟧: 100% Khớp
              </span>
              <button
                onClick={handleTryNow}
                className="px-3 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-semibold border border-neutral-700 transition-colors"
              >
                Thử trên video thật
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 4. Core Features Grid */}
      <section id="features" className="py-16 px-6 max-w-7xl mx-auto">
        <div className="text-center mb-14">
          <div className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-semibold mb-2">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Công Nghệ Đột Phá</span>
          </div>
          <h2 className="text-2xl sm:text-4xl font-extrabold text-white tracking-tight">
            6 Trụ Cột Kỹ Thuật Định Nghĩa SubTrans
          </h2>
          <p className="text-xs sm:text-sm text-neutral-400 max-w-2xl mx-auto mt-2">
            Được kiến trúc tỉ mỉ từ lõi backend Go hiệu năng cao đến giao diện React desktop mượt mà.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* Card 1 */}
          <div className="p-6 rounded-2xl bg-[#11141c] border border-neutral-800 hover:border-amber-500/40 transition-all group shadow-lg flex flex-col justify-between">
            <div>
              <div className="w-10 h-10 rounded-xl bg-amber-500/15 text-amber-400 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <Zap className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-white mb-2 group-hover:text-amber-400 transition-colors">
                Bộ Lập Lịch Đón Đầu Two-Tier
              </h3>
              <p className="text-xs text-neutral-400 leading-relaxed">
                Tách biệt tầng ưu tiên cao: dịch tức thì tối đa 3 câu quanh vị trí Playhead (đảm bảo không bị trễ khi tua), 
                kết hợp dịch đón đầu nền 8 câu tiếp theo theo từng block 30 giây.
              </p>
            </div>
            <div className="mt-4 pt-4 border-t border-neutral-800/80 flex items-center text-[11px] text-amber-400 font-semibold">
              <span>Độ trễ khi tua video: &lt; 0.2s</span>
            </div>
          </div>

          {/* Card 2 */}
          <div className="p-6 rounded-2xl bg-[#11141c] border border-neutral-800 hover:border-amber-500/40 transition-all group shadow-lg flex flex-col justify-between">
            <div>
              <div className="w-10 h-10 rounded-xl bg-cyan-500/15 text-cyan-400 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <Cpu className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-white mb-2 group-hover:text-cyan-400 transition-colors">
                Local LLM Qwen 2.5 1.5B Instruct
              </h3>
              <p className="text-xs text-neutral-400 leading-relaxed">
                Mô hình ngôn ngữ thế hệ mới hiểu sâu ngữ cảnh chuyên ngành CNTT, lập trình, trí tuệ nhân tạo.
                Dịch tự nhiên, không dịch máy móc từ-theo-từ (word-by-word).
              </p>
            </div>
            <div className="mt-4 pt-4 border-t border-neutral-800/80 flex items-center text-[11px] text-cyan-400 font-semibold">
              <span>Chạy cục bộ 100% qua llama-server</span>
            </div>
          </div>

          {/* Card 3 */}
          <div className="p-6 rounded-2xl bg-[#11141c] border border-neutral-800 hover:border-amber-500/40 transition-all group shadow-lg flex flex-col justify-between">
            <div>
              <div className="w-10 h-10 rounded-xl bg-emerald-500/15 text-emerald-400 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <Flame className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-white mb-2 group-hover:text-emerald-400 transition-colors">
                Tăng Tốc Phần Cứng Vulkan GPU
              </h3>
              <p className="text-xs text-neutral-400 leading-relaxed">
                Đẩy toàn bộ 29/29 layer của mô hình lên GPU qua thư viện Vulkan/CUDA. Bộ nhớ đệm KV chỉ tốn 56MB VRAM, 
                tương thích hoàn hảo với GPU phổ thông như GTX 1650, RTX 20/30/40 và Intel ARC.
              </p>
            </div>
            <div className="mt-4 pt-4 border-t border-neutral-800/80 flex items-center text-[11px] text-emerald-400 font-semibold">
              <span>Tốc độ sinh token: ~65 tok/s</span>
            </div>
          </div>

          {/* Card 4 */}
          <div className="p-6 rounded-2xl bg-[#11141c] border border-neutral-800 hover:border-amber-500/40 transition-all group shadow-lg flex flex-col justify-between">
            <div>
              <div className="w-10 h-10 rounded-xl bg-purple-500/15 text-purple-400 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <Layers className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-white mb-2 group-hover:text-purple-400 transition-colors">
                Chuỗi Phân Tách Delimiter `⟦|⟧`
              </h3>
              <p className="text-xs text-neutral-400 leading-relaxed">
                Thay thế ký tự xuống dòng `\n` dễ biến dạng bằng ký tự phân tách đặc biệt ` ⟦|⟧ `. 
                Xác thực số lượng câu nghiêm ngặt, tự động chuyển đổi dự phòng thông minh khi có lỗi.
              </p>
            </div>
            <div className="mt-4 pt-4 border-t border-neutral-800/80 flex items-center text-[11px] text-purple-400 font-semibold">
              <span>Tỷ lệ rớt câu từ 18.2% về 0.0%</span>
            </div>
          </div>

          {/* Card 5 */}
          <div className="p-6 rounded-2xl bg-[#11141c] border border-neutral-800 hover:border-amber-500/40 transition-all group shadow-lg flex flex-col justify-between">
            <div>
              <div className="w-10 h-10 rounded-xl bg-cyan-500/15 text-cyan-400 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <RotateCcw className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-white mb-2 group-hover:text-cyan-400 transition-colors">
                Setup Wizard & Tự Cập Nhật In-App
              </h3>
              <p className="text-xs text-neutral-400 leading-relaxed">
                Bộ cài ban đầu siêu nhẹ chỉ ~20MB. Tích hợp Setup Wizard tự động tải model AI vào <code className="text-amber-300 font-mono">%LOCALAPPDATA%</code> với cơ chế HTTP Range (tải tiếp khi rớt mạng). Cập nhật phiên bản mới chỉ thay thế file .exe, giữ nguyên 100% dữ liệu model.
              </p>
            </div>
            <div className="mt-4 pt-4 border-t border-neutral-800/80 flex items-center text-[11px] text-cyan-400 font-semibold">
              <span>Cập nhật .exe an toàn • 0 byte tải lại model</span>
            </div>
          </div>

          {/* Card 6 */}
          <div className="p-6 rounded-2xl bg-[#11141c] border border-neutral-800 hover:border-amber-500/40 transition-all group shadow-lg flex flex-col justify-between">
            <div>
              <div className="w-10 h-10 rounded-xl bg-yellow-500/15 text-yellow-400 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <Globe className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-white mb-2 group-hover:text-yellow-400 transition-colors">
                Tích Hợp YouTube & Xuất Phụ Đề
              </h3>
              <p className="text-xs text-neutral-400 leading-relaxed">
                Chỉ cần dán link URL video từ YouTube để bóc tách phụ đề và dịch tức thời. Quản lý toàn bộ cây thư mục bài học, ghi nhớ tiến độ hoàn thành và xuất file `.srt`, `.vtt` song ngữ hoặc `.txt` để ôn tập.
              </p>
            </div>
            <div className="mt-4 pt-4 border-t border-neutral-800/80 flex items-center text-[11px] text-yellow-400 font-semibold">
              <span>Hỗ trợ YouTube 1080p • Chuẩn SRT / VTT / TXT</span>
            </div>
          </div>
        </div>
      </section>

      {/* 5. Benchmark & Comparison Section */}
      <section id="benchmarks" className="py-16 px-6 max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <div className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-xs font-semibold mb-2">
            <Sliders className="w-3.5 h-3.5" />
            <span>Đối Sánh Năng Lực</span>
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold text-white">
            So Sánh SubTrans Với Phương Pháp Truyền Thống
          </h2>
          <p className="text-xs sm:text-sm text-neutral-400 max-w-xl mx-auto mt-2">
            Xem sự khác biệt vượt bậc về trải nghiệm người dùng, tốc độ sẵn sàng và tính chủ động bảo mật.
          </p>
        </div>

        {/* Comparison Table */}
        <div className="rounded-2xl border border-neutral-800 bg-[#11141b] overflow-x-auto shadow-2xl">
          <table className="w-full text-left text-xs sm:text-sm">
            <thead className="bg-[#161a23] text-neutral-400 font-semibold border-b border-neutral-800 text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-4 px-5">Tiêu chí đánh giá</th>
                <th className="py-4 px-5 text-neutral-400">Cách truyền thống (Chờ dịch hết file)</th>
                <th className="py-4 px-5 text-neutral-400">Extension Trình duyệt (Cloud API)</th>
                <th className="py-4 px-5 text-amber-400 bg-amber-500/10 border-l border-r border-amber-500/20">
                  SubTrans v2.0 (Local + Two-Tier)
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/80 text-neutral-300">
              <tr>
                <td className="py-4 px-5 font-semibold text-white">Thời gian chờ bắt đầu xem</td>
                <td className="py-4 px-5 text-red-400">Chờ 20 - 45 phút hoàn tất toàn bộ file</td>
                <td className="py-4 px-5 text-yellow-400">1 - 3 giây mỗi câu (giật cục)</td>
                <td className="py-4 px-5 text-emerald-400 font-bold bg-amber-500/5 border-l border-r border-amber-500/20">
                  0 giây (Vừa phát vừa dịch đón đầu)
                </td>
              </tr>
              <tr>
                <td className="py-4 px-5 font-semibold text-white">Trải nghiệm khi tua video (Seek)</td>
                <td className="py-4 px-5 text-neutral-400">Đã dịch xong thì mượt, chưa xong thì trống</td>
                <td className="py-4 px-5 text-red-400">Lỗi mất phụ đề hoặc phải đợi API gọi lại</td>
                <td className="py-4 px-5 text-emerald-400 font-bold bg-amber-500/5 border-l border-r border-amber-500/20">
                  Ưu tiên 3 câu playhead tức thời (&lt; 0.2s)
                </td>
              </tr>
              <tr>
                <td className="py-4 px-5 font-semibold text-white">Độ chính xác thuật ngữ IT</td>
                <td className="py-4 px-5 text-yellow-400">Google Translate thô sơ, dịch sai nghĩa</td>
                <td className="py-4 px-5 text-neutral-400">Trung bình tùy vào nhà cung cấp API</td>
                <td className="py-4 px-5 text-emerald-400 font-bold bg-amber-500/5 border-l border-r border-amber-500/20">
                  Qwen 2.5 1.5B chuyên biệt ngữ cảnh IT
                </td>
              </tr>
              <tr>
                <td className="py-4 px-5 font-semibold text-white">Dung lượng bộ cài & Cập nhật</td>
                <td className="py-4 px-5 text-red-400">Tải nguyên gói 2 - 3 GB mỗi khi có bản sửa lỗi</td>
                <td className="py-4 px-5 text-neutral-400">Nhẹ nhưng phụ thuộc hoàn toàn vào Cloud API bên ngoài</td>
                <td className="py-4 px-5 text-emerald-400 font-bold bg-amber-500/5 border-l border-r border-amber-500/20">
                  Bộ cài chỉ ~20 MB! Tự cập nhật .exe, giữ 100% Model trong %LOCALAPPDATA%
                </td>
              </tr>
              <tr>
                <td className="py-4 px-5 font-semibold text-white">Bảo mật & Chi phí vận hành</td>
                <td className="py-4 px-5 text-neutral-400">Tốn tiền API hoặc upload file lên web lạ</td>
                <td className="py-4 px-5 text-red-400">Dễ bị lỗi Rate Limit HTTP 429 hoặc khóa IP</td>
                <td className="py-4 px-5 text-emerald-400 font-bold bg-amber-500/5 border-l border-r border-amber-500/20">
                  100% Cục bộ Offline, 0 đồng chi phí
                </td>
              </tr>
              <tr>
                <td className="py-4 px-5 font-semibold text-white">Tỷ lệ rớt phụ đề (Missing loss)</td>
                <td className="py-4 px-5 text-yellow-400">Khoảng 5 - 15% do lệch timestamp</td>
                <td className="py-4 px-5 text-red-400">Dễ rớt câu khi tua nhanh liên tục</td>
                <td className="py-4 px-5 text-emerald-400 font-bold bg-amber-500/5 border-l border-r border-amber-500/20">
                  0.0% với Delimiter ⟦|⟧ và Cache đệm
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* 6. System Requirements */}
      <section id="specs" className="py-16 px-6 max-w-5xl mx-auto">
        <div className="p-8 rounded-2xl bg-gradient-to-b from-[#131720] to-[#0f1219] border border-neutral-800 shadow-xl">
          <div className="flex items-center space-x-3 mb-6">
            <Laptop className="w-6 h-6 text-amber-400" />
            <h3 className="text-xl font-bold text-white">Yêu Cầu Cấu Hình Hệ Thống</h3>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs sm:text-sm">
            <div className="p-5 rounded-xl bg-neutral-900/80 border border-neutral-800 space-y-3">
              <span className="font-bold text-neutral-200 uppercase tracking-wider text-[11px] text-amber-400">
                Cấu hình tối thiểu (CPU Mode)
              </span>
              <div className="space-y-2 text-neutral-300">
                <div className="flex items-center justify-between">
                  <span className="text-neutral-400">Hệ điều hành:</span>
                  <span className="font-semibold text-white">Windows 10 / 11 64-bit</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-neutral-400">Vi xử lý (CPU):</span>
                  <span className="font-semibold text-white">Intel Core i3 / Ryzen 3 trở lên</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-neutral-400">Bộ nhớ RAM:</span>
                  <span className="font-semibold text-white">8 GB RAM (Trống tối thiểu 2GB)</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-neutral-400">Bộ cài ban đầu (.exe):</span>
                  <span className="font-semibold text-amber-300">~20 MB (Cài đặt trong 2 giây)</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-neutral-400">Lưu trữ mô hình AI:</span>
                  <span className="font-semibold text-white">~1.1 GB (%LOCALAPPDATA%\SubTrans\models)</span>
                </div>
              </div>
            </div>

            <div className="p-5 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-3">
              <span className="font-bold uppercase tracking-wider text-[11px] text-amber-300">
                Cấu hình khuyến nghị (GPU Acceleration)
              </span>
              <div className="space-y-2 text-neutral-300">
                <div className="flex items-center justify-between">
                  <span className="text-neutral-400">Card đồ họa (GPU):</span>
                  <span className="font-semibold text-amber-300">NVIDIA GTX 1650 / RTX Series (Vulkan)</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-neutral-400">Bộ nhớ VRAM:</span>
                  <span className="font-semibold text-amber-300">4 GB VRAM trở lên</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-neutral-400">Bộ nhớ RAM:</span>
                  <span className="font-semibold text-white">16 GB Dual-channel</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-neutral-400">Tốc độ sinh text:</span>
                  <span className="font-semibold text-emerald-400">60 - 90 token/giây (Tức thời)</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 7. Bottom CTA Banner */}
      <section className="py-20 px-6 max-w-5xl mx-auto text-center">
        <div className="p-10 rounded-3xl bg-gradient-to-r from-amber-500/20 via-yellow-400/10 to-amber-500/20 border border-amber-500/30 backdrop-blur-sm relative overflow-hidden shadow-2xl">
          <h2 className="text-3xl sm:text-4xl font-extrabold text-white">
            Sẵn Sàng Làm Chủ Kiến Thức Công Nghệ Quốc Tế?
          </h2>
          <p className="mt-4 text-xs sm:text-sm text-neutral-300 max-w-xl mx-auto leading-relaxed">
            Mở video bài giảng Udemy, Coursera, YouTube hoặc bất kỳ video tiếng Anh nào của bạn ngay hôm nay. 
            Hoàn toàn miễn phí, mã nguồn mở và bảo mật tuyệt đối trên máy tính của bạn.
          </p>

          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={handleTryNow}
              className="w-full sm:w-auto px-8 py-3.5 rounded-xl bg-gradient-to-r from-amber-500 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-black font-extrabold text-sm shadow-xl shadow-amber-500/30 hover:shadow-amber-500/50 transition-all transform active:scale-95 flex items-center justify-center space-x-2"
            >
              <FolderOpen className="w-4 h-4" />
              <span>Bắt đầu trải nghiệm ngay</span>
            </button>

            <button
              onClick={() => setShowDownloadModal(true)}
              className="w-full sm:w-auto px-6 py-3.5 rounded-xl bg-neutral-900/90 hover:bg-neutral-800 text-white font-semibold text-sm border border-neutral-700 hover:border-amber-400 transition-all flex items-center justify-center space-x-2"
            >
              <Download className="w-4 h-4 text-amber-400" />
              <span>Tải bản cài đặt Windows</span>
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="w-full border-t border-neutral-800/80 py-8 px-6 text-center text-xs text-neutral-500 bg-[#07090c]">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center space-x-2">
            <span className="font-bold text-neutral-300">SubTrans AI v2.0</span>
            <span>•</span>
            <span>Real-time Video Subtitle Translation Engine</span>
          </div>
          <div className="flex items-center space-x-4 text-neutral-400">
            <span className="hover:text-amber-400 cursor-pointer" onClick={handleTryNow}>Dùng thử ứng dụng</span>
            <span>•</span>
            <span className="hover:text-amber-400 cursor-pointer" onClick={() => setShowDownloadModal(true)}>Tải về</span>
            <span>•</span>
            <a href="https://github.com/thonghdm/video_translator" target="_blank" rel="noreferrer" className="hover:text-amber-400">
              GitHub Repo
            </a>
          </div>
        </div>
      </footer>

      {/* 8. Download & Setup Modal */}
      {showDownloadModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-xl bg-[#141720] border border-neutral-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="h-14 px-6 border-b border-neutral-800 flex items-center justify-between bg-[#191d27]">
              <div className="flex items-center space-x-2.5">
                <div className="w-7 h-7 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center">
                  <Download className="w-4 h-4" />
                </div>
                <h3 className="font-bold text-sm text-white">Tải SubTrans v2.0 Desktop</h3>
              </div>
              <button
                onClick={() => setShowDownloadModal(false)}
                className="w-8 h-8 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white flex items-center justify-center transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Tabs */}
            <div className="flex border-b border-neutral-800 bg-[#12151d] text-xs font-semibold text-neutral-400 px-6 pt-3 space-x-6">
              <button
                onClick={() => setDownloadTab('installer')}
                className={`pb-3 border-b-2 transition-all flex items-center space-x-2 ${
                  downloadTab === 'installer'
                    ? 'border-amber-400 text-amber-400'
                    : 'border-transparent hover:text-neutral-200'
                }`}
              >
                <Monitor className="w-4 h-4" />
                <span>Bản Cài Đặt (.exe)</span>
              </button>
              <button
                onClick={() => setDownloadTab('portable')}
                className={`pb-3 border-b-2 transition-all flex items-center space-x-2 ${
                  downloadTab === 'portable'
                    ? 'border-amber-400 text-amber-400'
                    : 'border-transparent hover:text-neutral-200'
                }`}
              >
                <HardDrive className="w-4 h-4" />
                <span>Bản Nén Chạy Ngay (.zip)</span>
              </button>
              <button
                onClick={() => setDownloadTab('cli')}
                className={`pb-3 border-b-2 transition-all flex items-center space-x-2 ${
                  downloadTab === 'cli'
                    ? 'border-amber-400 text-amber-400'
                    : 'border-transparent hover:text-neutral-200'
                }`}
              >
                <Terminal className="w-4 h-4" />
                <span>Dành Cho Developer</span>
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 space-y-5 text-xs text-neutral-300">
              {downloadTab === 'installer' && (
                <div className="space-y-4">
                  <div className="p-4 rounded-xl bg-neutral-900 border border-neutral-800 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-white text-sm">SubTrans-Setup-v2.0.0-x64.exe</span>
                      <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono">
                        Khuyến nghị • Siêu nhẹ
                      </span>
                    </div>
                    <p className="text-neutral-400 text-[11px] leading-relaxed">
                      Bộ cài siêu nhẹ (~20 MB). Tích hợp Setup Wizard tự động tải mô hình AI vào <code className="text-amber-300 font-mono">%LOCALAPPDATA%</code> trong lần mở đầu tiên với cơ chế HTTP Range Resumable (tải tiếp khi rớt mạng) và tự động cập nhật In-App mà không cần tải lại 1.1 GB dữ liệu mô hình!
                    </p>
                    <div className="flex items-center space-x-4 text-[11px] text-neutral-400 pt-1">
                      <span>Dung lượng: <b className="text-amber-400">~20 MB</b></span>
                      <span>Mô hình AI: <b>Tự động tải (~1.1 GB)</b></span>
                      <span>Hệ điều hành: <b>Windows 10/11 (64-bit)</b></span>
                    </div>
                  </div>

                  <a
                    href="https://github.com/thonghdm/video_translator/releases"
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => {
                      if (!isWebEnvironment) {
                        e.preventDefault();
                        setShowDownloadModal(false);
                        onOpenVideo();
                      }
                    }}
                    className="w-full py-3 rounded-xl bg-gradient-to-r from-amber-500 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-black font-bold text-center text-xs shadow-lg shadow-amber-500/25 flex items-center justify-center space-x-2 transition-transform active:scale-95"
                  >
                    <Download className="w-4 h-4" />
                    <span>Tải Bản Cài Đặt Siêu Nhẹ 20MB (GitHub Releases)</span>
                  </a>
                </div>
              )}

              {downloadTab === 'portable' && (
                <div className="space-y-4">
                  <div className="p-4 rounded-xl bg-neutral-900 border border-neutral-800 space-y-2">
                    <span className="font-bold text-white text-sm">SubTrans-v2.0.0-Windows-Portable.zip</span>
                    <p className="text-neutral-400 text-[11px] leading-relaxed">
                      Giải nén và chạy ngay tập tin <code>SubTrans.exe</code> không cần quyền Administrator. Tự động liên kết và lưu trữ mô hình AI trong <code>%LOCALAPPDATA%</code>.
                    </p>
                    <div className="text-[11px] text-neutral-400">
                      Dung lượng tải: <b className="text-amber-400">~25 MB</b>
                    </div>
                  </div>

                  <a
                    href="https://github.com/thonghdm/video_translator/releases"
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => {
                      if (!isWebEnvironment) {
                        e.preventDefault();
                        setShowDownloadModal(false);
                        onOpenVideo();
                      }
                    }}
                    className="w-full py-3 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white font-bold text-center text-xs border border-neutral-600 flex items-center justify-center space-x-2"
                  >
                    <Download className="w-4 h-4 text-amber-400" />
                    <span>Tải Bản Portable (~25 MB)</span>
                  </a>
                </div>
              )}

              {downloadTab === 'cli' && (
                <div className="space-y-4">
                  <p className="text-neutral-400 leading-relaxed">
                    Khởi chạy từ mã nguồn với Go 1.22+, Node.js 18+ và Wails CLI:
                  </p>
                  <div className="relative p-3.5 rounded-xl bg-black border border-neutral-800 font-mono text-[11px] text-amber-300">
                    <pre className="whitespace-pre-wrap leading-5">
                      {`git clone https://github.com/thonghdm/video_translator.git\ncd video_translator\n./run-dev.bat`}
                    </pre>
                    <button
                      onClick={handleCopyCli}
                      className="absolute top-2.5 right-2.5 px-2.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-[10px] font-sans flex items-center space-x-1"
                    >
                      {copiedCmd ? <Check className="w-3 h-3 text-emerald-400" /> : null}
                      <span>{copiedCmd ? 'Đã sao chép' : 'Sao chép'}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="h-12 px-6 border-t border-neutral-800 bg-[#12151d] flex items-center justify-between text-[11px] text-neutral-400">
              <span className="flex items-center space-x-1">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                <span>Đã kiểm tra an toàn, không chứa phần mềm quảng cáo</span>
              </span>
              <button
                onClick={() => setShowDownloadModal(false)}
                className="text-neutral-400 hover:text-white font-medium"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// memo: props từ App đã ổn định (useCallback) nên LandingPage không render lại theo từng nhịp currentTime/pipeline_status
export const LandingPage = React.memo(LandingPageComponent);
