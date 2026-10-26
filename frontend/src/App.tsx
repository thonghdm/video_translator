import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import {
  Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  FolderOpen, List, Subtitles, AlertCircle, FileText,
  RefreshCw
} from 'lucide-react';
import { SubtitleItem, upsertSubtitles, findSubtitleAtTime } from './lib/subtitles';

// Định nghĩa kiểu dữ liệu đồng bộ với Backend
interface VideoInfo {
  path: string;
  duration_sec: number;
  block_sec: number;
  total_blocks: number;
  media_url: string;
  playable: boolean;
  playable_reason: string;
  done_blocks: number[];
}

interface PipelineStatus {
  state: string;
  message: string;
  block: number;
  done_blocks: number;
  total_blocks: number;
  ahead_sec: number;
  video: string;
}

type SubtitleMode = 'off' | 'en' | 'vi' | 'bilingual';

// Wails runtime mock/real bindings
declare global {
  interface Window {
    runtime?: {
      EventsOn: (eventName: string, callback: (...args: any[]) => void) => () => void;
    };
    go?: {
      main?: {
        App?: {
          SelectVideoFile: () => Promise<string>;
          OpenVideo: (path: string) => Promise<VideoInfo>;
          StartPipeline: (path: string, startSec: number) => Promise<void>;
          SeekTo: (path: string, startSec: number) => Promise<void>;
          UpdatePlayhead: (path: string, sec: number, playing: boolean) => Promise<void>;
          StopPipeline: () => Promise<void>;
          LoadCachedSubtitles: (path: string) => Promise<SubtitleItem[]>;
          ExportSRT: (path: string, mode: string) => Promise<string>;
        };
      };
    };
  }
}

