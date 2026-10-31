import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  memo,
} from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  FolderOpen,
  FolderPlus,
  Folder,
  ChevronRight,
  ChevronDown,
  List,
  Subtitles,
  AlertCircle,
  RefreshCw,
  SkipBack,
  SkipForward,
  CheckCircle2,
  Trash2,
  Search,
  Film,
  PanelLeftClose,
  PanelLeftOpen,
  Download,
  Globe,
  Loader2,
  Sparkles,
  Languages,
  Cloud,
  Link2,
  GripHorizontal,
} from "lucide-react";
import {
  SubtitleItem,
  upsertSubtitles,
  findSubtitleAtTime,
} from "./lib/subtitles";
import { shouldReportDuration } from "./lib/duration";
import { LandingPage } from "./components/LandingPage";
import { countRender } from "./lib/renderProbe";
import { SetupWizard } from "./components/SetupWizard";
import { UpdateNotification } from "./components/UpdateNotification";
import { GoogleDrivePicker, DriveItem } from "./components/GoogleDrivePicker";

// Định nghĩa kiểu dữ liệu đồng bộ với Backend
interface VideoInfo {
  path: string;
  title?: string;
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
  translator_mode?: "api" | "cloud" | "local_ai";
}

export interface FolderNode {
  name: string;
  path: string;
  is_dir: boolean;
  has_cache?: boolean;
  children?: FolderNode[];
}

type SubtitleMode = "off" | "en" | "vi" | "bilingual";

const STORAGE_FOLDERS_KEY = "subtrans_imported_folders_v1";
const STORAGE_COMPLETED_KEY = "subtrans_completed_videos_v1";

// Wails runtime mock/real bindings
declare global {
  interface Window {
    runtime?: {
      EventsOn: (
        eventName: string,
        callback: (...args: any[]) => void,
      ) => () => void;
    };
    go?: {
      main?: {
        App?: {
          SelectVideoFile: () => Promise<string>;
          SelectVideoFolder: () => Promise<FolderNode | null>;
          ScanVideoFolder: (path: string) => Promise<FolderNode | null>;
          ScanDriveFolder?: (
            folderID: string,
            folderName: string,
          ) => Promise<FolderNode | null>;
          StartDriveFolderScan?: (
            folderID: string,
            folderName: string,
          ) => Promise<void>;
          ResolveDriveLink?: (link: string) => Promise<{
            kind: "folder" | "file";
            id: string;
            name: string;
            duration_sec: number;
            subtitle_id: string;
          } | null>;
          OpenVideo: (path: string) => Promise<VideoInfo>;
          OpenDriveVideo?: (
            fileID: string,
            name: string,
            subtitleID: string,
          ) => Promise<VideoInfo>;
          StartPipeline: (path: string, startSec: number) => Promise<void>;
          SeekTo: (path: string, startSec: number) => Promise<void>;
          UpdatePlayhead: (
            path: string,
            sec: number,
            playing: boolean,
          ) => Promise<void>;
          UpdateVideoDuration?: (path: string, sec: number) => Promise<void>;
          StopPipeline: () => Promise<void>;
          LoadCachedSubtitles: (path: string) => Promise<SubtitleItem[]>;
          ExportSRT: (path: string, mode: string) => Promise<string>;
          ExportSubtitle: (
            path: string,
            format: string,
            mode: string,
          ) => Promise<string>;
          DownloadYouTubeVideo: (url: string) => Promise<string>;
          SetSourceLang?: (lang: string) => Promise<void>;
          GetSourceLang?: () => Promise<string>;
          CheckModelsReady: () => Promise<boolean>;
          GetModelStatuses: () => Promise<Record<string, boolean>>;
          StartModelDownload: () => Promise<void>;
          CancelModelDownload: () => Promise<void>;
          CheckForUpdate: () => Promise<any>;
          ApplyUpdate: (downloadURL: string) => Promise<void>;
          RestartApp: () => Promise<void>;
          GetCurrentVersion: () => Promise<string>;
          GetSettings?: () => Promise<any>;
          SaveSettings?: (settings: any) => Promise<void>;
          SetGeminiConfig?: (apiKey: string, enabled: boolean, model: string) => Promise<void>;
        };
      };
    };
  }
}

// Format giây sang chuỗi MM:SS hoặc HH:MM:SS
function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return "00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// Trải phẳng cây thư mục thành danh sách các file video theo thứ tự học
function flattenVideoNodes(nodes: FolderNode[]): FolderNode[] {
  const result: FolderNode[] = [];
  const walk = (list: FolderNode[]) => {
    for (const n of list) {
      if (n.is_dir) {
        if (n.children && n.children.length > 0) {
          walk(n.children);
        }
      } else {
        result.push(n);
      }
    }
  };
  walk(nodes);
  return result;
}

// Lọc cây thư mục theo từ khóa tìm kiếm
function filterFolderTree(nodes: FolderNode[], keyword: string): FolderNode[] {
  const q = keyword.trim().toLowerCase();
  if (!q) return nodes;

  const filterNode = (node: FolderNode): FolderNode | null => {
    if (!node.is_dir) {
      return node.name.toLowerCase().includes(q) ? node : null;
    }
    const matchedChildren = (node.children || [])
      .map(filterNode)
      .filter((c): c is FolderNode => c !== null);

    if (matchedChildren.length > 0 || node.name.toLowerCase().includes(q)) {
      return {
        ...node,
        children: matchedChildren.length > 0 ? matchedChildren : node.children,
      };
    }
    return null;
  };

  return nodes.map(filterNode).filter((n): n is FolderNode => n !== null);
}

// Component hiển thị đệ quy từng nhánh cây thư mục
const FolderTreeItem = memo(
  ({
    node,
    depth,
    activeVideoPath,
    completedVideos,
    forceExpand,
    onSelectVideo,
    onRemoveRoot,
  }: {
    node: FolderNode;
    depth: number;
    activeVideoPath: string | null;
    completedVideos: Record<string, boolean>;
    forceExpand: boolean;
    onSelectVideo: (path: string) => void;
    onRemoveRoot?: (path: string) => void;
  }) => {
    countRender("FolderTreeItem");
    const [expanded, setExpanded] = useState<boolean>(depth <= 1);
    const activeItemRef = useRef<HTMLDivElement>(null);
    const isExpanded = forceExpand || expanded;
    const isCurrentVideo = !node.is_dir && node.path === activeVideoPath;

    useEffect(() => {
      if (isCurrentVideo && activeItemRef.current) {
        activeItemRef.current.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      }
    }, [isCurrentVideo]);

    if (node.is_dir) {
      const childVideos = flattenVideoNodes([node]);
      const doneCount = childVideos.filter(
        (v) => completedVideos[v.path],
      ).length;

      return (
        <div className="select-none">
          <div
            onClick={() => setExpanded((v) => !v)}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            className="group flex items-center justify-between py-1.5 pr-2 rounded cursor-pointer hover:bg-neutral-800/70 text-xs text-neutral-200 transition-colors"
          >
            <div className="flex items-center space-x-1.5 min-w-0 flex-1">
              {isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
              )}
              {isExpanded ? (
                <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              ) : (
                <Folder className="w-3.5 h-3.5 text-amber-500/80 shrink-0" />
              )}
              <span className="font-medium truncate" title={node.path}>
                {node.name}
              </span>
              {node.path.startsWith("gdrive") && (
                <span
                  className="flex items-center space-x-0.5 px-1 py-0.2 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20 text-[9px] font-mono shrink-0 ml-1"
                  title="Google Drive"
                >
                  <Cloud className="w-2.5 h-2.5" />
                  <span>Drive</span>
                </span>
              )}
            </div>

            <div className="flex items-center space-x-1.5 shrink-0 ml-1">
              <span className="text-[10px] text-neutral-500 font-mono">
                {doneCount}/{childVideos.length}
              </span>
              {depth === 0 && onRemoveRoot && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveRoot(node.path);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-neutral-500 hover:text-red-400 p-0.5 rounded transition-opacity"
                  title="Bỏ thư mục này khỏi danh sách"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {isExpanded && node.children && (
            <div className="space-y-0.5">
              {node.children.map((child) => (
                <FolderTreeItem
                  key={child.path}
                  node={child}
                  depth={depth + 1}
                  activeVideoPath={activeVideoPath}
                  completedVideos={completedVideos}
                  forceExpand={forceExpand}
                  onSelectVideo={onSelectVideo}
                />
              ))}
            </div>
          )}
        </div>
      );
    }

    const isCompleted = !!completedVideos[node.path];

    return (
      <div
        ref={isCurrentVideo ? activeItemRef : null}
        onClick={() => onSelectVideo(node.path)}
        style={{ paddingLeft: `${depth * 12 + 12}px` }}
        title={node.name}
        className={`flex items-center justify-between py-1.5 pr-2 rounded cursor-pointer text-xs transition-colors ${
          isCurrentVideo
            ? "bg-amber-500/20 text-amber-300 border-l-2 border-amber-400 font-semibold"
            : "text-neutral-300 hover:bg-neutral-800/60"
        }`}
      >
        <div className="flex items-center space-x-2 min-w-0 flex-1">
          {isCurrentVideo ? (
            <Play className="w-3 h-3 text-amber-400 fill-amber-400 shrink-0" />
          ) : isCompleted ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          ) : (
            <Film className="w-3 h-3 text-neutral-500 shrink-0" />
          )}
          <span className="truncate">{node.name}</span>
          {node.path.startsWith("gdrive") && (
            <span title="Video Google Drive" className="shrink-0 ml-1">
              <Cloud className="w-3 h-3 text-sky-400/80" />
            </span>
          )}
        </div>

        {node.has_cache && (
          <span
            className="ml-1.5 px-1 py-0.2 bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 rounded text-[9px] font-medium shrink-0"
            title="Video này đã có sẵn phụ đề dịch trong cache"
          >
            SUB
          </span>
        )}
      </div>
    );
  },
);

