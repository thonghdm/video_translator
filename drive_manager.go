package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/drive/v3"
	"google.golang.org/api/option"
)

const (
	// Tiền tố đường dẫn ảo của video Google Drive: gdrive://<fileId>
	driveScheme = "gdrive://"

	driveCallbackAddr = "127.0.0.1:8989"
	driveRedirectURL  = "http://127.0.0.1:8989/oauth/callback"
	driveFolderMime   = "application/vnd.google-apps.folder"
	driveShortcutMime = "application/vnd.google-apps.shortcut"
	driveMediaURLFmt  = "https://www.googleapis.com/drive/v3/files/%s?alt=media&supportsAllDrives=true"

	driveLoginTimeout  = 3 * time.Minute
	driveMaxSubtitleSz = 5 << 20 // 5MB là quá đủ cho 1 file phụ đề
)

// Client ID / Secret có thể được "nhúng" lúc build:
//
//	go build -ldflags "-X main.DriveClientID=xxx -X main.DriveClientSecret=yyy"
//
// Nếu để trống, hệ thống đọc lần lượt:
//  1. Biến môi trường SUBTRANS_GDRIVE_CLIENT_ID / SUBTRANS_GDRIVE_CLIENT_SECRET
//  2. File %LOCALAPPDATA%\SubTrans\drive_credentials.json (file JSON "OAuth client" tải từ Google Cloud Console)
var (
	DriveClientID     string
	DriveClientSecret string
)

