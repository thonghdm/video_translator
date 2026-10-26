import React, { useState, useEffect } from 'react';
import {
  Sparkles,
  Download,
  RotateCcw,
  X,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  HardDrive
} from 'lucide-react';

export interface UpdateCheckResult {
  has_update: boolean;
  current_version: string;
  latest_version: string;
  release_date: string;
  changelog: string;
  download_url: string;
  file_size_mb: number;
  mandatory: boolean;
}

export interface UpdateDownloadProgress {
  downloaded_mb: number;
  total_mb: number;
  progress: number;
  speed_mbs: number;
  status: 'downloading' | 'installing' | 'ready' | 'error';
  error_message?: string;
}

export const UpdateNotification: React.FC = () => {
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [showNotification, setShowNotification] = useState<boolean>(false);
  const [showChangelog, setShowChangelog] = useState<boolean>(false);
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const [isDownloaded, setIsDownloaded] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = useState<UpdateDownloadProgress | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 1. Tự động kiểm tra bản cập nhật khi app khởi động
  useEffect(() => {
    let mounted = true;

    const performCheck = async () => {
      try {
        if (window.go?.main?.App?.CheckForUpdate) {
          const result = await window.go.main.App.CheckForUpdate();
          if (mounted && result && result.has_update) {
            setUpdateInfo(result);
            setShowNotification(true);
          }
        }
      } catch (err: any) {
        // Lỗi kiểm tra update trong im lặng để không gián đoạn trải nghiệm người dùng
        console.log('Update check skipped or failed:', err?.message || err);
      }
    };

    // Kiểm tra sau 2 giây khi app đã sẵn sàng
    const timer = setTimeout(performCheck, 2000);
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, []);

  // 2. Lắng nghe event tiến trình update và hoàn tất từ backend
  useEffect(() => {
    if (!window.runtime?.EventsOn) return;

    const unbindProgress = window.runtime.EventsOn(
      'update_download_progress',
      (payload: UpdateDownloadProgress) => {
        setDownloadProgress(payload);
        if (payload.status === 'ready') {
          setIsUpdating(false);
          setIsDownloaded(true);
        } else if (payload.status === 'error') {
          setIsUpdating(false);
          setErrorMsg(payload.error_message || 'Lỗi cập nhật');
        }
      }
    );

    const unbindDownloaded = window.runtime.EventsOn('update_downloaded', () => {
      setIsUpdating(false);
      setIsDownloaded(true);
    });

    return () => {
      unbindProgress?.();
      unbindDownloaded?.();
    };
  }, []);

  // 3. Xử lý tải và cài đặt cập nhật
  const handleApplyUpdate = async () => {
    if (!updateInfo?.download_url) return;
    setErrorMsg(null);
    setIsUpdating(true);

    try {
      if (window.go?.main?.App?.ApplyUpdate) {
        await window.go.main.App.ApplyUpdate(updateInfo.download_url);
        setIsDownloaded(true);
        setIsUpdating(false);
      }
    } catch (err: any) {
      setIsUpdating(false);
      setErrorMsg(err?.message || 'Không thể cài đặt bản cập nhật');
    }
  };

  // 4. Xử lý khởi động lại ứng dụng
  const handleRestart = async () => {
    try {
      if (window.go?.main?.App?.RestartApp) {
        await window.go.main.App.RestartApp();
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Không thể khởi động lại app');
    }
  };

  if (!showNotification || !updateInfo) {
    return null;
  }

  return (
    <div className="fixed top-12 right-4 z-50 max-w-sm w-full animate-slideIn select-none">
      <div className="bg-slate-900/95 border border-indigo-500/30 rounded-2xl p-4 shadow-2xl shadow-black/80 backdrop-blur-md ring-1 ring-white/10 text-slate-200">
        {/* Top Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-xs font-bold text-white">Bản cập nhật mới</span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-semibold border border-indigo-500/30">
                  v{updateInfo.latest_version}
                </span>
              </div>
              <p className="text-[11px] text-slate-400">
                Phiên bản hiện tại: v{updateInfo.current_version} • {updateInfo.file_size_mb || 20} MB
              </p>
            </div>
          </div>

          {!updateInfo.mandatory && !isUpdating && !isDownloaded && (
            <button
              onClick={() => setShowNotification(false)}
              className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
              title="Để sau"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Thông tin bảo toàn Model AI */}
        <div className="mt-3 py-1.5 px-2.5 rounded-lg bg-slate-950/60 border border-slate-800 flex items-center space-x-2 text-[11px] text-slate-300">
          <HardDrive className="w-3 h-3 text-cyan-400 shrink-0" />
          <span>Chỉ cập nhật file thực thi .exe (~20MB), giữ nguyên 100% Model AI</span>
        </div>

        {/* Changelog mở rộng */}
        {updateInfo.changelog && (
          <div className="mt-2">
            <button
              onClick={() => setShowChangelog((v) => !v)}
              className="text-[11px] text-indigo-400 hover:text-indigo-300 flex items-center space-x-1 cursor-pointer font-medium"
            >
              <span>{showChangelog ? 'Ẩn nội dung mới' : 'Xem nội dung mới'}</span>
              {showChangelog ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>

            {showChangelog && (
              <div className="mt-1.5 p-2 rounded-lg bg-slate-950/80 border border-slate-800 text-[11px] text-slate-300 max-h-28 overflow-y-auto whitespace-pre-line leading-relaxed font-sans">
                {updateInfo.changelog}
              </div>
            )}
          </div>
        )}

        {/* Trạng thái tải cập nhật */}
        {isUpdating && (
          <div className="mt-3 space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-400 flex items-center space-x-1.5">
                <RefreshCw className="w-3 h-3 animate-spin text-indigo-400" />
                <span>Đang tải cập nhật...</span>
              </span>
              <span className="font-mono text-indigo-400 font-bold">
                {downloadProgress ? Math.round(downloadProgress.progress) : 0}%
              </span>
            </div>

            <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-200"
                style={{ width: `${downloadProgress?.progress || 0}%` }}
              />
            </div>

            {downloadProgress && downloadProgress.speed_mbs > 0 && (
              <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                <span>{downloadProgress.downloaded_mb.toFixed(1)} / {downloadProgress.total_mb.toFixed(1)} MB</span>
                <span>{downloadProgress.speed_mbs.toFixed(1)} MB/s</span>
              </div>
            )}
          </div>
        )}

        {/* Lỗi nếu có */}
        {errorMsg && (
          <div className="mt-2.5 p-2 rounded-lg bg-red-950/50 border border-red-800/80 text-[11px] text-red-300 flex items-center space-x-2">
            <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
            <span className="truncate">{errorMsg}</span>
          </div>
        )}

        {/* Action Buttons */}
        <div className="mt-3.5 flex items-center justify-end space-x-2">
          {isDownloaded ? (
            <div className="w-full space-y-2">
              <div className="flex items-center space-x-1.5 text-xs text-emerald-400 font-medium">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>Đã tải xong bản cập nhật mới!</span>
              </div>
              <button
                onClick={handleRestart}
                className="w-full py-2 px-3 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/30 flex items-center justify-center space-x-2 transition-all cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Khởi động lại ngay</span>
              </button>
            </div>
          ) : isUpdating ? (
            <button
              disabled
              className="w-full py-2 px-3 rounded-xl text-xs font-semibold bg-indigo-600/50 text-white/70 flex items-center justify-center space-x-2 cursor-not-allowed"
            >
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span>Đang cài đặt...</span>
            </button>
          ) : (
            <>
              {!updateInfo.mandatory && (
                <button
                  onClick={() => setShowNotification(false)}
                  className="px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  Để sau
                </button>
              )}
              <button
                onClick={handleApplyUpdate}
                className="px-4 py-1.5 rounded-xl text-xs font-bold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-md shadow-indigo-600/30 flex items-center space-x-1.5 transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Cập nhật ngay</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
