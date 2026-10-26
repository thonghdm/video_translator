import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  ChevronRight,
  Cloud,
  Film,
  Folder,
  FolderPlus,
  HardDrive,
  Link2,
  Loader2,
  LogOut,
  Play,
  RefreshCw,
  Search,
  Captions,
  Users,
  X,
} from 'lucide-react';

/** Đồng bộ với struct DriveItem (drive_manager.go) */
export interface DriveItem {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  thumbnail_link: string;
  is_folder: boolean;
  duration_sec: number;
  subtitle_id: string;
  subtitle_name: string;
}

interface DriveApi {
  LoginGoogleDrive: () => Promise<void>;
  IsGoogleDriveLoggedIn: () => Promise<boolean>;
  LogoutGoogleDrive: () => Promise<void>;
  ListDriveItems: (folderID: string) => Promise<DriveItem[] | null>;
  ResolveDriveLink?: (link: string) => Promise<{
    kind: 'folder' | 'file';
    id: string;
    name: string;
    duration_sec: number;
    subtitle_id: string;
  } | null>;
}

const getApi = (): DriveApi | undefined => (window.go?.main?.App as unknown as DriveApi | undefined);

interface Crumb {
  id: string;
  name: string;
}

const ROOT_MY_DRIVE: Crumb = { id: 'root', name: 'Drive của tôi' };
const ROOT_SHARED: Crumb = { id: 'shared_with_me', name: 'Được chia sẻ với tôi' };

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const rr = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${rr}` : `${mm}:${rr}`;
}

interface GoogleDrivePickerProps {
  /** Gọi khi người dùng bấm "Phát & Dịch ngay" với 1 video */
  onPlay: (item: DriveItem) => void;
  /** Gọi khi người dùng muốn thêm 1 thư mục Drive vào cây thư mục bài học */
  onAddFolderToTree?: (folder: { id: string; name: string }) => void;
  /** Báo lỗi/thông báo ngắn lên toast của App (tùy chọn) */
  onToast?: (msg: string) => void;
}

export const GoogleDrivePicker: React.FC<GoogleDrivePickerProps> = ({ onPlay, onAddFolderToTree, onToast }) => {
  const [loggedIn, setLoggedIn] = useState<boolean>(false);
  const [checking, setChecking] = useState<boolean>(true);
  const [loggingIn, setLoggingIn] = useState<boolean>(false);
  const [open, setOpen] = useState<boolean>(false);

  const [path, setPath] = useState<Crumb[]>([ROOT_MY_DRIVE]);
  const activeTab = path[0]?.id === 'shared_with_me' ? 'shared_with_me' : 'root';
  const [items, setItems] = useState<DriveItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reqSeq = useRef(0); // chống race khi bấm điều hướng nhanh

  const toast = useCallback((msg: string) => onToast?.(msg), [onToast]);

  // Kiểm tra trạng thái đăng nhập khi mở app + lắng nghe event từ backend
  useEffect(() => {
    let alive = true;
    const api = getApi();
    if (api?.IsGoogleDriveLoggedIn) {
      api
        .IsGoogleDriveLoggedIn()
        .then((ok) => alive && setLoggedIn(!!ok))
        .catch(() => alive && setLoggedIn(false))
        .finally(() => alive && setChecking(false));
    } else {
      setChecking(false);
    }

    const offOk = window.runtime?.EventsOn('drive_auth_success', () => {
      setLoggedIn(true);
      setLoggingIn(false);
    });
    const offErr = window.runtime?.EventsOn('drive_auth_error', (msg: string) => {
      setLoggingIn(false);
      toast(`Đăng nhập Google Drive thất bại: ${msg}`);
    });
    return () => {
      alive = false;
      offOk?.();
      offErr?.();
    };
  }, [toast]);

  const loadFolder = useCallback(async (folderId: string) => {
    const api = getApi();
    if (!api?.ListDriveItems) return;
    const seq = ++reqSeq.current;
    setLoading(true);
    setError('');
    setSelectedId(null);
    try {
      const res = await api.ListDriveItems(folderId);
      if (seq !== reqSeq.current) return;
      setItems(res ?? []);
    } catch (err: any) {
      if (seq !== reqSeq.current) return;
      const msg = String(err?.message ?? err);
      setItems([]);
      setError(msg);
      if (msg.includes('chưa kết nối')) setLoggedIn(false);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, []);

  const current = path[path.length - 1];

  useEffect(() => {
    if (open && loggedIn) {
      loadFolder(current.id);
    }
  }, [open, loggedIn, current.id, loadFolder]);

  // Phím Esc đóng modal
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const handleLogin = async () => {
    const api = getApi();
    if (!api?.LoginGoogleDrive || loggingIn) return;
    setLoggingIn(true);
    try {
      await api.LoginGoogleDrive();
      setLoggedIn(true);
      toast('Đã kết nối Google Drive');
    } catch (err: any) {
      toast(`Không thể kết nối Google Drive: ${err?.message ?? err}`);
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    const api = getApi();
    if (!api?.LogoutGoogleDrive) return;
    try {
      await api.LogoutGoogleDrive();
    } catch (err: any) {
      toast(`Lỗi đăng xuất: ${err?.message ?? err}`);
    }
    setLoggedIn(false);
    setOpen(false);
    setItems([]);
    setPath([ROOT_MY_DRIVE]);
  };

  const switchTab = (tab: 'root' | 'shared_with_me') => {
    if (activeTab === tab && path.length === 1) return;
    setSearch('');
    if (tab === 'root') {
      setPath([ROOT_MY_DRIVE]);
    } else {
      setPath([ROOT_SHARED]);
    }
  };

  const enterFolder = (item: DriveItem) => {
    setSearch('');
    setPath((p) => [...p, { id: item.id, name: item.name }]);
  };

  const goToCrumb = (index: number) => {
    setSearch('');
    setPath((p) => p.slice(0, index + 1));
  };

  const playItem = (item: DriveItem) => {
    setOpen(false);
    onPlay(item);
  };

  // Dán link Drive (thư mục -> thêm vào cây; video -> phát ngay)
  const [linkText, setLinkText] = useState<string>('');
  const [linkBusy, setLinkBusy] = useState<boolean>(false);

  const processLink = useCallback(
    async (text: string) => {
      const link = text.trim();
      if (!link || linkBusy) return;
      const api = getApi();
      if (!api?.ResolveDriveLink) {
        toast('Backend chưa hỗ trợ link Drive');
        return;
      }
      setLinkBusy(true);
      try {
        const info = await api.ResolveDriveLink(link);
        if (!info) return;
        setLinkText('');
        setOpen(false);
        if (info.kind === 'folder') {
          onAddFolderToTree?.({ id: info.id, name: info.name });
        } else {
          onPlay({
            id: info.id,
            name: info.name,
            mime_type: 'video/mp4',
            size: 0,
            thumbnail_link: '',
            is_folder: false,
            duration_sec: info.duration_sec,
            subtitle_id: info.subtitle_id || '',
            subtitle_name: '',
          });
        }
      } catch (err: any) {
        toast(`Link Drive không dùng được: ${err?.message ?? err}`);
      } finally {
        setLinkBusy(false);
      }
    },
    [linkBusy, onAddFolderToTree, onPlay, toast]
  );

  // Nút nhanh: đọc link từ clipboard và thêm thẳng vào cây
  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        toast('Clipboard đang trống - hãy copy link Google Drive trước');
        return;
      }
      await processLink(text);
    } catch {
      setOpen(true);
      toast('Không đọc được clipboard - hãy dán link vào ô trong cửa sổ Drive');
    }
  };

  const visibleItems = useMemo(() => {
    const kw = search.trim().toLowerCase();
    if (!kw) return items;
    return items.filter((it) => it.name.toLowerCase().includes(kw));
  }, [items, search]);

  const selectedItem = useMemo(
    () => items.find((it) => it.id === selectedId) ?? null,
    [items, selectedId]
  );
  const selectedVideo = selectedItem && !selectedItem.is_folder ? selectedItem : null;
  const selectedFolder = selectedItem && selectedItem.is_folder ? selectedItem : null;

  // ---------------- Thanh điều khiển (toolbar) ----------------
  const toolbar = checking ? (
    <div className="flex items-center h-8 px-2 text-xs text-neutral-500">
      <Loader2 className="w-3.5 h-3.5 animate-spin" />
    </div>
  ) : !loggedIn ? (
    <button
      onClick={handleLogin}
      disabled={loggingIn}
      className="flex items-center space-x-1.5 h-8 px-2.5 bg-neutral-900/90 hover:bg-neutral-800 disabled:opacity-60 text-neutral-300 hover:text-sky-400 font-medium text-xs rounded-lg border border-neutral-700/80 transition-all shrink-0 whitespace-nowrap"
      title="Đăng nhập Google để duyệt và dịch video ngay trên Drive"
    >
      {loggingIn ? <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" /> : <Cloud className="w-3.5 h-3.5 text-sky-400" />}
      <span>{loggingIn ? 'Đang kết nối...' : 'Drive'}</span>
    </button>
  ) : (
    <div className="inline-flex items-center h-8 rounded-lg border border-neutral-700/80 bg-neutral-900/90 p-0.5 shrink-0 whitespace-nowrap">
      <button
        onClick={() => setOpen(true)}
        className="flex items-center space-x-1.5 h-7 px-2 text-sky-300 hover:text-sky-200 hover:bg-white/[0.06] rounded-md font-medium text-xs transition-all whitespace-nowrap"
        title="Mở thư mục Google Drive (Đã kết nối)"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
        <Cloud className="w-3.5 h-3.5 text-sky-400 shrink-0" />
        <span>Drive</span>
      </button>
      <button
        onClick={handlePasteFromClipboard}
        disabled={linkBusy}
        className="flex items-center space-x-1 h-7 px-2 text-neutral-300 hover:text-white hover:bg-white/[0.06] rounded-md font-medium text-xs transition-all whitespace-nowrap disabled:opacity-50"
        title="Dán link Google Drive từ clipboard (Ctrl+V)"
      >
        {linkBusy ? <Loader2 className="w-3 h-3 animate-spin text-sky-400" /> : <Link2 className="w-3 h-3 text-sky-400" />}
        <span>Dán link</span>
      </button>
      <button
        onClick={handleLogout}
        className="h-7 px-1.5 text-neutral-500 hover:text-red-400 hover:bg-red-500/10 rounded-md text-xs transition-all shrink-0"
        title="Đăng xuất Google Drive"
      >
        <LogOut className="w-3 h-3" />
      </button>
    </div>
  );

  // ---------------- Modal Drive Explorer ----------------
  const modal = open
    ? createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-3xl h-[600px] max-h-full flex flex-col bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden text-slate-200">
            {/* Header với Tab chuyển: Drive của tôi / Được chia sẻ với tôi */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-800">
              <div className="flex items-center space-x-3">
                <div className="flex items-center space-x-1.5 font-bold text-sm text-sky-400">
                  <Cloud className="w-4 h-4" />
                  <span>Google Drive</span>
                </div>

                <div className="flex items-center p-0.5 bg-slate-950/80 rounded-lg border border-slate-800 text-xs">
                  <button
                    onClick={() => switchTab('root')}
                    className={`flex items-center space-x-1.5 px-3 py-1 rounded-md transition-all font-medium ${
                      activeTab === 'root'
                        ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 shadow-sm'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 border border-transparent'
                    }`}
                  >
                    <HardDrive className="w-3.5 h-3.5" />
                    <span>Drive của tôi</span>
                  </button>

                  <button
                    onClick={() => switchTab('shared_with_me')}
                    className={`flex items-center space-x-1.5 px-3 py-1 rounded-md transition-all font-medium ${
                      activeTab === 'shared_with_me'
                        ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 shadow-sm'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 border border-transparent'
                    }`}
                  >
                    <Users className="w-3.5 h-3.5" />
                    <span>Được chia sẻ với tôi</span>
                  </button>
                </div>
              </div>
              <div className="flex items-center space-x-1">
                <button
                  onClick={() => loadFolder(current.id)}
                  className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200"
                  title="Tải lại"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={() => setOpen(false)}
                  className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200"
                  title="Đóng (Esc)"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Dán link Google Drive */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-800 bg-slate-900/40">
              <Link2 className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <input
                value={linkText}
                onChange={(e) => setLinkText(e.target.value)}
                onPaste={(e) => {
                  const t = e.clipboardData.getData('text');
                  if (t) {
                    e.preventDefault();
                    setLinkText(t);
                    processLink(t);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') processLink(linkText);
                }}
                placeholder="Dán link thư mục / video Google Drive vào đây (tự thêm vào cây)..."
                className="flex-1 px-2 py-1.5 bg-slate-950 border border-slate-800 focus:border-sky-500/60 outline-none rounded-lg text-xs text-slate-200 placeholder-slate-600"
              />
              <button
                onClick={() => processLink(linkText)}
                disabled={!linkText.trim() || linkBusy}
                className="flex items-center space-x-1 px-3 py-1.5 bg-sky-500/20 hover:bg-sky-500/30 disabled:opacity-40 border border-sky-500/40 text-sky-300 text-xs font-medium rounded-lg transition-all shrink-0"
              >
                {linkBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <FolderPlus className="w-3 h-3" />}
                <span>Thêm</span>
              </button>
            </div>

            {/* Breadcrumb + nút Thêm vào Cây + search */}
            <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-slate-800 bg-slate-900/60">
              <nav className="flex items-center flex-wrap text-xs min-w-0 gap-y-1">
                {path.map((c, i) => (
                  <React.Fragment key={`${c.id}-${i}`}>
                    {i > 0 && <ChevronRight className="w-3 h-3 mx-0.5 text-slate-600 shrink-0" />}
                    <button
                      onClick={() => goToCrumb(i)}
                      disabled={i === path.length - 1}
                      className={`truncate max-w-[160px] px-1.5 py-0.5 rounded ${
                        i === path.length - 1
                          ? 'text-slate-100 font-semibold cursor-default'
                          : 'text-sky-300 hover:bg-slate-800'
                      }`}
                      title={c.name}
                    >
                      {c.name}
                    </button>
                  </React.Fragment>
                ))}

                {current.id !== 'shared_with_me' && onAddFolderToTree && (
                  <button
                    onClick={() => {
                      onAddFolderToTree({ id: current.id, name: current.name });
                      setOpen(false);
                    }}
                    className="ml-2 flex items-center space-x-1 px-2 py-0.5 rounded bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 font-medium text-[11px] transition-colors shrink-0"
                    title={`Thêm toàn bộ thư mục "${current.name}" vào cây bài học`}
                  >
                    <FolderPlus className="w-3 h-3" />
                    <span>+ Thêm thư mục này vào Cây</span>
                  </button>
                )}
              </nav>
              <div className="relative shrink-0">
                <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Lọc theo tên video..."
                  className="w-52 pl-7 pr-2 py-1.5 bg-slate-950 border border-slate-800 focus:border-sky-500/60 outline-none rounded-lg text-xs text-slate-200 placeholder-slate-600"
                />
              </div>
            </div>

            {/* Danh sách */}
            <div className="flex-1 overflow-y-auto">
              {loading && items.length === 0 ? (
                <div className="h-full flex items-center justify-center text-slate-400 text-xs space-x-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Đang tải danh sách...</span>
                </div>
              ) : error ? (
                <div className="h-full flex flex-col items-center justify-center text-center px-8 space-y-2">
                  <AlertCircle className="w-8 h-8 text-red-400" />
                  <p className="text-xs text-red-300 max-w-md break-words">{error}</p>
                  <button
                    onClick={() => loadFolder(current.id)}
                    className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 rounded border border-slate-700"
                  >
                    Thử lại
                  </button>
                </div>
              ) : visibleItems.length === 0 ? (
                <div className="h-full flex items-center justify-center text-slate-500 text-xs">
                  {search ? 'Không có kết quả phù hợp' : 'Thư mục không có video hoặc thư mục con'}
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-900 text-slate-500 text-[11px] uppercase">
                    <tr className="border-b border-slate-800">
                      <th className="text-left font-medium px-4 py-2">Tên</th>
                      <th className="text-right font-medium px-3 py-2 w-24">Thời lượng</th>
                      <th className="text-right font-medium px-4 py-2 w-24">Kích thước</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleItems.map((it) => {
                      const isSel = it.id === selectedId;
                      return (
                        <tr
                          key={it.id}
                          onClick={() => setSelectedId(it.id)}
                          onDoubleClick={() => (it.is_folder ? enterFolder(it) : playItem(it))}
                          className={`group cursor-pointer select-none border-b border-slate-800/60 ${
                            isSel ? 'bg-sky-500/15' : 'hover:bg-slate-800/60'
                          }`}
                        >
                          <td className="px-4 py-2">
                            <div className="flex items-center space-x-2 min-w-0">
                              {it.is_folder ? (
                                <Folder className="w-4 h-4 text-amber-400 shrink-0" />
                              ) : (
                                <Film className="w-4 h-4 text-sky-400 shrink-0" />
                              )}
                              <span className="truncate" title={it.name}>
                                {it.name}
                              </span>
                              {it.is_folder && onAddFolderToTree && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onAddFolderToTree({ id: it.id, name: it.name });
                                    setOpen(false);
                                  }}
                                  className="opacity-0 group-hover:opacity-100 flex items-center space-x-1 px-1.5 py-0.5 rounded bg-amber-500/15 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-[10px] transition-all shrink-0 ml-1"
                                  title={`Thêm "${it.name}" vào cây bài học`}
                                >
                                  <FolderPlus className="w-3 h-3" />
                                  <span>+ Cây</span>
                                </button>
                              )}
                              {!it.is_folder && it.subtitle_id && (
                                <span
                                  className="flex items-center space-x-0.5 shrink-0 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-[10px]"
                                  title={`Có phụ đề sẵn: ${it.subtitle_name} (bỏ qua Whisper)`}
                                >
                                  <Captions className="w-3 h-3" />
                                  <span>SUB</span>
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right text-slate-400 font-mono">
                            {it.is_folder ? '' : formatDuration(it.duration_sec)}
                          </td>
                          <td className="px-4 py-2 text-right text-slate-400 font-mono">
                            {it.is_folder ? '' : formatSize(it.size)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800 bg-slate-900/60">
              <span className="text-[11px] text-slate-400 truncate pr-3">
                {selectedFolder
                  ? `Đã chọn thư mục: ${selectedFolder.name}`
                  : selectedVideo
                  ? selectedVideo.name
                  : 'Nhấp đúp để mở thư mục · chọn 1 video để phát'}
              </span>
              <div className="flex items-center space-x-2 shrink-0">
                {selectedFolder && onAddFolderToTree && (
                  <button
                    onClick={() => {
                      onAddFolderToTree({ id: selectedFolder.id, name: selectedFolder.name });
                      setOpen(false);
                    }}
                    className="flex items-center space-x-1.5 px-3 py-2 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 text-amber-300 font-semibold text-xs rounded-lg transition-all shadow-sm"
                    title={`Thêm thư mục "${selectedFolder.name}" vào cây bài học`}
                  >
                    <FolderPlus className="w-3.5 h-3.5" />
                    <span>Thêm vào Cây thư mục</span>
                  </button>
                )}
                {selectedFolder && (
                  <button
                    onClick={() => enterFolder(selectedFolder)}
                    className="flex items-center space-x-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs rounded-lg transition-all"
                  >
                    <Folder className="w-3.5 h-3.5" />
                    <span>Mở thư mục</span>
                  </button>
                )}
                {(!selectedFolder || selectedVideo) && (
                  <button
                    disabled={!selectedVideo}
                    onClick={() => selectedVideo && playItem(selectedVideo)}
                    className="flex items-center space-x-1.5 px-4 py-2 bg-gradient-to-r from-sky-500 to-cyan-400 hover:from-sky-400 hover:to-cyan-300 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-bold text-xs rounded-lg shadow-lg shadow-sky-500/20 transition-all"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>Phát &amp; Dịch ngay</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <>
      {toolbar}
      {modal}
    </>
  );
};

export default GoogleDrivePicker;