var (
	// ErrDriveNotLoggedIn trả về khi chưa đăng nhập hoặc refresh token đã bị thu hồi
	ErrDriveNotLoggedIn = errors.New("chưa kết nối Google Drive")

	driveFileIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{6,160}$`)
)

// DriveItem là 1 thư mục hoặc 1 video trên Google Drive
type DriveItem struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	MimeType      string  `json:"mime_type"`
	Size          int64   `json:"size"`
	ThumbnailLink string  `json:"thumbnail_link"`
	IsFolder      bool    `json:"is_folder"`
	DurationSec   float64 `json:"duration_sec"`  // 0 nếu Drive chưa xử lý xong metadata
	SubtitleID    string  `json:"subtitle_id"`   // ID file .srt/.vtt trùng tên trong cùng thư mục (nếu có)
	SubtitleName  string  `json:"subtitle_name"` // tên file phụ đề tìm thấy
}

// DriveManager quản lý OAuth2, token, duyệt file và proxy stream Google Drive
type DriveManager struct {
	mu          sync.Mutex // bảo vệ ctx, src, loginActive, caches
	fileMu      sync.Mutex // tuần tự hóa đọc/ghi drive_token.json
	ctx         context.Context
	tokenPath   string
	src         *persistingTokenSource
	loginActive bool

	streamToken string // token ngẫu nhiên bảo vệ route /drive/stream (chống tiến trình khác trên máy gọi bừa)
	subCache    map[string][]WhisperSegment
	names       map[string]string
	durations   map[string]float64
	subIDs      map[string]string // videoID -> subtitle fileID (ghi nhận khi quét cây thư mục)
	// Không đặt Timeout tổng vì response là luồng video dài
	httpClient *http.Client
}

var (
	driveMgr     *DriveManager
	driveMgrOnce sync.Once
)

// GetDriveManager trả về singleton DriveManager
func GetDriveManager() *DriveManager {
	driveMgrOnce.Do(func() {
		localAppData := os.Getenv("LOCALAPPDATA")
		if localAppData == "" {
			localAppData = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
		}
		dir := filepath.Join(localAppData, "SubTrans")
		_ = os.MkdirAll(dir, 0755)

		tb := make([]byte, 16)
		_, _ = rand.Read(tb)

		driveMgr = &DriveManager{
			tokenPath:   filepath.Join(dir, "drive_token.json"),
			streamToken: hex.EncodeToString(tb),
			subCache:    make(map[string][]WhisperSegment),
			names:       make(map[string]string),
			durations:   make(map[string]float64),
			subIDs:      make(map[string]string),
			httpClient: &http.Client{
				Transport: &http.Transport{
					Proxy:                 http.ProxyFromEnvironment,
					DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
					TLSHandshakeTimeout:   15 * time.Second,
					ResponseHeaderTimeout: 30 * time.Second,
					IdleConnTimeout:       90 * time.Second,
					MaxIdleConnsPerHost:   8,
					DisableCompression:    true, // video đã nén, và tránh Go tự gỡ nén làm sai Content-Length/Range
					ForceAttemptHTTP2:     true,
				},
			},
		}
	})
	return driveMgr
}

// SetContext gán Wails context để bắn event lên UI
func (dm *DriveManager) SetContext(ctx context.Context) {
	dm.mu.Lock()
	dm.ctx = ctx
	dm.mu.Unlock()
}

func (dm *DriveManager) emit(event string, data ...interface{}) {
	dm.mu.Lock()
	ctx := dm.ctx
	dm.mu.Unlock()
	if ctx != nil {
		runtime.EventsEmit(ctx, event, data...)
	}
}

// ---------------------------------------------------------------------------
// Đường dẫn ảo gdrive://<fileId>
// ---------------------------------------------------------------------------

// IsDrivePath cho biết path có phải video Google Drive không
func IsDrivePath(path string) bool {
	return strings.HasPrefix(path, driveScheme)
}

// DriveFileIDFromPath tách fileId từ gdrive://<fileId>
func DriveFileIDFromPath(path string) string {
	return strings.TrimPrefix(path, driveScheme)
}

// DrivePathFromID tạo đường dẫn ảo từ fileId
func DrivePathFromID(fileID string) string {
	return driveScheme + fileID
}

// ResolveMediaInput trả về input cho ffmpeg/ffprobe: file local giữ nguyên,
// video Drive được ánh xạ sang URL loopback proxy.
func ResolveMediaInput(path string) string {
	if !IsDrivePath(path) {
		return path
	}
	u, err := GetDriveManager().StreamURL(DriveFileIDFromPath(path))
	if err != nil {
		return path // ffmpeg sẽ lỗi và pipeline tự xử lý qua handleBlockFailure
	}
	return u
}

// DriveDisplayName trả về tên file đã biết của video Drive (hoặc "" nếu không có)
func DriveDisplayName(path string) string {
	if !IsDrivePath(path) {
		return ""
	}
	dm := GetDriveManager()
	dm.mu.Lock()
	defer dm.mu.Unlock()
	return dm.names[DriveFileIDFromPath(path)]
}

// GetDriveSubtitleSegments trả về phụ đề gốc đã tải sẵn trong RAM cho video Drive (nil nếu không có)
func GetDriveSubtitleSegments(path string) []WhisperSegment {
	if !IsDrivePath(path) {
		return nil
	}
	dm := GetDriveManager()
	dm.mu.Lock()
	defer dm.mu.Unlock()
	return dm.subCache[DriveFileIDFromPath(path)]
}

// StreamURL tạo URL loopback proxy cho 1 fileId
func (dm *DriveManager) StreamURL(fileID string) (string, error) {
	if !driveFileIDRe.MatchString(fileID) {
		return "", fmt.Errorf("Google Drive file ID không hợp lệ")
	}
	ms, err := GetMediaServer()
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("http://127.0.0.1:%d/drive/stream?id=%s&t=%s", ms.port, url.QueryEscape(fileID), dm.streamToken), nil
}

// ---------------------------------------------------------------------------
// Cấu hình OAuth2 + lưu trữ token dạng file JSON phẳng
// ---------------------------------------------------------------------------

func (dm *DriveManager) oauthConfig() (*oauth2.Config, error) {
	scopes := []string{drive.DriveReadonlyScope}

	clientID, clientSecret := DriveClientID, DriveClientSecret
	if clientID == "" {
		clientID = os.Getenv("SUBTRANS_GDRIVE_CLIENT_ID")
		clientSecret = os.Getenv("SUBTRANS_GDRIVE_CLIENT_SECRET")
	}
	if clientID != "" {
		return &oauth2.Config{
			ClientID:     clientID,
			ClientSecret: clientSecret,
			Endpoint:     google.Endpoint,
			RedirectURL:  driveRedirectURL,
			Scopes:       scopes,
		}, nil
	}

	credPath := filepath.Join(filepath.Dir(dm.tokenPath), "drive_credentials.json")
	data, err := os.ReadFile(credPath)
	if err != nil {
		return nil, fmt.Errorf("chưa cấu hình Google OAuth Client: hãy đặt file drive_credentials.json vào %s hoặc đặt biến môi trường SUBTRANS_GDRIVE_CLIENT_ID / SUBTRANS_GDRIVE_CLIENT_SECRET", filepath.Dir(dm.tokenPath))
	}
	cfg, err := google.ConfigFromJSON(data, scopes...)
	if err != nil {
		return nil, fmt.Errorf("file drive_credentials.json không hợp lệ (cần loại OAuth client 'Desktop app'): %w", err)
	}
	cfg.RedirectURL = driveRedirectURL
	return cfg, nil
}

func (dm *DriveManager) readTokenFile() (*oauth2.Token, error) {
	dm.fileMu.Lock()
	defer dm.fileMu.Unlock()
	data, err := os.ReadFile(dm.tokenPath)
	if err != nil {
		return nil, err
	}
	var tok oauth2.Token
	if err := json.Unmarshal(data, &tok); err != nil {
		return nil, fmt.Errorf("drive_token.json hỏng: %w", err)
	}
	return &tok, nil
}

// writeTokenFile ghi nguyên tử (tmp + rename) để không bao giờ để lại file token dở dang
func (dm *DriveManager) writeTokenFile(tok *oauth2.Token) error {
	data, err := json.MarshalIndent(tok, "", "  ")
	if err != nil {
		return err
	}
	dm.fileMu.Lock()
	defer dm.fileMu.Unlock()
	if err := os.MkdirAll(filepath.Dir(dm.tokenPath), 0755); err != nil {
		return err
	}
	tmp := dm.tokenPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, dm.tokenPath); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// persistingTokenSource tự refresh token khi hết hạn và ghi token mới xuống đĩa
type persistingTokenSource struct {
	dm   *DriveManager
	base oauth2.TokenSource
	mu   sync.Mutex
	last *oauth2.Token
}

func (p *persistingTokenSource) Token() (*oauth2.Token, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	tok, err := p.base.Token()
	if err != nil {
		var re *oauth2.RetrieveError
		if errors.As(err, &re) && re.ErrorCode == "invalid_grant" {
			// Refresh token bị thu hồi/hết hạn -> bắt đăng nhập lại
			p.dm.dropSession()
			return nil, ErrDriveNotLoggedIn
		}
		return nil, fmt.Errorf("không thể làm mới token Google Drive: %w", err)
	}
	if p.last == nil || tok.AccessToken != p.last.AccessToken {
		p.last = tok
		if werr := p.dm.writeTokenFile(tok); werr != nil {
			fmt.Fprintf(os.Stderr, "[drive] không thể lưu token: %v\n", werr)
		}
	}
	return tok, nil
}

func (p *persistingTokenSource) lastAccessToken() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.last == nil {
		return ""
	}
	return p.last.AccessToken
}

// dropSession xóa token trong RAM và file (không gọi mạng)
func (dm *DriveManager) dropSession() {
	dm.mu.Lock()
	dm.src = nil
	dm.subCache = make(map[string][]WhisperSegment)
	dm.mu.Unlock()

	dm.fileMu.Lock()
	_ = os.Remove(dm.tokenPath)
	dm.fileMu.Unlock()
}

func (dm *DriveManager) newSource(cfg *oauth2.Config, tok *oauth2.Token) *persistingTokenSource {
	return &persistingTokenSource{
		dm:   dm,
		base: cfg.TokenSource(context.Background(), tok),
		last: tok,
	}
}

// tokenSource nạp token từ file (lần đầu) và trả về nguồn token tự refresh
func (dm *DriveManager) tokenSource() (*persistingTokenSource, error) {
	dm.mu.Lock()
	if dm.src != nil {
		s := dm.src
		dm.mu.Unlock()
		return s, nil
	}
	dm.mu.Unlock()

	tok, err := dm.readTokenFile()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrDriveNotLoggedIn
		}
		return nil, err
	}
	cfg, err := dm.oauthConfig()
	if err != nil {
		return nil, err
	}

	dm.mu.Lock()
	defer dm.mu.Unlock()
	if dm.src == nil {
		dm.src = dm.newSource(cfg, tok)
	}
	return dm.src, nil
}

// accessToken trả về access token hợp lệ (tự refresh nếu cần)
func (dm *DriveManager) accessToken() (string, error) {
	src, err := dm.tokenSource()
	if err != nil {
		return "", err
	}
	tok, err := src.Token()
	if err != nil {
		return "", err
	}
	return tok.AccessToken, nil
}

// refreshAfter401 ép refresh token khi Google trả 401 dù token chưa hết hạn theo đồng hồ.
// failedAccess là access token vừa bị từ chối: nếu đã có luồng khác refresh rồi thì bỏ qua.
func (dm *DriveManager) refreshAfter401(failedAccess string) {
	dm.mu.Lock()
	src := dm.src
	dm.mu.Unlock()
	if src == nil || src.lastAccessToken() != failedAccess {
		return
	}

	src.mu.Lock()
	cur := src.last
	src.mu.Unlock()
	if cur == nil {
		return
	}
	cfg, err := dm.oauthConfig()
	if err != nil {
		return
	}
	stale := *cur
	stale.AccessToken = ""
	stale.Expiry = time.Now().Add(-time.Hour)

	dm.mu.Lock()
	if dm.src == src { // chưa bị thay thế bởi luồng khác
		dm.src = dm.newSource(cfg, &stale)
	}
	dm.mu.Unlock()
}

// ---------------------------------------------------------------------------
// Đăng nhập / đăng xuất / trạng thái
// ---------------------------------------------------------------------------

// IsLoggedIn kiểm tra file drive_token.json tồn tại và còn dùng được
func (dm *DriveManager) IsLoggedIn() bool {
	tok, err := dm.readTokenFile()
	if err != nil || tok == nil {
		return false
	}
	return tok.RefreshToken != "" || tok.Valid()
}

// Logout xóa token trong RAM + file, thu hồi token phía Google (best-effort)
func (dm *DriveManager) Logout() error {
	tok, _ := dm.readTokenFile()
	dm.dropSession()

	if tok != nil {
		revoke := tok.RefreshToken
		if revoke == "" {
			revoke = tok.AccessToken
		}
		if revoke != "" {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://oauth2.googleapis.com/revoke",
				strings.NewReader(url.Values{"token": {revoke}}.Encode()))
			if err == nil {
				req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
				if resp, err := dm.httpClient.Do(req); err == nil {
					_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
					resp.Body.Close()
				}
			}
		}
	}

	if _, err := os.Stat(dm.tokenPath); err == nil {
		return fmt.Errorf("không thể xóa %s", dm.tokenPath)
	}
	return nil
}

type oauthResult struct {
	code string
	err  error
}

// Login mở trình duyệt, chờ callback tại 127.0.0.1:8989/oauth/callback, đổi code lấy token (PKCE) và lưu file.
func (dm *DriveManager) Login() error {
	cfg, err := dm.oauthConfig()
	if err != nil {
		return err
	}

	dm.mu.Lock()
	if dm.loginActive {
		dm.mu.Unlock()
		return fmt.Errorf("đang có phiên đăng nhập Google Drive khác, hãy hoàn tất hoặc đóng tab trình duyệt rồi thử lại sau")
	}
	dm.loginActive = true
	dm.mu.Unlock()
	defer func() {
		dm.mu.Lock()
		dm.loginActive = false
		dm.mu.Unlock()
	}()

	ln, err := net.Listen("tcp", driveCallbackAddr)
	if err != nil {
		return fmt.Errorf("không thể mở cổng %s để nhận mã xác thực (cổng đang bị chiếm?): %w", driveCallbackAddr, err)
	}

	sb := make([]byte, 16)
	if _, err := rand.Read(sb); err != nil {
		_ = ln.Close()
		return fmt.Errorf("không thể sinh state ngẫu nhiên: %w", err)
	}
	state := hex.EncodeToString(sb)
	verifier := oauth2.GenerateVerifier()

	resCh := make(chan oauthResult, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		var res oauthResult
		switch {
		case subtle.ConstantTimeCompare([]byte(q.Get("state")), []byte(state)) != 1:
			res.err = fmt.Errorf("state không khớp (có thể là yêu cầu giả mạo)")
		case q.Get("error") != "":
			res.err = fmt.Errorf("Google từ chối đăng nhập: %s", q.Get("error"))
		case q.Get("code") == "":
			res.err = fmt.Errorf("callback không có mã xác thực")
		default:
			res.code = q.Get("code")
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if res.err != nil {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, `<html><body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;text-align:center;padding-top:80px"><h2>Đăng nhập thất bại</h2><p>%s</p></body></html>`, html.EscapeString(res.err.Error()))
		} else {
			fmt.Fprint(w, `<html><body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;text-align:center;padding-top:80px"><h2>Đã kết nối Google Drive ✔</h2><p>Bạn có thể đóng tab này và quay lại SubTrans.</p></body></html>`)
		}
		select {
		case resCh <- res:
		default: // chỉ nhận callback đầu tiên
		}
	})
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	defer func() {
		shCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shCtx)
	}()

	authURL := cfg.AuthCodeURL(state,
		oauth2.AccessTypeOffline,
		oauth2.ApprovalForce, // luôn trả refresh_token
		oauth2.S256ChallengeOption(verifier),
	)
	if err := openBrowser(authURL); err != nil {
		return fmt.Errorf("không thể mở trình duyệt mặc định: %w", err)
	}

	var res oauthResult
	select {
	case res = <-resCh:
	case <-time.After(driveLoginTimeout):
		res.err = fmt.Errorf("hết thời gian chờ đăng nhập (%s)", driveLoginTimeout)
	}
	if res.err != nil {
		dm.emit("drive_auth_error", res.err.Error())
		return res.err
	}

	exCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tok, err := cfg.Exchange(exCtx, res.code, oauth2.VerifierOption(verifier))
	if err != nil {
		err = fmt.Errorf("đổi mã xác thực lấy token thất bại: %w", err)
		dm.emit("drive_auth_error", err.Error())
		return err
	}
	if tok.RefreshToken == "" {
		err = fmt.Errorf("Google không trả về refresh_token; hãy gỡ quyền của app tại myaccount.google.com/permissions rồi đăng nhập lại")
		dm.emit("drive_auth_error", err.Error())
		return err
	}
	if err := dm.writeTokenFile(tok); err != nil {
		err = fmt.Errorf("không thể lưu drive_token.json: %w", err)
		dm.emit("drive_auth_error", err.Error())
		return err
	}

	dm.mu.Lock()
	dm.src = dm.newSource(cfg, tok)
	dm.mu.Unlock()

	dm.emit("drive_auth_success", true)
	return nil
}