// So sánh pipeline_status: backend bắn mỗi 500ms kể cả khi chẳng có gì đổi.
// ahead_sec chỉ hiển thị làm tròn theo giây nên so sánh theo Math.round.
function isSamePipelineStatus(
  a: PipelineStatus | null,
  b: PipelineStatus,
): boolean {
  return (
    !!a &&
    a.state === b.state &&
    a.message === b.message &&
    a.block === b.block &&
    a.done_blocks === b.done_blocks &&
    a.total_blocks === b.total_blocks &&
    a.video === b.video &&
    a.translator_mode === b.translator_mode &&
    Math.round(a.ahead_sec) === Math.round(b.ahead_sec)
  );
}

// Dải vàng các block đã dịch xong trên seekbar (memo: không dựng lại tối đa ~120 thẻ div mỗi nhịp currentTime)
const DoneBlocksStrip = memo(
  ({
    doneBlocks,
    duration,
    blockSec,
  }: {
    doneBlocks: number[];
    duration: number;
    blockSec: number;
  }) => {
    if (duration <= 0) return null;
    return (
      <>
        {doneBlocks.map((b) => {
          const left = ((b * blockSec) / duration) * 100;
          const width = (blockSec / duration) * 100;
          return (
            <div
              key={b}
              style={{ left: `${left}%`, width: `${width}%` }}
              className="absolute top-0 bottom-0 bg-amber-500/35"
            />
          );
        })}
      </>
    );
  },
);

// Panel cây thư mục khóa học bên trái
const CourseTreePanel = memo(
  ({
    roots,
    activeVideoPath,
    completedVideos,
    autoCollapse,
    onToggleAutoCollapse,
    onSelectVideo,
    onAddFolder,
    onAddDriveLink,
    onRemoveRoot,
    onClearAll,
    onClose,
  }: {
    roots: FolderNode[];
    activeVideoPath: string | null;
    completedVideos: Record<string, boolean>;
    autoCollapse: boolean;
    onToggleAutoCollapse: () => void;
    onSelectVideo: (path: string) => void;
    onAddFolder: () => void;
    onAddDriveLink?: () => void;
    onRemoveRoot: (path: string) => void;
    onClearAll: () => void;
    onClose: () => void;
  }) => {
    countRender("CourseTreePanel");
    const [searchQuery, setSearchQuery] = useState<string>("");
    const allVideos = useMemo(() => flattenVideoNodes(roots), [roots]);
    const filteredRoots = useMemo(
      () => filterFolderTree(roots, searchQuery),
      [roots, searchQuery],
    );
    const completedCount = useMemo(
      () => allVideos.filter((v) => completedVideos[v.path]).length,
      [allVideos, completedVideos],
    );

    return (
      <aside className="w-80 h-full bg-[#13161c] border-r border-player-border flex flex-col z-20 shrink-0">
        {/* Header của cây thư mục */}
        <div className="h-10 border-b border-player-border px-3 flex items-center justify-between shrink-0">
          <span className="text-xs font-semibold text-neutral-200 truncate pr-1">
            Cây thư mục ({completedCount}/{allVideos.length})
          </span>

          <div className="flex items-center space-x-0.5 shrink-0">
            <button
              onClick={onToggleAutoCollapse}
              className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                autoCollapse
                  ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
                  : "bg-neutral-800 text-neutral-400 border-neutral-700"
              }`}
              title="Tự động thu gọn thanh thư mục sau khi bấm chọn bài học"
            >
              Tự ẩn
            </button>
            <button
              onClick={onAddFolder}
              className="p-1 rounded text-neutral-400 hover:text-amber-400 hover:bg-neutral-800 transition-colors"
              title="Thêm thư mục bài học từ máy tính"
            >
              <FolderPlus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onAddDriveLink}
              className="p-1 rounded text-neutral-400 hover:text-sky-400 hover:bg-neutral-800 transition-colors"
              title="Dán link Google Drive (hoặc bấm Ctrl+V) để thêm vào cây"
            >
              <Link2 className="w-3.5 h-3.5" />
            </button>
            {roots.length > 0 && (
              <button
                onClick={onClearAll}
                className="text-neutral-500 hover:text-red-400 p-1 rounded hover:bg-neutral-800 transition-colors"
                title="Xóa toàn bộ cây thư mục"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={onClose}
              className="text-neutral-400 hover:text-white p-1 rounded hover:bg-neutral-800 transition-colors"
              title="Thu gọn cây thư mục (Phím B)"
            >
              <PanelLeftClose className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Ô tìm kiếm nhanh bài học */}
        {allVideos.length > 3 && (
          <div className="p-2 border-b border-player-border">
            <div className="relative flex items-center">
              <Search className="w-3.5 h-3.5 text-neutral-500 absolute left-2.5 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Tìm tên video / bài học..."
                className="w-full bg-neutral-900 text-xs text-neutral-200 pl-8 pr-6 py-1.5 rounded border border-neutral-800 focus:border-amber-500/50 focus:outline-none"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 text-neutral-500 hover:text-neutral-300 text-xs"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        )}

        {/* Nội dung cây thư mục */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {roots.length === 0 ? (
            <div className="text-center py-10 px-4 text-neutral-500 text-xs space-y-3">
              <FolderOpen className="w-8 h-8 text-neutral-600 mx-auto" />
              <div>
                Chưa có thư mục nào. Bấm <b>"+ Thư mục"</b> hoặc kéo thả nhiều
                thư mục khóa học vào đây.
              </div>
              <button
                onClick={onAddFolder}
                className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded text-xs transition-colors"
              >
                Chọn thư mục video
              </button>
            </div>
          ) : filteredRoots.length === 0 ? (
            <div className="text-center py-8 text-neutral-500 text-xs">
              Không tìm thấy bài học phù hợp
            </div>
          ) : (
            filteredRoots.map((root) => (
              <FolderTreeItem
                key={root.path}
                node={root}
                depth={0}
                activeVideoPath={activeVideoPath}
                completedVideos={completedVideos}
                forceExpand={searchQuery.trim().length > 0}
                onSelectVideo={onSelectVideo}
                onRemoveRoot={onRemoveRoot}
              />
            ))
          )}
        </div>
      </aside>
    );
  },
);

// Component danh sách phụ đề bên cạnh (dùng React.memo để tránh re-render liên tục khi video phát)
const SubtitleListPanel = memo(
  ({
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
    countRender("SubtitleListPanel");
    const activeItemRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (activeItemRef.current) {
        activeItemRef.current.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      }
    }, [activeId]);

    return (
      <aside className="w-80 h-full bg-[#13161c] border-l border-player-border flex flex-col z-20 shrink-0">
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
                      ? "bg-amber-500/20 border-l-2 border-amber-400 text-white"
                      : "hover:bg-neutral-800/60 text-neutral-300"
                  }`}
                >
                  <div className="flex justify-between text-[10px] text-neutral-400 mb-0.5">
                    <span>
                      {formatTime(item.start_sec)} - {formatTime(item.end_sec)}
                    </span>
                    {item.translated && (
                      <span className="text-emerald-400">Đã dịch</span>
                    )}
                  </div>
                  <div className="text-neutral-300 select-text">
                    {item.source_text}
                  </div>
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
  },
);