// Format giây sang chuỗi MM:SS hoặc HH:MM:SS
function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Component danh sách phụ đề bên cạnh (dùng React.memo để tránh re-render liên tục khi video phát)
const SubtitleListPanel = memo(({
  subtitles,
  activeId,
  onSeek,
  onClose,
}: {
  subtitles: SubtitleItem[];
  activeId: number | null;
  onSeek: (sec: number) => void;
  onClose: () => void;
}) => {
  const activeItemRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeId]);

  return (
    <aside className="w-80 h-full bg-[#13161c] border-l border-player-border flex flex-col z-20">
      <div className="h-10 border-b border-player-border px-3 flex items-center justify-between">
        <span className="text-xs font-semibold text-neutral-300">
          Danh sách phụ đề ({subtitles.length})
        </span>
        <button
          onClick={onClose}
          className="text-neutral-400 hover:text-white text-xs px-2 py-0.5 rounded"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {subtitles.length === 0 ? (
          <div className="text-center py-8 text-neutral-500 text-xs">
            Chưa có phụ đề nào được xử lý
          </div>
        ) : (
          subtitles.map((item) => {
            const isActive = item.id === activeId;
            return (
              <div
                key={item.id}
                ref={isActive ? activeItemRef : null}
                onClick={() => onSeek(item.start_sec)}
                className={`p-2 rounded cursor-pointer text-xs transition-colors ${
                  isActive
                    ? 'bg-amber-500/20 border-l-2 border-amber-400 text-white'
                    : 'hover:bg-neutral-800/60 text-neutral-300'
                }`}
              >
                <div className="flex justify-between text-[10px] text-neutral-400 mb-0.5">
                  <span>{formatTime(item.start_sec)} - {formatTime(item.end_sec)}</span>
                  {item.translated && <span className="text-emerald-400">Đã dịch</span>}
                </div>
                <div className="text-neutral-300 select-text">{item.source_text}</div>
                {item.target_text ? (
                  <div className="text-amber-300 mt-0.5 font-medium select-text">
                    {item.target_text}
                  </div>
                ) : (
                  <div className="text-neutral-500 italic text-[11px] mt-0.5 flex items-center space-x-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                    <span>Đang dịch...</span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
});

export const App: React.FC = () => {
  // Video & Playback State
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [volume, setVolume] = useState<number>(1.0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // Subtitle State
  const [subtitles, setSubtitles] = useState<SubtitleItem[]>([]);
  const [currentSubtitle, setCurrentSubtitle] = useState<SubtitleItem | null>(null);
  const [subtitleMode, setSubtitleMode] = useState<SubtitleMode>('bilingual');
  const [subtitleOffset, setSubtitleOffset] = useState<number>(0.0);
  const [showSubPanel, setShowSubPanel] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string>('');

  // Pipeline Status State
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus | null>(null);
  const [doneBlocks, setDoneBlocks] = useState<number[]>([]);

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const seekDebounceTimerRef = useRef<any>(null);
  const lastPlayheadUpdateRef = useRef<number>(0);
  const lastUiTimeRef = useRef<number>(0);

  // Hiển thị toast thông báo ngắn
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(''), 2000);
  };

  // Mở file video
  const handleOpenVideo = async (filePath?: string) => {
    let selected = filePath;
    if (!selected && window.go?.main?.App) {
      try {
        selected = await window.go.main.App.SelectVideoFile();
      } catch (err) {
        console.error('Lỗi mở file dialog:', err);
      }
    }

    if (!selected) return;

    try {
      // 1. Reset state cũ
      setSubtitles([]);
      setCurrentSubtitle(null);
      setDoneBlocks([]);

      // 2. Gọi OpenVideo backend
      const info = await window.go?.main?.App?.OpenVideo(selected);
      if (!info) return;

      setVideoInfo(info);
      setDuration(info.duration_sec);
      setDoneBlocks(info.done_blocks || []);

      // 3. Nạp cache phụ đề nếu có
      const cached = await window.go?.main?.App?.LoadCachedSubtitles(selected);
      if (cached && cached.length > 0) {
        setSubtitles(cached);
      }

      // 4. Phát video ngay lập tức (không chờ pipeline)
      if (videoRef.current) {
        videoRef.current.src = info.media_url;
        videoRef.current.play().catch(() => {});
        setIsPlaying(true);
      }

      // 5. Bắt đầu pipeline ngầm
      await window.go?.main?.App?.StartPipeline(selected, 0);
    } catch (err: any) {
      alert(`Không thể mở video: ${err?.message || err}`);
    }
  };

  // Đăng ký lắng nghe sự kiện từ Wails backend
  useEffect(() => {
    if (!window.runtime) return;

    // Lắng nghe chunk phụ đề mới
    const unChunk = window.runtime.EventsOn('new_subtitle_chunk', (chunk: any) => {
      if (chunk.video !== videoInfo?.path) return;
      setSubtitles((prev) => upsertSubtitles(prev, chunk.items || []));
      if (chunk.final) {
        setDoneBlocks((prev) => {
          if (!prev.includes(chunk.block)) {
            const next = [...prev, chunk.block];
            next.sort((a, b) => a - b);
            return next;
          }
          return prev;
        });
      }
    });

    // Lắng nghe trạng thái pipeline
    const unStatus = window.runtime.EventsOn('pipeline_status', (st: PipelineStatus) => {
      if (st.video !== videoInfo?.path) return;
      setPipelineStatus(st);
    });

    return () => {
      unChunk();
      unStatus();
    };
  }, [videoInfo?.path]);

  // Đồng bộ phụ đề tốc độ cao với requestVideoFrameCallback / requestAnimationFrame
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let handle: number;

    const syncFrame = (_now: DOMHighResTimeStamp, metadata?: any) => {
      const mediaTime = metadata?.mediaTime ?? video.currentTime;
      if (Math.abs(mediaTime - lastUiTimeRef.current) >= 0.25) {
        lastUiTimeRef.current = mediaTime;
        setCurrentTime(mediaTime);
      }

      // Tra cứu phụ đề bằng Binary Search với offset
      const sub = findSubtitleAtTime(subtitles, mediaTime + subtitleOffset);
      setCurrentSubtitle((prev) =>
        prev?.id === sub?.id &&
        prev?.target_text === sub?.target_text &&
        prev?.source_text === sub?.source_text
          ? prev
          : sub
      );

      // Báo cáo playhead lên backend mỗi ~2 giây
      const nowTs = Date.now();
      if (videoInfo?.path && nowTs - lastPlayheadUpdateRef.current > 2000) {
        lastPlayheadUpdateRef.current = nowTs;
        window.go?.main?.App?.UpdatePlayhead(videoInfo.path, mediaTime, !video.paused);
      }

      if ('requestVideoFrameCallback' in video) {
        handle = (video as any).requestVideoFrameCallback(syncFrame);
      } else {
        handle = requestAnimationFrame(syncFrame);
      }
    };

    if ('requestVideoFrameCallback' in video) {
      handle = (video as any).requestVideoFrameCallback(syncFrame);
    } else {
      handle = requestAnimationFrame(syncFrame);
    }

    return () => {
      if ('cancelVideoFrameCallback' in video) {
        (video as any).cancelVideoFrameCallback(handle);
      } else {
        cancelAnimationFrame(handle);
      }
    };
  }, [subtitles, subtitleOffset, videoInfo?.path]);

  // Cập nhật volume và playbackRate cho thẻ video DOM
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.playbackRate = playbackRate;
    }
  }, [volume, playbackRate]);

  // Điều khiển Play / Pause
  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play();
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  // Tua video an toàn với Debounce 250ms chống dồn lệnh SeekTo
  const seekVideo = useCallback((targetSec: number) => {
    if (!videoRef.current || !videoInfo) return;

    const clamped = Math.max(0, Math.min(targetSec, duration));
    videoRef.current.currentTime = clamped;
    setCurrentTime(clamped);

    const blockSec = videoInfo.block_sec || 30;
    const targetBlock = Math.floor(clamped / blockSec);

    // Nếu tua vào block chưa dịch xong, báo toast cho người dùng biết
    if (!doneBlocks.includes(targetBlock)) {
      showToast('⚡ Đang xử lý phụ đề đoạn này...');
    }

    clearTimeout(seekDebounceTimerRef.current);
    seekDebounceTimerRef.current = setTimeout(() => {
      window.go?.main?.App?.SeekTo(videoInfo.path, clamped);
    }, 200);
  }, [videoInfo, duration, doneBlocks]);

  // Phím tắt điều khiển
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Bỏ qua khi đang nhập vào input/textarea
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seekVideo(currentTime - (e.shiftKey ? 30 : 5));
          break;
        case 'ArrowRight':
          e.preventDefault();
          seekVideo(currentTime + (e.shiftKey ? 30 : 5));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setVolume((v) => Math.min(1.0, v + 0.05));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setVolume((v) => Math.max(0.0, v - 0.05));
          break;
        case 'KeyM':
          e.preventDefault();
          setIsMuted((m) => !m);
          break;
        case 'KeyF':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'KeyV':
          e.preventDefault();
          setSubtitleMode((mode) => {
            const nextMode: Record<SubtitleMode, SubtitleMode> = {
              bilingual: 'vi',
              vi: 'en',
              en: 'off',
              off: 'bilingual',
            };
            const n = nextMode[mode];
            showToast(`Chế độ phụ đề: ${n.toUpperCase()}`);
            return n;
          });
          break;
        case 'KeyG':
          e.preventDefault();
          setSubtitleOffset((o) => {
            const next = Math.round((o - 0.1) * 10) / 10;
            showToast(`Lệch phụ đề: ${next > 0 ? `+${next}` : next}s`);
            return next;
          });
          break;
        case 'KeyH':
          e.preventDefault();
          setSubtitleOffset((o) => {
            const next = Math.round((o + 0.1) * 10) / 10;
            showToast(`Lệch phụ đề: ${next > 0 ? `+${next}` : next}s`);
            return next;
          });
          break;
        case 'KeyO':
          if (e.ctrlKey) {
            e.preventDefault();
            handleOpenVideo();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentTime, seekVideo]);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  // Xuất file SRT
  const handleExportSRT = async (mode: string) => {
    if (!videoInfo?.path) return;
    try {
      const res = await window.go?.main?.App?.ExportSRT(videoInfo.path, mode);
      if (res) showToast(`Đã xuất phụ đề: ${res}`);
    } catch (err: any) {
      alert(`Xuất SRT thất bại: ${err?.message || err}`);
    }
  };

  // Kích hoạt dịch đón đầu trước 1 đoạn
  const handleTriggerBufferAhead = () => {
    if (!videoInfo?.path) return;
    showToast('Đang tăng tốc đón đầu phụ đề phía trước...');
    window.go?.main?.App?.SeekTo(videoInfo.path, currentTime);
  };

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-screen w-screen bg-[#0d0f12] text-[#f1f2f6] select-none overflow-hidden"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file && (file as any).path) {
          handleOpenVideo((file as any).path);
        }
      }}
    >
      {/* 1. Header Bar */}
      <header className="h-12 border-b border-player-border px-4 flex items-center justify-between bg-player-surface z-10">
        <div className="flex items-center space-x-3 truncate">
          <button
            onClick={() => handleOpenVideo()}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-black font-semibold text-xs rounded transition-colors shadow"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span>Mở video</span>
          </button>
          <span className="text-xs font-medium text-neutral-300 truncate max-w-sm">
            {videoInfo?.path ? videoInfo.path.split(/[\\/]/).pop() : 'Chưa mở file'}
          </span>
        </div>

        {/* Right Header Controls */}
        <div className="flex items-center space-x-3 text-xs">
          {/* Dynamic Pipeline Status Label */}
          {pipelineStatus && (
            <div className="flex items-center space-x-2 px-2.5 py-1 bg-neutral-800/80 rounded-full border border-neutral-700">
              <span className={`w-2 h-2 rounded-full ${
                pipelineStatus.state === 'ahead' ? 'bg-cyan-400' :
                pipelineStatus.state === 'catching_up' ? 'bg-amber-400 animate-pulse' :
                pipelineStatus.state === 'done' ? 'bg-emerald-400' : 'bg-blue-400 animate-pulse'
              }`} />
              <span className="text-neutral-300 text-[11px]">
                {pipelineStatus.state === 'ahead' && `Đón đầu phía trước (${Math.round(pipelineStatus.ahead_sec)}s)`}
                {pipelineStatus.state === 'catching_up' && 'Đang đuổi kịp playhead...'}
                {pipelineStatus.state === 'processing' && `Đang xử lý đoạn ${pipelineStatus.done_blocks}/${pipelineStatus.total_blocks}`}
                {pipelineStatus.state === 'backfill' && `Bù phụ đề đoạn trước...`}
                {pipelineStatus.state === 'done' && 'Đã hoàn tất toàn bộ video'}
              </span>
            </div>
          )}

          {/* Nút dịch đón đầu trước 1 khúc */}
          <button
            onClick={handleTriggerBufferAhead}
            className="flex items-center space-x-1 px-2 py-1 bg-neutral-800 hover:bg-neutral-700 text-amber-300 hover:text-amber-200 rounded border border-neutral-700 text-xs transition-colors"
            title="Kích thích pipeline dịch đón đầu trước một đoạn"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Dịch trước</span>
          </button>

          {/* Subtitle Mode Button */}
          <button
            onClick={() => {
              const modes: SubtitleMode[] = ['bilingual', 'vi', 'en', 'off'];
              const next = modes[(modes.indexOf(subtitleMode) + 1) % modes.length];
              setSubtitleMode(next);
            }}
            className="flex items-center space-x-1 px-2.5 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-300 text-xs border border-neutral-700"
          >
            <Subtitles className="w-3.5 h-3.5 text-amber-400" />
            <span>
              {subtitleMode === 'bilingual' && 'Song ngữ'}
              {subtitleMode === 'vi' && 'Tiếng Việt'}
              {subtitleMode === 'en' && 'Tiếng Anh'}
              {subtitleMode === 'off' && 'Tắt phụ đề'}
            </span>
          </button>

          {/* Panel danh sách toggle */}
          <button
            onClick={() => setShowSubPanel((v) => !v)}
            className={`p-1.5 rounded text-neutral-300 hover:bg-neutral-800 ${showSubPanel ? 'bg-neutral-800 text-amber-400' : ''}`}
            title="Bật/tắt danh sách phụ đề"
          >
            <List className="w-4 h-4" />
          </button>

          {/* Xuất SRT menu */}
          <button
            onClick={() => handleExportSRT(subtitleMode === 'off' ? 'bilingual' : subtitleMode)}
            className="p-1.5 rounded text-neutral-300 hover:bg-neutral-800"
            title="Xuất file SRT"
          >
            <FileText className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* 2. Main Content Area */}
      <div className="flex-1 flex relative overflow-hidden bg-black">
        {/* Toast thông báo phím tắt */}
        {toastMessage && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 bg-black/80 text-amber-300 border border-amber-500/50 rounded text-xs shadow-lg backdrop-blur">
            {toastMessage}
          </div>
        )}

        {/* Video Player Box */}
        <div className="flex-1 flex items-center justify-center relative">
          <video
            ref={videoRef}
            className="max-h-full max-w-full object-contain"
            onClick={togglePlay}
            muted={isMuted}
            onEnded={() => setIsPlaying(false)}
          />

          {/* Codec cảnh báo không tương thích */}
          {videoInfo && !videoInfo.playable && (
            <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center p-6 text-center z-30">
              <AlertCircle className="w-12 h-12 text-amber-400 mb-3" />
              <h3 className="text-base font-semibold text-white mb-2">Định dạng không được hỗ trợ phát trực tiếp</h3>
              <p className="text-xs text-neutral-300 max-w-md mb-4">{videoInfo.playable_reason}</p>
              <button
                onClick={() => alert('Tính năng chuyển mã nền tự động đang được chuẩn bị.')}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-black text-xs font-bold rounded shadow"
              >
                Chuyển mã để phát
              </button>
            </div>
          )}

          {/* Overlay phụ đề phong cách VLC (pointer-events-none) */}
          {currentSubtitle && subtitleMode !== 'off' && (
            <div className="absolute bottom-16 left-0 right-0 pointer-events-none flex flex-col items-center px-8 z-20">
              <div className="bg-black/75 px-4 py-2 rounded-lg max-w-3xl text-center shadow-lg backdrop-blur-sm border border-white/5 space-y-1">
                {(subtitleMode === 'en' || subtitleMode === 'bilingual') && (
                  <div className="text-neutral-300 text-sm md:text-base font-medium drop-shadow leading-relaxed">
                    {currentSubtitle.source_text}
                  </div>
                )}
                {(subtitleMode === 'vi' || subtitleMode === 'bilingual') && (
                  currentSubtitle.target_text ? (
                    <div className="text-amber-300 text-base md:text-lg font-bold drop-shadow leading-relaxed">
                      {currentSubtitle.target_text}
                    </div>
                  ) : subtitleMode === 'vi' ? (
                    <div className="text-neutral-400 text-sm md:text-base italic drop-shadow flex items-center justify-center gap-1.5">
                      <span className="inline-block w-2 h-2 rounded-full bg-amber-400/60 animate-pulse" />
                      <span>{currentSubtitle.source_text}</span>
                    </div>
                  ) : null
                )}
              </div>
            </div>
          )}
        </div>

        {/* Side Panel danh sách phụ đề */}
        {showSubPanel && (
          <SubtitleListPanel
            subtitles={subtitles}
            activeId={currentSubtitle?.id ?? null}
            onSeek={seekVideo}
            onClose={() => setShowSubPanel(false)}
          />
        )}
      </div>

      {/* 3. Bottom Controls & Seekbar */}
      <footer className="h-16 bg-player-surface border-t border-player-border px-4 flex flex-col justify-center space-y-1 z-30">
        {/* Seekbar với dải màu hiển thị các block đã xong (done_blocks) */}
        <div className="relative w-full h-3 flex items-center cursor-pointer group">
          {/* Thanh nền tổng thời gian */}
          <div className="w-full h-1.5 bg-neutral-800 rounded relative overflow-hidden">
            {/* Dải màu hiển thị các block đã hoàn tất xử lý */}
            {duration > 0 && doneBlocks.map((b) => {
              const blockSec = videoInfo?.block_sec || 30;
              const left = (b * blockSec / duration) * 100;
              const width = (blockSec / duration) * 100;
              return (
                <div
                  key={b}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  className="absolute top-0 bottom-0 bg-amber-500/35"
                />
              );
            })}

            {/* Thanh tiến độ đang phát */}
            <div
              style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
              className="h-full bg-amber-400 relative"
            />
          </div>

          {/* Input Range ẩn để nhận sự kiện kéo thả */}
          <input
            type="range"
            min={0}
            max={duration || 100}
            step={0.1}
            value={currentTime}
            onChange={(e) => setCurrentTime(parseFloat(e.target.value))}
            onMouseUp={(e) => seekVideo(parseFloat((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => seekVideo(parseFloat((e.target as HTMLInputElement).value))}
            className="absolute inset-0 opacity-0 cursor-pointer w-full"
          />
        </div>

        {/* Control Buttons */}
        <div className="flex items-center justify-between text-xs text-neutral-300">
          <div className="flex items-center space-x-3">
            <button
              onClick={togglePlay}
              className="p-1.5 hover:text-white rounded"
              title="Phát/Tạm dừng (Space)"
            >
              {isPlaying ? <Pause className="w-4 h-4 text-amber-400" /> : <Play className="w-4 h-4" />}
            </button>

            {/* Volume Control */}
            <div className="flex items-center space-x-1.5">
              <button onClick={() => setIsMuted((m) => !m)} className="hover:text-white">
                {isMuted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={isMuted ? 0 : volume}
                onChange={(e) => {
                  setVolume(parseFloat(e.target.value));
                  setIsMuted(false);
                }}
                className="w-16 h-1 bg-neutral-700 accent-amber-400 cursor-pointer"
              />
            </div>

            {/* Time Display */}
            <span className="text-[11px] text-neutral-400 font-mono">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          {/* Right Controls */}
          <div className="flex items-center space-x-3">
            {/* Playback speed selector */}
            <select
              value={playbackRate}
              onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
              className="bg-neutral-800 text-[11px] px-1.5 py-0.5 rounded border border-neutral-700 text-neutral-300 cursor-pointer"
            >
              <option value="0.5">0.5×</option>
              <option value="0.75">0.75×</option>
              <option value="1.0">1.0×</option>
              <option value="1.25">1.25×</option>
              <option value="1.5">1.5×</option>
              <option value="2.0">2.0×</option>
            </select>

            {/* Fullscreen Button */}
            <button onClick={toggleFullscreen} className="hover:text-white" title="Toàn màn hình (F)">
              {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