// openBrowser mở URL bằng trình duyệt mặc định của Windows
func openBrowser(target string) error {
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	prepareCmdPlatform(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// ---------------------------------------------------------------------------
// Duyệt thư mục / lọc video / ghép phụ đề
// ---------------------------------------------------------------------------

func escapeDriveQuery(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	return strings.ReplaceAll(s, `'`, `\'`)
}

// ListDriveItems liệt kê thư mục con + video trong folderID:
// - "" hoặc "root": Drive của tôi (My Drive)
// - "shared_with_me": Được chia sẻ với tôi (Shared with me)
// - ID cụ thể: thư mục con bên trong Drive hoặc Shared with me
// Mỗi video được gắn SubtitleID nếu cùng thư mục có file .srt/.vtt trùng tên.
func (dm *DriveManager) ListDriveItems(folderID string) ([]DriveItem, error) {
	src, err := dm.tokenSource()
	if err != nil {
		return nil, err
	}
	if folderID == "" {
		folderID = "root"
	}
	if folderID != "root" && folderID != "shared_with_me" && !driveFileIDRe.MatchString(folderID) {
		return nil, fmt.Errorf("folder ID không hợp lệ")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	svc, err := drive.NewService(ctx, option.WithTokenSource(src))
	if err != nil {
		return nil, fmt.Errorf("không thể khởi tạo Google Drive client: %w", err)
	}

	mimeFilter := fmt.Sprintf("(mimeType = '%s' or mimeType = '%s' or mimeType contains 'video/' or name contains '.srt' or name contains '.vtt')",
		driveFolderMime, driveShortcutMime)

	var q string
	if folderID == "shared_with_me" {
		q = fmt.Sprintf("sharedWithMe = true and trashed = false and %s", mimeFilter)
	} else {
		q = fmt.Sprintf("'%s' in parents and trashed = false and %s", escapeDriveQuery(folderID), mimeFilter)
	}

	var files []*drive.File
	pageToken := ""
	for {
		call := svc.Files.List().
			Q(q).
			PageSize(1000).
			SupportsAllDrives(true).
			IncludeItemsFromAllDrives(true).
			Fields("nextPageToken, files(id,name,mimeType,size,thumbnailLink,videoMediaMetadata(durationMillis),shortcutDetails(targetId,targetMimeType))").
			Context(ctx)
		if folderID != "shared_with_me" {
			call = call.OrderBy("folder,name_natural")
		} else {
			call = call.OrderBy("folder,modifiedTime desc")
		}
		if pageToken != "" {
			call = call.PageToken(pageToken)
		}
		resp, err := call.Do()
		if err != nil {
			if errors.Is(err, ErrDriveNotLoggedIn) {
				return nil, ErrDriveNotLoggedIn
			}
			return nil, fmt.Errorf("không thể liệt kê thư mục Drive: %w", err)
		}
		files = append(files, resp.Files...)
		if resp.NextPageToken == "" || len(files) > 20000 {
			break
		}
		pageToken = resp.NextPageToken
	}

	var folders, videos []DriveItem
	var subs []*drive.File
	for _, f := range files {
		fileID := f.Id
		mimeType := f.MimeType
		// Hỗ trợ lối tắt (Google Drive Shortcut) trỏ đến video hoặc thư mục thực
		if f.MimeType == driveShortcutMime && f.ShortcutDetails != nil && f.ShortcutDetails.TargetId != "" {
			fileID = f.ShortcutDetails.TargetId
			if f.ShortcutDetails.TargetMimeType != "" {
				mimeType = f.ShortcutDetails.TargetMimeType
			}
		}

		lower := strings.ToLower(f.Name)
		switch {
		case mimeType == driveFolderMime:
			folders = append(folders, DriveItem{ID: fileID, Name: f.Name, MimeType: mimeType, IsFolder: true})
		case strings.HasPrefix(mimeType, "video/"):
			it := DriveItem{ID: fileID, Name: f.Name, MimeType: mimeType, Size: f.Size, ThumbnailLink: f.ThumbnailLink}
			if f.VideoMediaMetadata != nil {
				it.DurationSec = float64(f.VideoMediaMetadata.DurationMillis) / 1000.0
			}
			videos = append(videos, it)
		case strings.HasSuffix(lower, ".srt") || strings.HasSuffix(lower, ".vtt"):
			fCopy := *f
			fCopy.Id = fileID
			subs = append(subs, &fCopy)
		}
	}

	attachSubtitles(videos, subs)

	dm.mu.Lock()
	for _, v := range videos {
		dm.names[v.ID] = v.Name
		if v.DurationSec > 0 {
			dm.durations[v.ID] = v.DurationSec
		}
	}
	dm.mu.Unlock()

	return append(folders, videos...), nil
}

// GetDuration lấy thời lượng đã lưu trong cache
func (dm *DriveManager) GetDuration(fileID string) float64 {
	dm.mu.Lock()
	defer dm.mu.Unlock()
	return dm.durations[fileID]
}

// SetDuration ghi nhận thời lượng thật (vd. từ <video>.duration) đè lên giá trị ước lượng theo dung lượng file.
func (dm *DriveManager) SetDuration(fileID string, sec float64) {
	if fileID == "" || sec <= 0 {
		return
	}
	dm.mu.Lock()
	dm.durations[fileID] = sec
	dm.mu.Unlock()
}

// SubtitleIDFor trả về ID phụ đề đi kèm đã biết của video (từ lúc quét cây thư mục)
func (dm *DriveManager) SubtitleIDFor(videoID string) string {
	dm.mu.Lock()
	defer dm.mu.Unlock()
	return dm.subIDs[videoID]
}

// FetchDurationFromDrive truy vấn trực tiếp Google Drive API để lấy thời lượng từ metadata
func (dm *DriveManager) FetchDurationFromDrive(fileID string) float64 {
	if d := dm.GetDuration(fileID); d > 0 {
		return d
	}
	src, err := dm.tokenSource()
	if err != nil {
		return 1800
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	svc, err := drive.NewService(ctx, option.WithTokenSource(src))
	if err != nil {
		return 1800
	}
	f, err := svc.Files.Get(fileID).
		SupportsAllDrives(true).
		Fields("id,name,size,mimeType,videoMediaMetadata(durationMillis),shortcutDetails(targetId)").
		Context(ctx).
		Do()
	if err != nil || f == nil {
		return 1800
	}
	// Nếu là lối tắt (shortcut), đệ quy truy vấn file gốc
	if f.MimeType == driveShortcutMime && f.ShortcutDetails != nil && f.ShortcutDetails.TargetId != "" {
		return dm.FetchDurationFromDrive(f.ShortcutDetails.TargetId)
	}
	if f.Name != "" {
		dm.mu.Lock()
		if dm.names[fileID] == "" {
			dm.names[fileID] = f.Name
		}
		dm.mu.Unlock()
	}
	if f.VideoMediaMetadata != nil && f.VideoMediaMetadata.DurationMillis > 0 {
		sec := float64(f.VideoMediaMetadata.DurationMillis) / 1000.0
		dm.mu.Lock()
		dm.durations[fileID] = sec
		dm.mu.Unlock()
		return sec
	}
	// Nếu Google Drive chưa tính durationMillis, ước lượng từ dung lượng (hoặc tối thiểu 30 phút)
	if f.Size > 0 {
		sec := float64(f.Size) / (250 * 1024)
		if sec < 300 {
			sec = 300
		}
		dm.mu.Lock()
		dm.durations[fileID] = sec
		dm.mu.Unlock()
		return sec
	}
	return 1800 // mặc định 30 phút
}

// attachSubtitles ghép file phụ đề trùng tên (tên video + hậu tố ngôn ngữ tùy chọn) vào từng video
func attachSubtitles(videos []DriveItem, subs []*drive.File) {
	if len(subs) == 0 {
		return
	}
	enSuffix := map[string]bool{"en": true, "eng": true, "en_us": true, "en-us": true, "english": true}
	viSuffix := map[string]bool{"vi": true, "vn": true, "vie": true, "vietnamese": true}

	for i := range videos {
		vstem := strings.ToLower(strings.TrimSuffix(videos[i].Name, filepath.Ext(videos[i].Name)))
		bestScore := 0
		for _, s := range subs {
			sl := strings.ToLower(s.Name)
			isSRT := strings.HasSuffix(sl, ".srt")
			sstem := strings.TrimSuffix(strings.TrimSuffix(sl, ".srt"), ".vtt")

			score := 0
			if sstem == vstem {
				score = 30
			} else if strings.HasPrefix(sstem, vstem) && len(sstem) > len(vstem) {
				rest := sstem[len(vstem):]
				if strings.ContainsRune("._- ", rune(rest[0])) {
					lang := strings.TrimLeft(rest, "._- ")
					switch {
					case enSuffix[lang]:
						score = 40
					case viSuffix[lang]:
						score = 0 // phụ đề đã dịch, không dùng làm nguồn
					default:
						score = 10
					}
				}
			}
			if score == 0 {
				continue
			}
			if isSRT {
				score++
			}
			if score > bestScore {
				bestScore = score
				videos[i].SubtitleID = s.Id
				videos[i].SubtitleName = s.Name
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Tải nhanh phụ đề về RAM
// ---------------------------------------------------------------------------

// upstreamGet gọi Google Drive (files.get alt=media) với Bearer token; tự refresh khi 401 và retry lỗi mạng tạm thời.
// Người gọi chịu trách nhiệm đóng resp.Body.
func (dm *DriveManager) upstreamGet(ctx context.Context, method, fileID, rangeHdr, ifRange string) (*http.Response, error) {
	target := fmt.Sprintf(driveMediaURLFmt, url.PathEscape(fileID))
	if method == "" {
		method = http.MethodGet
	}
	refreshed := false
	var lastErr error

	for attempt := 0; attempt < 3; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		access, err := dm.accessToken()
		if err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, method, target, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+access)
		if rangeHdr != "" {
			req.Header.Set("Range", rangeHdr)
		}
		if ifRange != "" {
			req.Header.Set("If-Range", ifRange)
		}

		resp, err := dm.httpClient.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			lastErr = err
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(attempt+1) * 400 * time.Millisecond):
			}
			continue
		}

		if resp.StatusCode == http.StatusUnauthorized && !refreshed {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
			resp.Body.Close()
			refreshed = true
			dm.refreshAfter401(access)
			attempt-- // lượt refresh không tính vào số lần retry mạng
			continue
		}
		if resp.StatusCode >= 500 && attempt < 2 {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
			resp.Body.Close()
			lastErr = fmt.Errorf("Google Drive trả về %s", resp.Status)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(attempt+1) * 400 * time.Millisecond):
			}
			continue
		}
		return resp, nil
	}
	return nil, fmt.Errorf("lỗi mạng khi gọi Google Drive: %w", lastErr)
}

// fetchDriveSubtitle tải file .srt/.vtt về RAM và parse thành segment (bypass Whisper STT)
func (dm *DriveManager) fetchDriveSubtitle(videoID, subID string) ([]WhisperSegment, error) {
	if !driveFileIDRe.MatchString(subID) {
		return nil, fmt.Errorf("subtitle ID không hợp lệ")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resp, err := dm.upstreamGet(ctx, http.MethodGet, subID, "", "")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("tải phụ đề thất bại: %s", resp.Status)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, driveMaxSubtitleSz+1))
	if err != nil {
		return nil, fmt.Errorf("đọc phụ đề thất bại: %w", err)
	}
	if len(data) > driveMaxSubtitleSz {
		return nil, fmt.Errorf("file phụ đề quá lớn")
	}
	segs := ParseSRTorVTT(string(data))
	if len(segs) == 0 {
		return nil, fmt.Errorf("file phụ đề trống hoặc sai định dạng")
	}
	dm.mu.Lock()
	dm.subCache[videoID] = segs
	dm.mu.Unlock()
	return segs, nil
}

