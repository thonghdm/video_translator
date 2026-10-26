import React, { useState, useEffect, useCallback } from 'react';
import {
  Download,
  CheckCircle2,
  AlertCircle,
  Cpu,
  Sparkles,
  Clock,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  ChevronRight,
  Zap,
  Layers
} from 'lucide-react';

export interface ModelDownloadProgress {
  model_id: string;
  model_name: string;
  current_model_index: number;
  total_models: number;
  progress: number;
  model_progress: number;
  downloaded_mb: number;
  total_mb: number;
  speed_mbs: number;
  eta_seconds: number;
  status: 'idle' | 'downloading' | 'completed' | 'error' | 'cancelled';
  error_message?: string;
}

interface SetupWizardProps {
  isOpen?: boolean;
  onComplete: () => void;
}

// Định dạng thời gian giây còn lại (ETA)
function formatETA(seconds: number): string {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return `${h}h ${remM.toString().padStart(2, '0')}m`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export const SetupWizard: React.FC<SetupWizardProps> = ({ isOpen: propIsOpen, onComplete }) => {
  const [isOpen, setIsOpen] = useState<boolean>(propIsOpen ?? false);
  const [checking, setChecking] = useState<boolean>(true);
  const [downloading, setDownloading] = useState<boolean>(false);
  const [modelStatuses, setModelStatuses] = useState<Record<string, boolean>>({
    whisper_base: false,
    qwen_1_5b: false,
  });
  const [progress, setProgress] = useState<ModelDownloadProgress>({
    model_id: '',
    model_name: '',
    current_model_index: 0,
    total_models: 2,
    progress: 0,
    model_progress: 0,
    downloaded_mb: 0,
    total_mb: 1127.2,
    speed_mbs: 0,
    eta_seconds: 0,
    status: 'idle',
  });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isCompleted, setIsCompleted] = useState<boolean>(false);

  // 1. Kiểm tra trạng thái mô hình khi mount
  const checkInitialStatus = useCallback(async () => {
    setChecking(true);
    try {
      if (window.go?.main?.App?.CheckModelsReady) {
        const isReady = await window.go.main.App.CheckModelsReady();
        if (isReady) {
          setIsOpen(false);
          onComplete();
          return;
        } else {
          setIsOpen(true);
        }
      }

      if (window.go?.main?.App?.GetModelStatuses) {
        const statuses = await window.go.main.App.GetModelStatuses();
        setModelStatuses(statuses);
      }
    } catch (err: any) {
      console.warn('Không thể kiểm tra model status:', err);
      setIsOpen(true);
    } finally {
      setChecking(false);
    }
  }, [onComplete]);

  useEffect(() => {
    checkInitialStatus();
  }, [checkInitialStatus]);

  // 2. Lắng nghe các event từ Backend Wails
  useEffect(() => {
    if (!window.runtime?.EventsOn) return;

    // Lắng nghe tiến trình tải
    const unbindProgress = window.runtime.EventsOn(
      'model_download_progress',
      (payload: ModelDownloadProgress) => {
        setProgress(payload);
        if (payload.status === 'downloading') {
          setDownloading(true);
          setErrorMsg(null);
        } else if (payload.status === 'error') {
          setDownloading(false);
          setErrorMsg(payload.error_message || 'Có lỗi xảy ra khi tải mô hình');
        } else if (payload.status === 'completed') {
          setDownloading(false);
        }
      }
    );

    // Lắng nghe khi tất cả model đã sẵn sàng
    const unbindAllReady = window.runtime.EventsOn('all_models_ready', () => {
      setIsCompleted(true);
      setDownloading(false);
      setModelStatuses({
        whisper_base: true,
        qwen_1_5b: true,
      });

      // Chờ hiệu ứng thành công 1.2s rồi chuyển vào Player chính
      setTimeout(() => {
        setIsOpen(false);
        onComplete();
      }, 1200);
    });

    return () => {
      unbindProgress?.();
      unbindAllReady?.();
    };
  }, [onComplete]);

  // 3. Xử lý bắt đầu tải mô hình
  const handleStartDownload = async () => {
    setErrorMsg(null);
    setDownloading(true);
    try {
      if (window.go?.main?.App?.StartModelDownload) {
        await window.go.main.App.StartModelDownload();
      }
    } catch (err: any) {
      setDownloading(false);
      setErrorMsg(err?.message || 'Không thể bắt đầu tải model');
    }
  };

  // Không hiển thị nếu đã sẵn sàng hoặc đang kiểm tra mà không mở
  if (!isOpen && !propIsOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6 bg-slate-950/90 backdrop-blur-md select-none animate-fadeIn">
      {/* Background radial glow */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[350px] bg-indigo-500/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 left-1/3 w-[400px] h-[300px] bg-blue-500/10 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-2xl bg-slate-900/95 border border-slate-800 rounded-2xl shadow-2xl shadow-black/80 overflow-hidden flex flex-col">
        {/* Header Bar */}
        <div className="px-6 pt-6 pb-4 border-b border-slate-800/80 bg-slate-900/60 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center shadow-lg shadow-indigo-500/20 ring-1 ring-white/20">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h2 className="text-base font-bold text-white tracking-tight">
                  SubTrans Setup Wizard
                </h2>
                <span className="px-2 py-0.5 text-[10px] font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 rounded-full">
                  Offline AI Engine
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Cài đặt mô hình AI Offline (~1.1 GB) cho lần khởi chạy đầu tiên
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-1 text-slate-500 text-xs">
            <HardDrive className="w-3.5 h-3.5" />
            <span className="font-mono text-[11px]">%LOCALAPPDATA%</span>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-6">
          {/* Kiến trúc mô tả gọn gàng */}
          <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5 flex items-start space-x-3 text-xs text-slate-300">
            <ShieldCheck className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="text-slate-200 font-medium">
                Bộ cài siêu nhẹ (~25MB) • Dữ liệu mô hình độc lập hoàn toàn
              </p>
              <p className="text-slate-400 text-[11px] leading-relaxed">
                Mô hình AI chỉ cần tải một lần duy nhất vào thư mục an toàn{' '}
                <code className="text-cyan-400 bg-slate-900 px-1 py-0.5 rounded border border-slate-800">
                  %LOCALAPPDATA%\SubTrans\models
                </code>
                . Khi bạn cập nhật phần mềm SubTrans trong tương lai, mô hình sẽ không bị tải lại.
              </p>
            </div>
          </div>

          {/* Danh sách 2 Model AI */}
          <div className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center justify-between">
              <span>Danh sách mô hình cần thiết</span>
              <span className="text-[11px] font-normal text-slate-500">2 mô hình • ~1.1 GB</span>
            </div>

            {/* Model 1: Whisper Base */}
            <div className="p-3.5 rounded-xl bg-slate-950/40 border border-slate-800 flex items-center justify-between transition-colors">
              <div className="flex items-center space-x-3">
                <div className="w-9 h-9 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
                  <Cpu className="w-4 h-4" />
                </div>
                <div>
                  <div className="flex items-center space-x-2">
                    <span className="text-xs font-semibold text-slate-200">
                      Whisper Base (Speech-to-Text)
                    </span>
                    <span className="text-[10px] font-mono px-1.5 py-0.2 bg-slate-800 text-slate-300 rounded">
                      ~141 MB
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    ggml-base.bin • Nhận diện giọng nói đa ngôn ngữ siêu tốc
                  </p>
                </div>
              </div>

              <div>
                {modelStatuses.whisper_base ? (
                  <div className="flex items-center space-x-1.5 text-xs text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20 font-medium">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Đã sẵn sàng</span>
                  </div>
                ) : downloading && progress.current_model_index === 1 ? (
                  <div className="flex items-center space-x-1.5 text-xs text-blue-400 bg-blue-500/10 px-2.5 py-1 rounded-full border border-blue-500/20 font-medium animate-pulse">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Đang tải ({Math.round(progress.model_progress)}%)</span>
                  </div>
                ) : (
                  <span className="text-[11px] text-slate-500 px-2.5 py-1 bg-slate-800/50 rounded-full border border-slate-800">
                    Chờ tải
                  </span>
                )}
              </div>
            </div>

            {/* Model 2: Qwen 2.5 1.5B */}
            <div className="p-3.5 rounded-xl bg-slate-950/40 border border-slate-800 flex items-center justify-between transition-colors">
              <div className="flex items-center space-x-3">
                <div className="w-9 h-9 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
                  <Layers className="w-4 h-4" />
                </div>
                <div>
                  <div className="flex items-center space-x-2">
                    <span className="text-xs font-semibold text-slate-200">
                      Qwen 2.5 1.5B Instruct (Translator)
                    </span>
                    <span className="text-[10px] font-mono px-1.5 py-0.2 bg-slate-800 text-slate-300 rounded">
                      ~986 MB
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    qwen2.5-1.5b-instruct-q4_k_m.gguf • Dịch thuật ngữ cảnh phụ đề tự nhiên
                  </p>
                </div>
              </div>

              <div>
                {modelStatuses.qwen_1_5b ? (
                  <div className="flex items-center space-x-1.5 text-xs text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20 font-medium">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Đã sẵn sàng</span>
                  </div>
                ) : downloading && progress.current_model_index === 2 ? (
                  <div className="flex items-center space-x-1.5 text-xs text-blue-400 bg-blue-500/10 px-2.5 py-1 rounded-full border border-blue-500/20 font-medium animate-pulse">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Đang tải ({Math.round(progress.model_progress)}%)</span>
                  </div>
                ) : (
                  <span className="text-[11px] text-slate-500 px-2.5 py-1 bg-slate-800/50 rounded-full border border-slate-800">
                    Chờ tải
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Progress Bar & Realtime Metrics */}
          {(downloading || progress.progress > 0 || isCompleted) && (
            <div className="space-y-2.5 pt-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-300">
                  {isCompleted
                    ? 'Hoàn tất cài đặt mô hình!'
                    : downloading
                    ? `Đang tải: ${progress.model_name || 'Mô hình AI...'}`
                    : 'Tiến độ tải'}
                </span>
                <span className="font-bold text-blue-400 font-mono text-sm">
                  {Math.round(progress.progress)}%
                </span>
              </div>

              {/* Thanh Progress bar */}
              <div className="w-full h-3 bg-slate-800/80 rounded-full overflow-hidden p-0.5 border border-slate-700/50">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    isCompleted
                      ? 'bg-gradient-to-r from-emerald-500 to-teal-400'
                      : 'bg-gradient-to-r from-blue-600 via-indigo-500 to-cyan-400'
                  }`}
                  style={{ width: `${Math.max(2, Math.min(100, progress.progress))}%` }}
                />
              </div>

              {/* Thông số chi tiết: Tốc độ, Dung lượng, ETA */}
              <div className="grid grid-cols-3 gap-2 pt-1 text-[11px] text-slate-400">
                <div className="flex items-center space-x-1.5 bg-slate-950/40 px-2.5 py-1.5 rounded-lg border border-slate-800">
                  <Download className="w-3 h-3 text-cyan-400 shrink-0" />
                  <div className="truncate">
                    <span className="text-slate-500">Tốc độ: </span>
                    <span className="text-slate-200 font-mono font-medium">
                      {downloading ? `${progress.speed_mbs.toFixed(1)} MB/s` : '-- MB/s'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center space-x-1.5 bg-slate-950/40 px-2.5 py-1.5 rounded-lg border border-slate-800">
                  <HardDrive className="w-3 h-3 text-indigo-400 shrink-0" />
                  <div className="truncate">
                    <span className="text-slate-500">Đã tải: </span>
                    <span className="text-slate-200 font-mono font-medium">
                      {progress.downloaded_mb.toFixed(0)} / {progress.total_mb.toFixed(0)} MB
                    </span>
                  </div>
                </div>

                <div className="flex items-center space-x-1.5 bg-slate-950/40 px-2.5 py-1.5 rounded-lg border border-slate-800">
                  <Clock className="w-3 h-3 text-amber-400 shrink-0" />
                  <div className="truncate">
                    <span className="text-slate-500">Còn lại: </span>
                    <span className="text-slate-200 font-mono font-medium">
                      {downloading ? formatETA(progress.eta_seconds) : '--:--'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Lỗi nếu có */}
          {errorMsg && (
            <div className="p-3 bg-red-950/40 border border-red-800/80 rounded-xl flex items-start space-x-2.5 text-xs text-red-300">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <span className="font-semibold">Lỗi tải dữ liệu:</span>
                <p className="text-[11px] text-red-400/90 leading-relaxed">{errorMsg}</p>
                <p className="text-[10px] text-slate-400">
                  Cơ chế Resumable được kích hoạt. Bạn có thể bấm &quot;Thử lại&quot; để tiếp tục từ vị trí đã tải mà không mất dữ liệu.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-slate-800 bg-slate-900/80 flex items-center justify-between">
          <div className="flex items-center space-x-1.5 text-[11px] text-slate-400">
            <Zap className="w-3.5 h-3.5 text-amber-400" />
            <span>Hỗ trợ Resumable: Tự động tải tiếp khi có mạng trở lại</span>
          </div>

          <div className="flex items-center space-x-3">
            {checking ? (
              <div className="px-5 py-2 rounded-xl text-xs font-semibold bg-slate-800 text-slate-300 flex items-center space-x-2">
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                <span>Đang kiểm tra mô hình...</span>
              </div>
            ) : errorMsg ? (
              <button
                onClick={handleStartDownload}
                className="px-5 py-2 rounded-xl text-xs font-semibold bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-600/20 flex items-center space-x-2 transition-all cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Thử lại tải model</span>
              </button>
            ) : downloading ? (
              <button
                disabled
                className="px-5 py-2 rounded-xl text-xs font-semibold bg-indigo-600/50 text-white/80 flex items-center space-x-2 cursor-not-allowed"
              >
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Đang tải mô hình...</span>
              </button>
            ) : isCompleted ? (
              <div className="px-5 py-2 rounded-xl text-xs font-semibold bg-emerald-600 text-white flex items-center space-x-2 shadow-lg shadow-emerald-600/20 animate-pulse">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Đang vào ứng dụng...</span>
              </div>
            ) : (
              <button
                onClick={handleStartDownload}
                className="px-6 py-2.5 rounded-xl text-xs font-bold bg-gradient-to-r from-blue-600 via-indigo-600 to-indigo-700 hover:from-blue-500 hover:to-indigo-600 text-white shadow-lg shadow-indigo-600/30 flex items-center space-x-2 transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>Bắt đầu tải mô hình</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