export const App: React.FC = () => {
  countRender("App");
  // Navigation View: 'landing' (Giới thiệu & Tính năng) hoặc 'player' (Trình phát video)
  const [viewMode, setViewMode] = useState<"landing" | "player">("landing");

  // Video & Playback State
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [volume, setVolume] = useState<number>(1.0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // Course Folder Tree & Auto-Next State
  const [courseRoots, setCourseRoots] = useState<FolderNode[]>([]);
  const [showFolderPanel, setShowFolderPanel] = useState<boolean>(true);
  const [autoCollapseFolder, setAutoCollapseFolder] = useState<boolean>(true);
  const [autoNext, setAutoNext] = useState<boolean>(true);
  const [completedVideos, setCompletedVideos] = useState<
    Record<string, boolean>
  >(() => {
    try {
      const raw = localStorage.getItem(STORAGE_COMPLETED_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  // Source language ('auto' | 'en' | 'vi')
  const [sourceLang, setSourceLang] = useState<string>("auto");
  const [geminiEnabled, setGeminiEnabled] = useState<boolean>(false);

  // Ghi nhớ đường dẫn thư mục gốc vào localStorage
  const rememberFolderPath = useCallback((p: string) => {
    try {
      const raw = localStorage.getItem(STORAGE_FOLDERS_KEY);
      const arr: string[] = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr) && !arr.includes(p)) {
        arr.push(p);
        localStorage.setItem(STORAGE_FOLDERS_KEY, JSON.stringify(arr));
      }
    } catch {
      // ignore
    }
  }, []);

  const pendingAutoPlayRef = useRef<string | null>(null);
  const currentVideoPathRef = useRef<string | undefined>(undefined);
  currentVideoPathRef.current = videoInfo?.path;

  // Subtitle State
  const [subtitles, setSubtitles] = useState<SubtitleItem[]>([]);
  const [currentSubtitle, setCurrentSubtitle] = useState<SubtitleItem | null>(
    null,
  );
  const [subtitleMode, setSubtitleMode] = useState<SubtitleMode>("bilingual");
  const [subtitleOffset, setSubtitleOffset] = useState<number>(0.0);
  const [showSubPanel, setShowSubPanel] = useState<boolean>(false);
  const [showExportMenu, setShowExportMenu] = useState<boolean>(false);
  const [showYtModal, setShowYtModal] = useState<boolean>(false);
  const [ytUrl, setYtUrl] = useState<string>("");
  const [isDownloadingYt, setIsDownloadingYt] = useState<boolean>(false);
  const [ytProgress, setYtProgress] = useState<string>("");
  const [toastMessage, setToastMessage] = useState<string>("");

  // Pipeline Status State
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus | null>(
    null,
  );
  const [doneBlocks, setDoneBlocks] = useState<number[]>([]);
  const doneBlocksRef = useRef<number[]>([]);
  // Ref luôn trỏ giá trị mới nhất để vòng syncFrame / listener keydown không phải hủy-đăng ký lại
  const subtitlesRef = useRef<SubtitleItem[]>([]);
  const subtitleOffsetRef = useRef<number>(0);
  const currentTimeRef = useRef<number>(0);
  subtitlesRef.current = subtitles;
  subtitleOffsetRef.current = subtitleOffset;
  currentTimeRef.current = currentTime;
  doneBlocksRef.current = doneBlocks;
  const currentSubtitleRef = useRef<SubtitleItem | null>(null);
  currentSubtitleRef.current = currentSubtitle;

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const seekDebounceTimerRef = useRef<any>(null);
  const lastPlayheadUpdateRef = useRef<number>(0);
  // BUG-08: đồng bộ thời lượng thật của <video> về backend (video Drive mở với giá trị ước lượng)
  const videoInfoRef = useRef<VideoInfo | null>(null);
  videoInfoRef.current = videoInfo;
  const reportedDurationRef = useRef<{ path: string; sec: number } | null>(null);
  const reportRealDuration = useCallback((real: number) => {
    const info = videoInfoRef.current;
    if (!info?.path) return;
    const last =
      reportedDurationRef.current?.path === info.path
        ? reportedDurationRef.current.sec
        : undefined;
    if (!shouldReportDuration(real, info.duration_sec, last)) return;
    reportedDurationRef.current = { path: info.path, sec: real };
    void window.go?.main?.App?.UpdateVideoDuration?.(info.path, real);
  }, []);
  const lastUiTimeRef = useRef<number>(0);

  // Danh sách video phẳng theo thứ tự từ cây thư mục
  const playlistVideos = useMemo(
    () => flattenVideoNodes(courseRoots),
    [courseRoots],
  );

  const currentPlaylistIndex = useMemo(() => {
    if (!videoInfo?.path) return -1;
    return playlistVideos.findIndex((v) => v.path === videoInfo.path);
  }, [playlistVideos, videoInfo?.path]);

  // Hiển thị toast thông báo ngắn
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(""), 2500);
  }, []);

  // Vị trí tùy biến của thanh phụ đề (người dùng có thể kéo thả tự do)
  const [subPos, setSubPos] = useState<{ xPct: number; yPct: number } | null>(
    () => {
      try {
        const saved = localStorage.getItem("sub_overlay_pos");
        if (saved) return JSON.parse(saved);
      } catch {}
      return null;
    },
  );

  const isDraggingSubRef = useRef<boolean>(false);
  const subHasMovedRef = useRef<boolean>(false);
  const dragStartSubRef = useRef<{
    pointerStartX: number;
    pointerStartY: number;
    initialCenterX: number;
    initialCenterY: number;
    containerWidth: number;
    containerHeight: number;
    boxWidth: number;
    boxHeight: number;
  } | null>(null);

  const handleSubPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const container = playerContainerRef.current;
      if (!container) return;

      e.stopPropagation();
      const containerRect = container.getBoundingClientRect();
      const boxRect = e.currentTarget.getBoundingClientRect();

      const initialCenterX =
        boxRect.left + boxRect.width / 2 - containerRect.left;
      const initialCenterY =
        boxRect.top + boxRect.height / 2 - containerRect.top;

      dragStartSubRef.current = {
        pointerStartX: e.clientX,
        pointerStartY: e.clientY,
        initialCenterX,
        initialCenterY,
        containerWidth: containerRect.width,
        containerHeight: containerRect.height,
        boxWidth: boxRect.width,
        boxHeight: boxRect.height,
      };
      isDraggingSubRef.current = true;
      subHasMovedRef.current = false;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {}
    },
    [],
  );

  const handleSubPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDraggingSubRef.current || !dragStartSubRef.current) return;
      e.stopPropagation();

      const {
        pointerStartX,
        pointerStartY,
        initialCenterX,
        initialCenterY,
        containerWidth,
        containerHeight,
        boxWidth,
        boxHeight,
      } = dragStartSubRef.current;

      const deltaX = e.clientX - pointerStartX;
      const deltaY = e.clientY - pointerStartY;

      if (!subHasMovedRef.current && Math.hypot(deltaX, deltaY) < 3) {
        return;
      }
      subHasMovedRef.current = true;

      const newCenterX = initialCenterX + deltaX;
      const newCenterY = initialCenterY + deltaY;

      // Giới hạn để thanh phụ đề nằm trọn trong player
      const halfW = boxWidth / 2;
      const halfH = boxHeight / 2;
      const clampedCenterX = Math.max(
        halfW,
        Math.min(containerWidth - halfW, newCenterX),
      );
      const clampedCenterY = Math.max(
        halfH,
        Math.min(containerHeight - halfH, newCenterY),
      );

      const xPct =
        Math.round(((clampedCenterX / containerWidth) * 100) * 10) / 10;
      const yPct =
        Math.round(((clampedCenterY / containerHeight) * 100) * 10) / 10;

      setSubPos({ xPct, yPct });
    },
    [],
  );

  const handleSubPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDraggingSubRef.current) return;
      e.stopPropagation();
      isDraggingSubRef.current = false;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}

      if (subHasMovedRef.current) {
        setSubPos((current) => {
          if (current) {
            localStorage.setItem("sub_overlay_pos", JSON.stringify(current));
          }
          return current;
        });
      }
    },
    [],
  );

  const handleSubDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setSubPos(null);
      localStorage.removeItem("sub_overlay_pos");
      showToast("Đã đưa vị trí phụ đề về mặc định (dưới cùng)");
    },
    [showToast],
  );

  // Lưu danh sách thư mục gốc vào localStorage
  const saveFolderPaths = useCallback((roots: FolderNode[]) => {
    try {
      const paths = roots.map((r) => r.path);
      localStorage.setItem(STORAGE_FOLDERS_KEY, JSON.stringify(paths));
    } catch {
      // ignore storage errors
    }
  }, []);

  // Khôi phục cây thư mục đã mở từ lần trước
  useEffect(() => {
    const restoreFolders = async () => {
      if (!window.go?.main?.App?.ScanVideoFolder) return;
      try {
        const raw = localStorage.getItem(STORAGE_FOLDERS_KEY);
        if (!raw) return;
        const savedPaths: string[] = JSON.parse(raw);
        if (!Array.isArray(savedPaths) || savedPaths.length === 0) return;

        const loaded: FolderNode[] = [];
        for (const p of savedPaths) {
          if (p.startsWith("gdrive_folder://")) {
            window.go?.main?.App?.StartDriveFolderScan?.(
              p.slice("gdrive_folder://".length),
              "",
            )?.catch(() => {});
            continue;
          }
          try {
            const node = await window.go.main.App.ScanVideoFolder(p);
            if (node) loaded.push(node);
          } catch {
            // Bỏ qua thư mục đã bị xóa hoặc di chuyển
          }
        }
        if (loaded.length > 0) {
          setCourseRoots((prev) => [
            ...loaded,
            ...prev.filter((r) => !loaded.some((l) => l.path === r.path)),
          ]);
        }
      } catch {
        // ignore
      }
    };
    restoreFolders();
    window.go?.main?.App?.GetSourceLang?.()
      .then((l) => {
        if (l === "en" || l === "vi" || l === "auto") {
          setSourceLang(l);
        }
      })
      .catch(() => {});
    window.go?.main?.App?.GetSettings?.()
      .then((s) => {
        if (s) {
          setGeminiEnabled(!!s.gemini_enabled);
        }
      })
      .catch(() => {});
  }, []);

  // Mở file video (cục bộ hoặc Google Drive)
  const handleOpenVideo = useCallback(
    async (filePath?: string, driveItem?: DriveItem) => {
      let selected = filePath;
      if (!selected && !driveItem && window.go?.main?.App) {
        try {
          selected = await window.go.main.App.SelectVideoFile();
        } catch (err) {
          console.error("Lỗi mở file dialog:", err);
        }
      }

      if (!selected && !driveItem) return;

      try {
        // 1. Reset state cũ
        setSubtitles([]);
        setCurrentSubtitle(null);
        doneBlocksRef.current = [];
        setDoneBlocks([]);
        setCurrentTime(0);
        lastUiTimeRef.current = 0;

        // 2. Gọi OpenVideo backend (video Google Drive: stream qua loopback proxy, không tải về đĩa)
        const info = driveItem
          ? await window.go?.main?.App?.OpenDriveVideo?.(
              driveItem.id,
              driveItem.name,
              driveItem.subtitle_id || "",
            )
          : await window.go?.main?.App?.OpenVideo(selected as string);
        if (!info) return;

        setVideoInfo(info);
        setDuration(info.duration_sec);
        const initialDone = info.done_blocks || [];
        doneBlocksRef.current = initialDone;
        setDoneBlocks(initialDone);
        setViewMode("player");

        // 3. Nạp cache phụ đề nếu có (bao gồm cả phụ đề gốc _en.srt đi kèm)
        const cached = await window.go?.main?.App?.LoadCachedSubtitles(
          info.path,
        );
        if (cached && cached.length > 0) {
          setSubtitles(cached);
        }

        // 4. Phát video ngay lập tức (không chờ pipeline)
        setTimeout(() => {
          if (videoRef.current) {
            videoRef.current.src = info.media_url;
            videoRef.current.play().catch(() => {});
            setIsPlaying(true);
          }
        }, 50);

        // 5. Bắt đầu pipeline ngầm
        await window.go?.main?.App?.StartPipeline(info.path, 0);
      } catch (err: any) {
        alert(`Không thể mở video: ${err?.message || err}`);
      }
    },
    [],
  );

  // Thêm 1 thư mục khóa học vào cây thư mục
  const handleAddFolder = useCallback(async () => {
    if (!window.go?.main?.App?.SelectVideoFolder) return;
    try {
      const folderNode = await window.go.main.App.SelectVideoFolder();
      if (!folderNode) return;

      setShowFolderPanel(true);
      setCourseRoots((prev) => {
        const existsIdx = prev.findIndex((r) => r.path === folderNode.path);
        let next: FolderNode[];
        if (existsIdx >= 0) {
          next = [...prev];
          next[existsIdx] = folderNode;
        } else {
          next = [...prev, folderNode];
        }
        saveFolderPaths(next);
        return next;
      });

      // Nếu chưa có video nào đang mở, tự động phát bài đầu tiên trong thư mục vừa thêm
      const videos = flattenVideoNodes([folderNode]);
      if (!videoInfo?.path && videos.length > 0) {
        handleOpenVideo(videos[0].path);
      } else {
        showToast(
          `Đã thêm thư mục: ${folderNode.name} (${videos.length} video)`,
        );
      }
    } catch (err: any) {
      alert(`Không thể quét thư mục: ${err?.message || err}`);
    }
  }, [videoInfo?.path, handleOpenVideo, saveFolderPaths, showToast]);

  // Xóa 1 thư mục gốc khỏi cây
  const handleRemoveRootFolder = useCallback(
    (rootPath: string) => {
      setCourseRoots((prev) => {
        const next = prev.filter((r) => r.path !== rootPath);
        saveFolderPaths(next);
        return next;
      });
    },
    [saveFolderPaths],
  );

  // Xóa toàn bộ cây thư mục
  const handleClearAllFolders = useCallback(() => {
    setCourseRoots([]);
    saveFolderPaths([]);
  }, [saveFolderPaths]);

  // Lắng nghe sự kiện cập nhật cây thư mục Google Drive dạng tăng dần
  useEffect(() => {
    const off = window.runtime?.EventsOn(
      "drive_tree_update",
      (payload: { node: FolderNode; done: boolean }) => {
        const node = payload?.node;
        if (!node) return;
        setShowFolderPanel(true);
        setCourseRoots((prev) => {
          const idx = prev.findIndex((r) => r.path === node.path);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = node;
            return next;
          }
          return [...prev, node];
        });
        rememberFolderPath(node.path);

        if (pendingAutoPlayRef.current === node.path) {
          const videos = flattenVideoNodes([node]);
          if (videos.length > 0) {
            pendingAutoPlayRef.current = null;
            if (!currentVideoPathRef.current) {
              handleOpenVideo(videos[0].path);
            }
          }
        }
        if (payload.done) {
          const count = flattenVideoNodes([node]).length;
          showToast(`Đã nạp xong "${node.name}" (${count} video)`);
        }
      },
    );
    return () => off?.();
  }, [handleOpenVideo, rememberFolderPath, showToast]);

  // Thêm 1 thư mục Google Drive vào cây bài học (quét tăng dần ở nền)
  const handleAddDriveFolderToTree = useCallback(
    async (folder: { id: string; name: string }) => {
      const app = window.go?.main?.App;
      if (!app?.StartDriveFolderScan) {
        showToast("Phiên bản backend chưa hỗ trợ nạp thư mục Drive");
        return;
      }
      const path = `gdrive_folder://${folder.id}`;
      try {
        pendingAutoPlayRef.current = path;
        setShowFolderPanel(true);
        setCourseRoots((prev) =>
          prev.some((r) => r.path === path)
            ? prev
            : [
                ...prev,
                { name: folder.name, path, is_dir: true, children: [] },
              ],
        );
        rememberFolderPath(path);
        showToast(`Đang nạp "${folder.name}" ở nền...`);
        await app.StartDriveFolderScan(folder.id, folder.name);
      } catch (err: any) {
        pendingAutoPlayRef.current = null;
        showToast(`Lỗi nạp thư mục Drive: ${err?.message || err}`);
      }
    },
    [rememberFolderPath, showToast],
  );

  // Dán link Google Drive (thư mục hoặc file video) để thêm thẳng vào cây hoặc phát ngay
  const handlePasteDriveLink = useCallback(
    async (rawLink?: string) => {
      let link = rawLink?.trim();
      if (!link) {
        try {
          const text = await navigator.clipboard.readText();
          if (
            text &&
            (text.includes("drive.google.com") ||
              text.includes("docs.google.com"))
          ) {
            link = text.trim();
          }
        } catch {
          // ignore
        }
      }
      if (!link) {
        const input = window.prompt(
          "Dán link Google Drive (thư mục hoặc video) vào đây:",
        );
        if (!input || !input.trim()) return;
        link = input.trim();
      }

      const app = window.go?.main?.App;
      if (!app?.ResolveDriveLink) {
        showToast("Backend chưa hỗ trợ phân giải link Google Drive");
        return;
      }

      try {
        showToast("Đang phân giải link Google Drive...");
        const info = await app.ResolveDriveLink(link);
        if (!info) return;

        if (info.kind === "folder") {
          handleAddDriveFolderToTree({ id: info.id, name: info.name });
        } else {
          handleOpenVideo(undefined, {
            id: info.id,
            name: info.name,
            mime_type: "video/mp4",
            size: 0,
            thumbnail_link: "",
            is_folder: false,
            duration_sec: info.duration_sec,
            subtitle_id: info.subtitle_id || "",
            subtitle_name: "",
          });
        }
      } catch (err: any) {
        showToast(`Link Drive không dùng được: ${err?.message || err}`);
      }
    },
    [handleAddDriveFolderToTree, handleOpenVideo, showToast],
  );

  // Lắng nghe sự kiện Ctrl+V toàn cục để dán nhanh link Google Drive
  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const text = e.clipboardData?.getData("text")?.trim();
      if (
        text &&
        (text.includes("drive.google.com") || text.includes("docs.google.com"))
      ) {
        e.preventDefault();
        handlePasteDriveLink(text);
      }
    };
    window.addEventListener("paste", handleGlobalPaste);
    return () => window.removeEventListener("paste", handleGlobalPaste);
  }, [handlePasteDriveLink]);

  // Chuyển sang bài trước / bài tiếp theo trong cây thư mục
  const handlePlayAdjacentVideo = useCallback(
    (offset: number) => {
      if (currentPlaylistIndex < 0) return;
      const nextIdx = currentPlaylistIndex + offset;
      if (nextIdx >= 0 && nextIdx < playlistVideos.length) {
        const target = playlistVideos[nextIdx];
        showToast(
          `⏭ Chuyển bài (${nextIdx + 1}/${playlistVideos.length}): ${target.name}`,
        );
        handleOpenVideo(target.path);
      }
    },
    [currentPlaylistIndex, playlistVideos, handleOpenVideo, showToast],
  );

  // Xử lý khi video kết thúc: đánh dấu hoàn thành & tự động nhảy sang bài tiếp theo
  const handleVideoEnded = useCallback(() => {
    setIsPlaying(false);
    if (videoInfo?.path) {
      setCompletedVideos((prev) => {
        const next = { ...prev, [videoInfo.path]: true };
        try {
          localStorage.setItem(STORAGE_COMPLETED_KEY, JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      });
    }

    if (
      autoNext &&
      currentPlaylistIndex >= 0 &&
      currentPlaylistIndex + 1 < playlistVideos.length
    ) {
      const nextVideo = playlistVideos[currentPlaylistIndex + 1];
      showToast(`⏭ Tự động phát bài kế tiếp: ${nextVideo.name}`);
      handleOpenVideo(nextVideo.path);
    }
  }, [
    videoInfo?.path,
    autoNext,
    currentPlaylistIndex,
    playlistVideos,
    handleOpenVideo,
    showToast,
  ]);

  // Các callback ổn định (tham chiếu không đổi giữa các lần render) để React.memo của
  // LandingPage / CourseTreePanel / FolderTreeItem / SubtitleListPanel thực sự có tác dụng.
  const handleToggleAutoCollapse = useCallback(() => {
    setAutoCollapseFolder((v) => {
      const next = !v;
      showToast(
        next
          ? "Đã BẬT tự ẩn thư mục khi chọn bài"
          : "Đã TẮT tự ẩn thư mục khi chọn bài",
      );
      return next;
    });
  }, [showToast]);

  const handleSelectVideoFromTree = useCallback(
    (path: string) => {
      handleOpenVideo(path);
      if (autoCollapseFolder) {
        setShowFolderPanel(false);
      }
    },
    [handleOpenVideo, autoCollapseFolder],
  );

  // Bọc lại để không truyền MouseEvent vào tham số rawLink của handlePasteDriveLink
  const handleAddDriveLinkFromTree = useCallback(() => {
    handlePasteDriveLink();
  }, [handlePasteDriveLink]);

  const handleCloseFolderPanel = useCallback(() => setShowFolderPanel(false), []);
  const handleCloseSubPanel = useCallback(() => setShowSubPanel(false), []);
  const handleLandingOpenVideo = useCallback(() => {
    handleOpenVideo();
  }, [handleOpenVideo]);
  const handleLandingOpenYouTube = useCallback(() => setShowYtModal(true), []);
  const handleLandingSwitchToPlayer = useCallback(() => setViewMode("player"), []);

  // Đăng ký lắng nghe sự kiện từ Wails backend
  useEffect(() => {
    if (!window.runtime) return;

    // Lắng nghe chunk phụ đề mới
    const unChunk = window.runtime.EventsOn(
      "new_subtitle_chunk",
      (chunk: any) => {
        if (chunk.video !== videoInfo?.path) return;
        setSubtitles((prev) => upsertSubtitles(prev, chunk.items || []));
        if (chunk.final) {
          setDoneBlocks((prev) => {
            if (prev.includes(chunk.block)) return prev;
            const next = [...prev, chunk.block];
            next.sort((a, b) => a - b);
            return next;
          });
        }
      },
    );

    // Lắng nghe trạng thái pipeline
    const unStatus = window.runtime.EventsOn(
      "pipeline_status",
      (st: PipelineStatus) => {
        if (st.video !== videoInfo?.path) return;
        setPipelineStatus((prev) => (isSamePipelineStatus(prev, st) ? prev : st));
      },
    );

    // Lắng nghe tiến độ tải YouTube
    const unYt = window.runtime.EventsOn("youtube_progress", (msg: string) => {
      setYtProgress(msg);
    });

    return () => {
      unChunk();
      unStatus();
      unYt();
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
      const sub = findSubtitleAtTime(
        subtitlesRef.current,
        mediaTime + subtitleOffsetRef.current,
      );
      setCurrentSubtitle((prev) =>
        prev?.id === sub?.id &&
        prev?.target_text === sub?.target_text &&
        prev?.source_text === sub?.source_text
          ? prev
          : sub,
      );

      // Báo cáo playhead lên backend mỗi ~2 giây
      const nowTs = Date.now();
      if (videoInfo?.path && nowTs - lastPlayheadUpdateRef.current > 2000) {
        lastPlayheadUpdateRef.current = nowTs;
        window.go?.main?.App?.UpdatePlayhead(
          videoInfo.path,
          mediaTime,
          !video.paused,
        );
      }

      if ("requestVideoFrameCallback" in video) {
        handle = (video as any).requestVideoFrameCallback(syncFrame);
      } else {
        handle = requestAnimationFrame(syncFrame);
      }
    };

    if ("requestVideoFrameCallback" in video) {
      handle = (video as any).requestVideoFrameCallback(syncFrame);
    } else {
      handle = requestAnimationFrame(syncFrame);
    }

    return () => {
      if ("cancelVideoFrameCallback" in video) {
        (video as any).cancelVideoFrameCallback(handle);
      } else {
        cancelAnimationFrame(handle);
      }
    };
  }, [videoInfo?.path]);

  // Khi phụ đề/offset đổi: cập nhật phụ đề hiện tại ngay, không cần khởi động lại vòng syncFrame
  // (cũng đúng khi video đang tạm dừng, lúc đó không có frame callback nào chạy)
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const sub = findSubtitleAtTime(subtitles, video.currentTime + subtitleOffset);
    const prev = currentSubtitleRef.current;
    // So sánh trước để không gọi setState thừa (tránh 1 lần chạy lại thân App khi không đổi)
    if (
      prev?.id !== sub?.id ||
      prev?.target_text !== sub?.target_text ||
      prev?.source_text !== sub?.source_text
    ) {
      setCurrentSubtitle(sub);
    }
  }, [subtitles, subtitleOffset]);

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

  // Tua video với Debounce nhẹ 50ms chống rung thanh trượt (backend gom lệnh bằng Coalescing Seek)
  const seekVideo = useCallback(
    (targetSec: number) => {
      if (!videoRef.current || !videoInfo) return;

      const clamped = Math.max(0, Math.min(targetSec, duration));
      videoRef.current.currentTime = clamped;
      lastUiTimeRef.current = clamped;
      setCurrentTime(clamped);

      const blockSec = videoInfo.block_sec || 30;
      const targetBlock = Math.floor(clamped / blockSec);

      clearTimeout(seekDebounceTimerRef.current);
      seekDebounceTimerRef.current = setTimeout(() => {
        // Chỉ báo toast khi đã dừng chuột tại block chưa dịch xong (đọc trực tiếp từ doneBlocksRef, tránh stale closure)
        if (!doneBlocksRef.current.includes(targetBlock)) {
          showToast("⚡ Đang xử lý phụ đề đoạn này...");
        }
        window.go?.main?.App?.SeekTo(videoInfo.path, clamped);
      }, 50);
    },
    [videoInfo, duration, showToast],
  );

  // Phím tắt điều khiển
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Bỏ qua khi đang nhập vào input/textarea
      if (["INPUT", "TEXTAREA"].includes((e.target as HTMLElement).tagName))
        return;

      switch (e.code) {
        case "Space":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekVideo(currentTimeRef.current - (e.shiftKey ? 30 : 5));
          break;
        case "ArrowRight":
          e.preventDefault();
          seekVideo(currentTimeRef.current + (e.shiftKey ? 30 : 5));
          break;
        case "PageUp":
          e.preventDefault();
          handlePlayAdjacentVideo(-1);
          break;
        case "PageDown":
          e.preventDefault();
          handlePlayAdjacentVideo(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          setVolume((v) => Math.min(1.0, v + 0.05));
          break;
        case "ArrowDown":
          e.preventDefault();
          setVolume((v) => Math.max(0.0, v - 0.05));
          break;
        case "KeyM":
          e.preventDefault();
          setIsMuted((m) => !m);
          break;
        case "KeyF":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "KeyB":
          e.preventDefault();
          setShowFolderPanel((v) => !v);
          break;
        case "KeyV":
          e.preventDefault();
          setSubtitleMode((mode) => {
            const nextMode: Record<SubtitleMode, SubtitleMode> = {
              bilingual: "vi",
              vi: "en",
              en: "off",
              off: "bilingual",
            };
            const n = nextMode[mode];
            showToast(`Chế độ phụ đề: ${n.toUpperCase()}`);
            return n;
          });
          break;
        case "KeyG":
          e.preventDefault();
          setSubtitleOffset((o) => {
            const next = Math.round((o - 0.1) * 10) / 10;
            showToast(`Lệch phụ đề: ${next > 0 ? `+${next}` : next}s`);
            return next;
          });
          break;
        case "KeyH":
          e.preventDefault();
          setSubtitleOffset((o) => {
            const next = Math.round((o + 0.1) * 10) / 10;
            showToast(`Lệch phụ đề: ${next > 0 ? `+${next}` : next}s`);
            return next;
          });
          break;
        case "KeyO":
          if (e.ctrlKey) {
            e.preventDefault();
            handleOpenVideo();
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    seekVideo,
    handlePlayAdjacentVideo,
    handleOpenVideo,
    showToast,
  ]);

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

  // Xuất file phụ đề (.srt / .vtt)
  const handleExportSubtitle = async (
    format: "srt" | "vtt",
    mode: "target" | "bilingual" | "source",
  ) => {
    setShowExportMenu(false);
    if (!videoInfo?.path) {
      showToast("Vui lòng mở video trước khi xuất phụ đề");
      return;
    }
    try {
      let res: string | undefined;
      if (window.go?.main?.App?.ExportSubtitle) {
        res = await window.go.main.App.ExportSubtitle(
          videoInfo.path,
          format,
          mode,
        );
      } else {
        res = await window.go?.main?.App?.ExportSRT(videoInfo.path, mode);
      }
      if (res) showToast(`✅ Đã xuất phụ đề: ${res}`);
    } catch (err: any) {
      alert(`Xuất phụ đề thất bại: ${err?.message || err}`);
    }
  };

  // Tải & Dịch tự động từ link YouTube
  const handleStartYouTube = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = ytUrl.trim();
    if (!trimmed || isDownloadingYt) return;

    setIsDownloadingYt(true);
    setYtProgress("Đang kết nối YouTube và tách phụ đề gốc...");

    try {
      const downloadedPath =
        await window.go?.main?.App?.DownloadYouTubeVideo(trimmed);
      if (downloadedPath) {
        setShowYtModal(false);
        setYtUrl("");
        setYtProgress("");
        showToast("🎉 Đã tải xong từ YouTube! Đang phát & dịch tự động...");
        await handleOpenVideo(downloadedPath);
      }
    } catch (err: any) {
      alert(`Không thể tải video YouTube: ${err?.message || err}`);
    } finally {
      setIsDownloadingYt(false);
    }
  };

  // Kích hoạt dịch đón đầu trước 1 đoạn
  const handleTriggerBufferAhead = () => {
    if (!videoInfo?.path) return;
    showToast("Đang tăng tốc đón đầu phụ đề phía trước...");
    window.go?.main?.App?.SeekTo(videoInfo.path, currentTime);
  };

  // Xử lý kéo thả 1 hoặc nhiều thư mục / tập tin video vào cửa sổ ứng dụng
  const handleDropItems = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const droppedText = e.dataTransfer.getData("text")?.trim();
    if (
      droppedText &&
      (droppedText.includes("drive.google.com") ||
        droppedText.includes("docs.google.com"))
    ) {
      handlePasteDriveLink(droppedText);
      return;
    }
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;

    const newNodes: FolderNode[] = [];
    let firstSingleVideo: string | null = null;

    for (const f of files) {
      const fullPath = (f as any).path;
      if (!fullPath) continue;
      if (window.go?.main?.App?.ScanVideoFolder) {
        try {
          const scanned = await window.go.main.App.ScanVideoFolder(fullPath);
          if (scanned) {
            if (scanned.is_dir) {
              newNodes.push(scanned);
            } else if (!firstSingleVideo) {
              firstSingleVideo = scanned.path;
            }
          }
        } catch {
          // ignore invalid items
        }
      } else if (!firstSingleVideo) {
        firstSingleVideo = fullPath;
      }
    }

    if (newNodes.length > 0) {
      setShowFolderPanel(true);
      setCourseRoots((prev) => {
        const merged = [...prev];
        for (const node of newNodes) {
          const idx = merged.findIndex((r) => r.path === node.path);
          if (idx >= 0) {
            merged[idx] = node;
          } else {
            merged.push(node);
          }
        }
        saveFolderPaths(merged);
        return merged;
      });
      const videos = flattenVideoNodes(newNodes);
      if (!videoInfo?.path && videos.length > 0) {
        handleOpenVideo(videos[0].path);
      } else {
        showToast(`Đã nạp ${newNodes.length} thư mục (${videos.length} video)`);
      }
    } else if (firstSingleVideo) {
      handleOpenVideo(firstSingleVideo);
    }
  };

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-screen w-screen bg-[#0d0f12] text-[#f1f2f6] select-none overflow-hidden"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDropItems}
    >
      {/* Auto-download Models (Setup Wizard) */}
      <SetupWizard onComplete={() => {}} />

      {/* In-App Self-Updater Notification */}
      <UpdateNotification />

      {/* 1. Header Bar (Chỉ hiển thị khi đang ở chế độ Trình phát Video) */}
      {viewMode === "player" && (
        <header className="h-11 border-b border-white/[0.08] px-3 flex items-center justify-between bg-[#0e1117] text-neutral-200 z-10 shrink-0 gap-2 select-none">
          {/* Nhóm Trái: Điều hướng & Nguồn Video */}
          <div className="flex items-center space-x-1.5 shrink-0 min-w-0">
            {/* Nút quay lại Landing */}
            <button
              onClick={() => setViewMode("landing")}
              className="flex items-center space-x-1.5 h-8 px-2.5 bg-neutral-900/90 hover:bg-neutral-800 text-neutral-300 hover:text-amber-400 font-medium text-xs rounded-lg border border-neutral-700/80 transition-all shrink-0 whitespace-nowrap"
              title="Quay lại Trang Giới Thiệu & Demo"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>Giới thiệu</span>
            </button>

            {/* Nút bật/tắt Cây thư mục bài học */}
            <button
              onClick={() => setShowFolderPanel((v) => !v)}
              className={`flex items-center space-x-1.5 h-8 px-2.5 rounded-lg text-xs font-medium border transition-all shrink-0 whitespace-nowrap ${
                showFolderPanel
                  ? "bg-amber-500/10 text-amber-300 border-amber-500/40"
                  : "bg-neutral-900/90 text-neutral-300 border-neutral-700/80 hover:bg-neutral-800"
              }`}
              title="Ẩn/hiện cây thư mục khóa học (Phím B)"
            >
              <Folder className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>Thư mục</span>
              {playlistVideos.length > 0 && (
                <span className="text-[10px] bg-amber-500/20 text-amber-300 font-mono px-1.5 py-0.2 rounded-full font-bold">
                  {playlistVideos.length}
                </span>
              )}
            </button>

            <div className="w-[1px] h-4 bg-white/[0.1] mx-0.5 shrink-0" />

            {/* Google Drive Picker & Dán link Drive */}
            <GoogleDrivePicker
              onPlay={(item) => handleOpenVideo(undefined, item)}
              onAddFolderToTree={handleAddDriveFolderToTree}
              onToast={showToast}
            />

            {/* Nút Thêm thư mục khóa học */}
            <button
              onClick={handleAddFolder}
              className="flex items-center space-x-1.5 h-8 px-2.5 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 hover:text-amber-200 border border-amber-500/35 rounded-lg text-xs font-medium transition-all shrink-0 whitespace-nowrap"
              title="Import thêm thư mục chứa nhiều video bài học từ máy tính"
            >
              <FolderPlus className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>Thêm thư mục</span>
            </button>

            {/* Nút Mở 1 file lẻ */}
            <button
              onClick={() => handleOpenVideo()}
              className="flex items-center space-x-1.5 h-8 px-2.5 bg-neutral-900/90 hover:bg-neutral-800 text-neutral-300 hover:text-white border border-neutral-700/80 rounded-lg text-xs font-medium transition-all shrink-0 whitespace-nowrap"
              title="Mở 1 tập tin video lẻ từ máy tính (Ctrl+O)"
            >
              <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>Mở file lẻ</span>
            </button>

            {/* Nút YouTube */}
            <button
              onClick={() => setShowYtModal(true)}
              className="flex items-center space-x-1.5 h-8 px-2.5 bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/25 rounded-lg text-xs font-medium transition-all shrink-0 whitespace-nowrap"
              title="Dán link YouTube để tự động tách phụ đề và dịch"
            >
              <Globe className="w-3.5 h-3.5 text-red-400 shrink-0" />
              <span>YouTube</span>
            </button>

            {/* Tên video đang mở */}
            {(videoInfo?.title || videoInfo?.path) && (
              <div className="hidden 2xl:flex items-center space-x-1.5 h-8 px-2.5 bg-white/[0.03] border border-white/[0.08] rounded-lg max-w-xs truncate shrink-0">
                <Film className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span
                  className="text-xs text-neutral-300 truncate"
                  title={videoInfo?.title || videoInfo.path}
                >
                  {videoInfo?.title || videoInfo.path.split(/[\/]/).pop()}
                </span>
                {currentPlaylistIndex >= 0 && (
                  <span className="text-[10px] text-amber-400 font-mono bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20 shrink-0">
                    {currentPlaylistIndex + 1}/{playlistVideos.length}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Nhóm Phải: Điều khiển Dịch & Phụ đề */}
          <div className="flex items-center space-x-1.5 shrink-0 text-xs">
            {/* Dynamic Pipeline Status Label */}
            {pipelineStatus && (
              <div className="hidden lg:flex items-center space-x-1.5 h-8 px-2.5 bg-neutral-900/80 rounded-lg border border-neutral-800 shrink-0 whitespace-nowrap">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    pipelineStatus.state === "ahead"
                      ? "bg-cyan-400"
                      : pipelineStatus.state === "catching_up"
                        ? "bg-amber-400 animate-pulse"
                        : pipelineStatus.state === "done"
                          ? "bg-emerald-400"
                          : "bg-blue-400 animate-pulse"
                  }`}
                />
                <span className="text-neutral-300 text-[11px] whitespace-nowrap">
                  {pipelineStatus.state === "ahead" &&
                    `Đón đầu (${Math.round(pipelineStatus.ahead_sec)}s)`}
                  {pipelineStatus.state === "catching_up" &&
                    "Đang đuổi kịp playhead..."}
                  {pipelineStatus.state === "processing" &&
                    `Đang dịch ${pipelineStatus.done_blocks}/${pipelineStatus.total_blocks}`}
                  {pipelineStatus.state === "backfill" && `Bù phụ đề...`}
                  {pipelineStatus.state === "done" && "Đã dịch xong toàn bộ"}
                </span>
              </div>
            )}

            {/* Bộ chọn ngôn ngữ nguồn (Source Language) */}
            <div className="flex items-center space-x-1 h-8 px-2 bg-neutral-900/90 rounded-lg border border-neutral-700/80 text-xs shrink-0 whitespace-nowrap">
              <Languages className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <select
                value={sourceLang}
                onChange={async (e) => {
                  const val = e.target.value;
                  setSourceLang(val);
                  await window.go?.main?.App?.SetSourceLang?.(val);
                  showToast(
                    val === "vi"
                      ? "Nguồn: Tiếng Việt (Bỏ qua dịch thuật - 0ms)"
                      : val === "en"
                        ? "Nguồn: Tiếng Anh"
                        : "Nguồn: Tự động nhận diện",
                  );
                }}
                className="bg-transparent text-neutral-200 outline-none text-xs cursor-pointer font-semibold whitespace-nowrap py-0 pl-0.5 pr-0"
                title="Chọn ngôn ngữ âm thanh gốc của video"
              >
                <option value="auto" className="bg-neutral-900 text-neutral-200">Auto</option>
                <option value="en" className="bg-neutral-900 text-neutral-200">EN</option>
                <option value="vi" className="bg-neutral-900 text-neutral-200">VI</option>
              </select>
            </div>

            {/* Nút bật/tắt Cloud AI (Gemini) */}
            <button
              onClick={async () => {
                try {
                  const s = await window.go?.main?.App?.GetSettings?.();
                  if (!s) return;
                  const next = !geminiEnabled;
                  await window.go?.main?.App?.SetGeminiConfig?.(
                    s.gemini_api_key || "",
                    next,
                    s.gemini_model || "gemini-3.5-flash-lite",
                  );
                  setGeminiEnabled(next);
                  showToast(
                    next
                      ? "Đã BẬT Cloud AI (Gemini 3.5 Flash-Lite)"
                      : "Đã TẮT Cloud AI (chỉ dùng GTX + Qwen)",
                  );
                } catch (e) {
                  console.error(e);
                }
              }}
              className={`flex items-center space-x-1 h-8 px-2.5 rounded-lg border text-xs font-medium transition-all shrink-0 whitespace-nowrap ${
                geminiEnabled
                  ? "bg-cyan-500/15 text-cyan-300 border-cyan-500/40 hover:bg-cyan-500/25"
                  : "bg-neutral-900/90 text-neutral-400 border-neutral-700/80 hover:bg-neutral-800"
              }`}
              title="Bật/Tắt dịch Cloud AI (Gemini) khi Google Translate bị chặn"
            >
              <Cloud className="w-3.5 h-3.5 shrink-0" />
              <span>Cloud: {geminiEnabled ? "BẬT" : "TẮT"}</span>
            </button>

            {/* Nút bật/tắt Tự động chuyển bài khi hết video */}
            <button
              onClick={() => {
                setAutoNext((v) => {
                  const next = !v;
                  showToast(
                    next
                      ? "Đã BẬT tự động chuyển bài"
                      : "Đã TẮT tự động chuyển bài",
                  );
                  return next;
                });
              }}
              className={`h-8 px-2.5 rounded-lg border text-xs font-medium transition-all shrink-0 whitespace-nowrap ${
                autoNext
                  ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/25"
                  : "bg-neutral-900/90 text-neutral-400 border-neutral-700/80 hover:bg-neutral-800"
              }`}
              title="Tự động nhảy sang video tiếp theo trong cây thư mục khi xem hết bài"
            >
              <span>Tự chuyển: {autoNext ? "BẬT" : "TẮT"}</span>
            </button>

            {/* Nút dịch đón đầu trước 1 khúc */}
            <button
              onClick={handleTriggerBufferAhead}
              className="flex items-center space-x-1 h-8 px-2 bg-neutral-900/90 hover:bg-neutral-800 text-amber-300 hover:text-amber-200 rounded-lg border border-neutral-700/80 text-xs transition-all shrink-0 whitespace-nowrap"
              title="Kích thích pipeline dịch đón đầu trước một đoạn"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span className="hidden xl:inline">Dịch trước</span>
            </button>

            {/* Subtitle Mode Button */}
            <button
              onClick={() => {
                const modes: SubtitleMode[] = ["bilingual", "vi", "en", "off"];
                const next =
                  modes[(modes.indexOf(subtitleMode) + 1) % modes.length];
                setSubtitleMode(next);
              }}
              className="flex items-center space-x-1.5 h-8 px-2.5 bg-neutral-900/90 hover:bg-neutral-800 rounded-lg text-neutral-300 text-xs border border-neutral-700/80 transition-all shrink-0 whitespace-nowrap"
              title="Chuyển chế độ hiển thị phụ đề (Song ngữ / Tiếng Việt / Tiếng Anh / Tắt)"
            >
              <Subtitles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>
                {subtitleMode === "bilingual" && "Song ngữ"}
                {subtitleMode === "vi" && "Tiếng Việt"}
                {subtitleMode === "en" && "Tiếng Anh"}
                {subtitleMode === "off" && "Tắt phụ đề"}
              </span>
            </button>

            {/* Panel danh sách phụ đề toggle */}
            <button
              onClick={() => setShowSubPanel((v) => !v)}
              className={`h-8 w-8 flex items-center justify-center rounded-lg border transition-all shrink-0 ${
                showSubPanel
                  ? "bg-amber-500/15 text-amber-400 border-amber-500/40"
                  : "bg-neutral-900/90 text-neutral-300 border-neutral-700/80 hover:bg-neutral-800"
              }`}
              title="Bật/tắt panel danh sách phụ đề"
            >
              <List className="w-4 h-4" />
            </button>

            {/* Xuất phụ đề (.SRT / .VTT) Dropdown Menu */}
            <div className="relative shrink-0">
              <button
                onClick={() => setShowExportMenu((v) => !v)}
                className="flex items-center space-x-1.5 h-8 px-2.5 rounded-lg bg-neutral-900/90 hover:bg-neutral-800 text-neutral-200 border border-neutral-700/80 text-xs transition-all whitespace-nowrap"
                title="Xuất file phụ đề độc lập (.SRT / .VTT)"
              >
                <Download className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span>Sub</span>
              </button>

              {showExportMenu && (
                <div className="absolute right-0 mt-1.5 w-60 bg-[#161920] border border-neutral-700 rounded-lg shadow-2xl py-1.5 z-50 text-xs">
                  <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-400/90">
                    Định dạng .SRT (Phổ biến)
                  </div>
                  <button
                    onClick={() => handleExportSubtitle("srt", "target")}
                    className="w-full text-left px-3 py-1.5 hover:bg-neutral-800 text-neutral-200 flex items-center justify-between"
                  >
                    <span>Chỉ Tiếng Việt</span>
                    <span className="text-[10px] text-neutral-500 font-mono">
                      _vi.srt
                    </span>
                  </button>
                  <button
                    onClick={() => handleExportSubtitle("srt", "bilingual")}
                    className="w-full text-left px-3 py-1.5 hover:bg-neutral-800 text-neutral-200 flex items-center justify-between"
                  >
                    <span>Song ngữ (Anh + Việt)</span>
                    <span className="text-[10px] text-neutral-500 font-mono">
                      _bilingual.srt
                    </span>
                  </button>
                  <button
                    onClick={() => handleExportSubtitle("srt", "source")}
                    className="w-full text-left px-3 py-1.5 hover:bg-neutral-800 text-neutral-200 flex items-center justify-between"
                  >
                    <span>Chỉ Tiếng Anh gốc</span>
                    <span className="text-[10px] text-neutral-500 font-mono">
                      _en.srt
                    </span>
                  </button>

                  <div className="border-t border-neutral-800 my-1" />

                  <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-sky-400/90">
                    Định dạng .VTT (Web)
                  </div>
                  <button
                    onClick={() => handleExportSubtitle("vtt", "target")}
                    className="w-full text-left px-3 py-1.5 hover:bg-neutral-800 text-neutral-200 flex items-center justify-between"
                  >
                    <span>Chỉ Tiếng Việt</span>
                    <span className="text-[10px] text-neutral-500 font-mono">
                      _vi.vtt
                    </span>
                  </button>
                  <button
                    onClick={() => handleExportSubtitle("vtt", "bilingual")}
                    className="w-full text-left px-3 py-1.5 hover:bg-neutral-800 text-neutral-200 flex items-center justify-between"
                  >
                    <span>Song ngữ (Anh + Việt)</span>
                    <span className="text-[10px] text-neutral-500 font-mono">
                      _bilingual.vtt
                    </span>
                  </button>
                  <button
                    onClick={() => handleExportSubtitle("vtt", "source")}
                    className="w-full text-left px-3 py-1.5 hover:bg-neutral-800 text-neutral-200 flex items-center justify-between"
                  >
                    <span>Chỉ Tiếng Anh gốc</span>
                    <span className="text-[10px] text-neutral-500 font-mono">
                      _en.vtt
                    </span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
      )}

      {/* Toast thông báo phím tắt */}
      {toastMessage && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 px-3.5 py-1.5 bg-black/90 text-amber-300 border border-amber-500/50 rounded-lg text-xs shadow-2xl backdrop-blur font-medium">
          {toastMessage}
        </div>
      )}

      {/* Modal dán link YouTube tải & dịch tự động */}
      {showYtModal && (
        <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form
            onSubmit={handleStartYouTube}
            className="w-full max-w-md bg-[#161920] border border-neutral-700 rounded-lg shadow-2xl p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Globe className="w-5 h-5 text-red-400" />
                <h3 className="text-sm font-bold text-white">
                  Tải & Dịch phụ đề tự động từ YouTube
                </h3>
              </div>
              {!isDownloadingYt && (
                <button
                  type="button"
                  onClick={() => setShowYtModal(false)}
                  className="text-neutral-400 hover:text-white text-xs px-2 py-0.5 rounded"
                >
                  ✕
                </button>
              )}
            </div>

            <p className="text-xs text-neutral-400 leading-relaxed">
              Dán link video YouTube vào bên dưới. Hệ thống sẽ dùng{" "}
              <b>yt-dlp</b> tự động lấy phụ đề tiếng Anh gốc (nếu có) và video
              về máy rồi dịch sang tiếng Việt ngay lập tức.
            </p>

            <input
              type="url"
              required
              disabled={isDownloadingYt}
              value={ytUrl}
              onChange={(e) => setYtUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              className="w-full bg-neutral-900 text-xs text-white px-3 py-2.5 rounded border border-neutral-700 focus:border-amber-400 focus:outline-none disabled:opacity-50"
              autoFocus
            />

            {isDownloadingYt && (
              <div className="flex items-center space-x-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded p-2.5">
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                <span className="truncate">
                  {ytProgress || "Đang xử lý..."}
                </span>
              </div>
            )}

            <div className="flex items-center justify-end space-x-2 pt-1">
              <button
                type="button"
                disabled={isDownloadingYt}
                onClick={() => setShowYtModal(false)}
                className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs rounded disabled:opacity-50"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={isDownloadingYt || !ytUrl.trim()}
                className="flex items-center space-x-1.5 px-4 py-1.5 bg-amber-500 hover:bg-amber-600 text-black font-bold text-xs rounded shadow disabled:opacity-50"
              >
                {isDownloadingYt ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Đang tải...</span>
                  </>
                ) : (
                  <span>Tải & Dịch ngay</span>
                )}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Landing Page View */}
      <div
        className={`flex-1 relative overflow-hidden bg-[#0a0c10] flex flex-col ${viewMode === "landing" ? "" : "hidden"}`}
      >
        <LandingPage
          onOpenVideo={handleLandingOpenVideo}
          onOpenYouTube={handleLandingOpenYouTube}
          onSwitchToPlayer={handleLandingSwitchToPlayer}
          hasLoadedVideo={!!videoInfo?.path}
          isActive={viewMode === "landing"}
        />
      </div>

      {/* 2. Main Content Area (Player) */}
      <div
        className={`flex-1 flex relative overflow-hidden bg-black ${viewMode === "player" ? "" : "hidden"}`}
      >
        {/* Sidebar Trái: Cây thư mục khóa học */}
        {showFolderPanel ? (
          <CourseTreePanel
            roots={courseRoots}
            activeVideoPath={videoInfo?.path ?? null}
            completedVideos={completedVideos}
            autoCollapse={autoCollapseFolder}
            onToggleAutoCollapse={handleToggleAutoCollapse}
            onSelectVideo={handleSelectVideoFromTree}
            onAddFolder={handleAddFolder}
            onAddDriveLink={handleAddDriveLinkFromTree}
            onRemoveRoot={handleRemoveRootFolder}
            onClearAll={handleClearAllFolders}
            onClose={handleCloseFolderPanel}
          />
        ) : (
          /* Nút tai nhỏ ở sát mép trái để bật nhanh lại Cây thư mục khi đang ẩn */
          <button
            onClick={() => setShowFolderPanel(true)}
            className="absolute left-0 top-1/2 -translate-y-1/2 z-30 bg-neutral-900/75 hover:bg-amber-500 text-neutral-300 hover:text-black border border-l-0 border-neutral-700 hover:border-amber-400 rounded-r-md py-3 px-1 shadow-lg transition-all opacity-50 hover:opacity-100"
            title="Mở cây thư mục bài học (Phím B)"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        )}

        {/* Video Player Box */}
        <div
          ref={playerContainerRef}
          className="flex-1 flex items-center justify-center relative overflow-hidden"
        >
          <video
            ref={videoRef}
            className="max-h-full max-w-full object-contain"
            onClick={togglePlay}
            muted={isMuted}
            onEnded={handleVideoEnded}
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              if (d && !isNaN(d) && isFinite(d) && d > 0) {
                setDuration(d);
                reportRealDuration(d);
              }
            }}
            onDurationChange={(e) => {
              const d = e.currentTarget.duration;
              if (d && !isNaN(d) && isFinite(d) && d > 0) {
                setDuration(d);
                reportRealDuration(d);
              }
            }}
          />

          {/* Empty state when no video is loaded */}
          {!videoInfo?.path && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center z-20 bg-[#0c0e14]">
              <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mb-4 text-amber-400">
                <Film className="w-8 h-8" />
              </div>
              <h3 className="text-base font-bold text-white mb-1.5">
                Chưa có video nào được mở
              </h3>
              <p className="text-xs text-neutral-400 max-w-sm mb-5 leading-relaxed">
                Kéo thả file video vào đây, chọn mở file lẻ từ máy tính, hoặc
                xem trang giới thiệu để tìm hiểu thêm.
              </p>
              <div className="flex items-center space-x-3">
                <button
                  onClick={() => handleOpenVideo()}
                  className="px-4 py-2 bg-gradient-to-r from-amber-500 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-black font-bold text-xs rounded-lg shadow-lg shadow-amber-500/20 transition-all flex items-center space-x-1.5"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>Mở file video lẻ</span>
                </button>
                <button
                  onClick={() => setViewMode("landing")}
                  className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 font-semibold text-xs rounded-lg border border-neutral-700 transition-colors flex items-center space-x-1.5"
                >
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  <span>Trang giới thiệu</span>
                </button>
              </div>
            </div>
          )}

          {/* Codec cảnh báo không tương thích */}
          {videoInfo && !videoInfo.playable && (
            <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center p-6 text-center z-30">
              <AlertCircle className="w-12 h-12 text-amber-400 mb-3" />
              <h3 className="text-base font-semibold text-white mb-2">
                Định dạng không được hỗ trợ phát trực tiếp
              </h3>
              <p className="text-xs text-neutral-300 max-w-md mb-4">
                {videoInfo.playable_reason}
              </p>
              <button
                onClick={() =>
                  alert("Tính năng chuyển mã nền tự động đang được chuẩn bị.")
                }
                className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-black text-xs font-bold rounded shadow"
              >
                Chuyển mã để phát
              </button>
            </div>
          )}

          {/* Overlay phụ đề phong cách VLC (Hỗ trợ kéo thả tự do bất kỳ vị trí nào) */}
          {currentSubtitle && subtitleMode !== "off" && (
            <div
              onPointerDown={handleSubPointerDown}
              onPointerMove={handleSubPointerMove}
              onPointerUp={handleSubPointerUp}
              onPointerCancel={handleSubPointerUp}
              onDoubleClick={handleSubDoubleClick}
              style={
                subPos
                  ? {
                      position: "absolute",
                      left: `${subPos.xPct}%`,
                      top: `${subPos.yPct}%`,
                      transform: "translate(-50%, -50%)",
                      maxWidth: "min(48rem, calc(100% - 2rem))",
                    }
                  : {
                      position: "absolute",
                      left: "50%",
                      bottom: "4rem",
                      transform: "translateX(-50%)",
                      maxWidth: "min(48rem, calc(100% - 2rem))",
                    }
              }
              className="group/sub z-20 bg-black/80 hover:bg-black/90 px-5 py-2.5 rounded-xl text-center shadow-2xl backdrop-blur-md border border-white/10 hover:border-amber-400/40 transition-colors cursor-grab active:cursor-grabbing select-none pointer-events-auto touch-none space-y-1"
              title="Kéo thả để di chuyển vị trí phụ đề • Nhấp đúp để đặt lại vị trí mặc định"
            >
              {/* Drag Handle Tooltip */}
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 opacity-0 group-hover/sub:opacity-100 transition-opacity flex items-center justify-center bg-neutral-900/95 border border-white/20 rounded-full px-2.5 py-0.5 text-[10px] text-neutral-300 pointer-events-none shadow-md whitespace-nowrap gap-1">
                <GripHorizontal className="w-3.5 h-3.5 text-amber-400" />
                <span>Kéo thả vị trí • Nhấp đúp đặt lại</span>
              </div>

              {/* Indicator loại dịch: Chấm màu nhỏ báo hiệu API vs Cloud vs Local AI */}
              <div
                className="absolute -top-2 right-2.5 flex items-center gap-1 bg-black/85 border border-white/10 rounded-full px-1.5 py-0.5 text-[9px] pointer-events-none shadow-sm"
                title={
                  pipelineStatus?.translator_mode === "local_ai"
                    ? "Dịch bằng Local AI Qwen 2.5 (Offline)"
                    : pipelineStatus?.translator_mode === "cloud"
                    ? "Dịch bằng Gemini Cloud (Dự phòng)"
                    : "Dịch bằng API Google Cloud siêu tốc"
                }
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    pipelineStatus?.translator_mode === "local_ai"
                      ? "bg-purple-400 shadow-[0_0_6px_rgba(192,132,252,0.9)] animate-pulse"
                      : pipelineStatus?.translator_mode === "cloud"
                      ? "bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.9)]"
                      : "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]"
                  }`}
                />
                <span
                  className={`font-semibold text-[8px] uppercase tracking-wider ${
                    pipelineStatus?.translator_mode === "local_ai"
                      ? "text-purple-300"
                      : pipelineStatus?.translator_mode === "cloud"
                      ? "text-cyan-300"
                      : "text-emerald-300"
                  }`}
                >
                  {pipelineStatus?.translator_mode === "local_ai"
                    ? "Local AI"
                    : pipelineStatus?.translator_mode === "cloud"
                    ? "Cloud"
                    : "API"}
                </span>
              </div>

              {(subtitleMode === "en" || subtitleMode === "bilingual") && (
                <div className="text-neutral-300 text-sm md:text-base font-medium drop-shadow leading-relaxed pointer-events-none">
                  {currentSubtitle.source_text}
                </div>
              )}
              {(subtitleMode === "vi" || subtitleMode === "bilingual") &&
                (currentSubtitle.target_text ? (
                  <div className="text-amber-300 text-base md:text-lg font-bold drop-shadow leading-relaxed pointer-events-none">
                    {currentSubtitle.target_text}
                  </div>
                ) : subtitleMode === "vi" ? (
                  <div className="text-neutral-400 text-sm md:text-base italic drop-shadow flex items-center justify-center gap-1.5 pointer-events-none">
                    <span className="inline-block w-2 h-2 rounded-full bg-amber-400/60 animate-pulse" />
                    <span>{currentSubtitle.source_text}</span>
                  </div>
                ) : null)}
            </div>
          )}
        </div>

        {/* Side Panel Phải: Danh sách phụ đề */}
        {showSubPanel && (
          <SubtitleListPanel
            subtitles={subtitles}
            activeId={currentSubtitle?.id ?? null}
            onSeek={seekVideo}
            onClose={handleCloseSubPanel}
          />
        )}
      </div>

      {/* 3. Bottom Controls & Seekbar */}
      {viewMode === "player" && (
        <footer className="h-16 bg-player-surface border-t border-player-border px-4 flex flex-col justify-center space-y-1 z-30">
          {/* Seekbar với dải màu hiển thị các block đã xong (done_blocks) */}
          <div className="relative w-full h-3 flex items-center cursor-pointer group">
            {/* Thanh nền tổng thời gian */}
            <div className="w-full h-1.5 bg-neutral-800 rounded relative overflow-hidden">
              {/* Dải màu hiển thị các block đã hoàn tất xử lý */}
              <DoneBlocksStrip
                doneBlocks={doneBlocks}
                duration={duration}
                blockSec={videoInfo?.block_sec || 30}
              />

              {/* Thanh tiến độ đang phát */}
              <div
                style={{
                  width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`,
                }}
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
              onMouseUp={(e) =>
                seekVideo(parseFloat((e.target as HTMLInputElement).value))
              }
              onKeyUp={(e) =>
                seekVideo(parseFloat((e.target as HTMLInputElement).value))
              }
              className="absolute inset-0 opacity-0 cursor-pointer w-full"
            />
          </div>

          {/* Control Buttons */}
          <div className="flex items-center justify-between text-xs text-neutral-300">
            <div className="flex items-center space-x-2">
              {/* Nút Bài trước */}
              <button
                onClick={() => handlePlayAdjacentVideo(-1)}
                disabled={currentPlaylistIndex <= 0}
                className="p-1.5 hover:text-white disabled:opacity-30 disabled:pointer-events-none rounded"
                title="Bài trước (PageUp)"
              >
                <SkipBack className="w-4 h-4" />
              </button>

              <button
                onClick={togglePlay}
                className="p-1.5 hover:text-white rounded"
                title="Phát/Tạm dừng (Space)"
              >
                {isPlaying ? (
                  <Pause className="w-4 h-4 text-amber-400" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
              </button>

              {/* Nút Bài tiếp theo */}
              <button
                onClick={() => handlePlayAdjacentVideo(1)}
                disabled={
                  currentPlaylistIndex < 0 ||
                  currentPlaylistIndex >= playlistVideos.length - 1
                }
                className="p-1.5 hover:text-white disabled:opacity-30 disabled:pointer-events-none rounded"
                title="Bài tiếp theo (PageDown)"
              >
                <SkipForward className="w-4 h-4" />
              </button>

              {/* Volume Control */}
              <div className="flex items-center space-x-1.5 pl-1">
                <button
                  onClick={() => setIsMuted((m) => !m)}
                  className="hover:text-white"
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="w-4 h-4" />
                  ) : (
                    <Volume2 className="w-4 h-4" />
                  )}
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
              <span className="text-[11px] text-neutral-400 font-mono pl-1">
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
              <button
                onClick={toggleFullscreen}
                className="hover:text-white"
                title="Toàn màn hình (F)"
              >
                {isFullscreen ? (
                  <Minimize className="w-4 h-4" />
                ) : (
                  <Maximize className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
};

export default App;