// PrepareVideo ghi nhớ tên file và nạp phụ đề đi kèm (nếu có) trước khi mở video.
// Lỗi tải phụ đề không chặn việc phát: tự động quay về Whisper STT.
func (dm *DriveManager) PrepareVideo(fileID, name, subtitleID string) (hasSub bool) {
	dm.mu.Lock()
	if name != "" {
		dm.names[fileID] = name
	}
	delete(dm.subCache, fileID)
	dm.mu.Unlock()

	if subtitleID == "" {
		return false
	}
	if _, err := dm.fetchDriveSubtitle(fileID, subtitleID); err != nil {
		fmt.Fprintf(os.Stderr, "[drive] bỏ qua phụ đề có sẵn: %v\n", err)
		return false
	}
	return true
}

// ---------------------------------------------------------------------------
// HTTP Reverse Proxy: /drive/stream?id={fileId}  (RFC 7233 Range)
// ---------------------------------------------------------------------------

// ServeDriveStream proxy luồng video từ Google Drive, chuyển tiếp Range và header phản hồi (206, Content-Range...).
func ServeDriveStream(w http.ResponseWriter, r *http.Request) {
	dm := GetDriveManager()

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	q := r.URL.Query()
	if subtle.ConstantTimeCompare([]byte(q.Get("t")), []byte(dm.streamToken)) != 1 {
		http.Error(w, "Unauthorized stream access", http.StatusForbidden)
		return
	}
	fileID := q.Get("id")
	if !driveFileIDRe.MatchString(fileID) {
		http.Error(w, "Invalid file id", http.StatusBadRequest)
		return
	}

	// r.Context() bị hủy khi client ngắt kết nối (tua video / đóng ffmpeg) -> request lên Google cũng bị hủy
	resp, err := dm.upstreamGet(r.Context(), r.Method, fileID, r.Header.Get("Range"), r.Header.Get("If-Range"))
	if err != nil {
		switch {
		case r.Context().Err() != nil:
			// client đã bỏ đi, không cần ghi gì
		case errors.Is(err, ErrDriveNotLoggedIn):
			http.Error(w, ErrDriveNotLoggedIn.Error(), http.StatusUnauthorized)
		default:
			http.Error(w, "Google Drive upstream error: "+err.Error(), http.StatusBadGateway)
		}
		return
	}
	defer resp.Body.Close()

	// Lỗi từ Google (403 hết quota, 404...) -> trả message ngắn thay vì JSON dài; 416 giữ nguyên header Content-Range
	if resp.StatusCode >= 400 && resp.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		http.Error(w, fmt.Sprintf("Google Drive: %s %s", resp.Status, strings.TrimSpace(string(msg))), resp.StatusCode)
		return
	}

	h := w.Header()
	for _, k := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"} {
		if v := resp.Header.Get(k); v != "" {
			h.Set(k, v)
		}
	}
	if h.Get("Accept-Ranges") == "" {
		h.Set("Accept-Ranges", "bytes")
	}
	if h.Get("Content-Type") == "" {
		h.Set("Content-Type", "application/octet-stream")
	}
	h.Set("Cache-Control", "no-store")

	w.WriteHeader(resp.StatusCode) // 200 / 206 / 416 như Google trả về
	if r.Method == http.MethodHead {
		return
	}
	// Lỗi ghi (client ngắt giữa chừng) là bình thường khi tua video nên không báo lỗi
	_, _ = io.Copy(w, resp.Body)
}

// ScanDriveFolder quét đệ quy một thư mục Google Drive để dựng FolderNode cho cây bài học
func (dm *DriveManager) ScanDriveFolder(folderID, folderName string) (*FolderNode, error) {
	if folderID == "" || folderID == "root" {
		folderID = "root"
		if folderName == "" {
			folderName = "Google Drive"
		}
	} else if folderName == "" {
		// Truy vấn tên thư mục từ Drive nếu chưa có
		src, err := dm.tokenSource()
		if err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if svc, err := drive.NewService(ctx, option.WithTokenSource(src)); err == nil {
				if f, err := svc.Files.Get(folderID).SupportsAllDrives(true).Fields("name").Context(ctx).Do(); err == nil && f != nil {
					folderName = f.Name
				}
			}
		}
		if folderName == "" {
			folderName = "Drive Folder"
		}
	}

	node, ok := dm.scanDriveRecursive(folderID, folderName, 0)
	if !ok {
		return nil, fmt.Errorf("không tìm thấy video nào trong thư mục Drive: %s", folderName)
	}
	return &node, nil
}

func (dm *DriveManager) scanDriveRecursive(folderID, folderName string, depth int) (FolderNode, bool) {
	node := FolderNode{
		Name:  folderName,
		Path:  "gdrive_folder://" + folderID,
		IsDir: true,
	}
	if depth > 6 {
		return node, false
	}

	items, err := dm.ListDriveItems(folderID)
	if err != nil {
		return node, false
	}

	var dirs []FolderNode
	var files []FolderNode

	for _, it := range items {
		if it.IsFolder {
			if childNode, hasVideo := dm.scanDriveRecursive(it.ID, it.Name, depth+1); hasVideo {
				dirs = append(dirs, childNode)
			}
		} else {
			filePath := DrivePathFromID(it.ID)
			files = append(files, FolderNode{
				Name:     it.Name,
				Path:     filePath,
				IsDir:    false,
				HasCache: HasCachedSubtitles(filePath) || it.SubtitleID != "",
			})
			dm.mu.Lock()
			dm.names[it.ID] = it.Name
			if it.SubtitleID != "" {
				dm.subIDs[it.ID] = it.SubtitleID
			}
			if it.DurationSec > 0 {
				dm.durations[it.ID] = it.DurationSec
			}
			dm.mu.Unlock()
		}
	}

	if len(dirs) == 0 && len(files) == 0 {
		return node, false
	}

	node.Children = append(dirs, files...)
	return node, true
}

// ---------------------------------------------------------------------------
// Quét thư mục Drive dạng tăng dần (progressive): hiển thị ngay, nạp dần phần còn lại
// ---------------------------------------------------------------------------

// FolderName truy vấn tên thư mục Drive theo ID (trả "Drive Folder" nếu không lấy được)
func (dm *DriveManager) FolderName(folderID string) string {
	name := ""
	if src, err := dm.tokenSource(); err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if svc, err := drive.NewService(ctx, option.WithTokenSource(src)); err == nil {
			if f, err := svc.Files.Get(folderID).SupportsAllDrives(true).Fields("name").Context(ctx).Do(); err == nil && f != nil {
				name = f.Name
			}
		}
	}
	if name == "" {
		name = "Drive Folder"
	}
	return name
}

type liveDriveNode struct {
	id     string
	name   string
	loaded bool
	files  []FolderNode
	dirs   []*liveDriveNode
}

// snapshot dựng FolderNode từ trạng thái hiện tại; thư mục con chưa quét xong vẫn được giữ (rỗng)
func (n *liveDriveNode) snapshot() (FolderNode, bool) {
	node := FolderNode{Name: n.name, Path: "gdrive_folder://" + n.id, IsDir: true}
	var dirs []FolderNode
	for _, d := range n.dirs {
		if c, ok := d.snapshot(); ok {
			dirs = append(dirs, c)
		}
	}
	node.Children = append(dirs, n.files...)
	if n.loaded && len(node.Children) == 0 {
		return node, false
	}
	return node, true
}

// ScanDriveFolderProgressive quét đệ quy ở nền; sau mỗi thư mục liệt kê xong sẽ gọi onUpdate(snapshot, done).
// Người dùng có thể bấm xem video ngay từ snapshot đầu tiên, không cần chờ quét hết.
func (dm *DriveManager) ScanDriveFolderProgressive(folderID, folderName string, onUpdate func(node FolderNode, done bool)) {
	if folderID == "" {
		folderID = "root"
	}
	root := &liveDriveNode{id: folderID, name: folderName}
	var mu sync.Mutex
	emit := func(done bool) {
		mu.Lock()
		snap, _ := root.snapshot()
		mu.Unlock()
		onUpdate(snap, done)
	}

	var walk func(n *liveDriveNode, depth int)
	walk = func(n *liveDriveNode, depth int) {
		items, err := dm.ListDriveItems(n.id)
		if err != nil || depth > 6 {
			mu.Lock()
			n.loaded = true
			mu.Unlock()
			emit(false)
			return
		}
		var pending []*liveDriveNode
		mu.Lock()
		for _, it := range items {
			if it.IsFolder {
				child := &liveDriveNode{id: it.ID, name: it.Name}
				n.dirs = append(n.dirs, child)
				pending = append(pending, child)
				continue
			}
			filePath := DrivePathFromID(it.ID)
			n.files = append(n.files, FolderNode{
				Name:     it.Name,
				Path:     filePath,
				IsDir:    false,
				HasCache: HasCachedSubtitles(filePath) || it.SubtitleID != "",
			})
			dm.mu.Lock()
			dm.names[it.ID] = it.Name
			if it.SubtitleID != "" {
				dm.subIDs[it.ID] = it.SubtitleID
			}
			if it.DurationSec > 0 {
				dm.durations[it.ID] = it.DurationSec
			}
			dm.mu.Unlock()
		}
		n.loaded = len(pending) == 0
		mu.Unlock()
		emit(false)

		for _, c := range pending {
			walk(c, depth+1)
		}
		if len(pending) > 0 {
			mu.Lock()
			n.loaded = true
			mu.Unlock()
		}
	}

	walk(root, 0)
	emit(true)
}
