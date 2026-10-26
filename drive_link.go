package main

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"google.golang.org/api/drive/v3"
	"google.golang.org/api/option"
)

// DriveLinkInfo là kết quả phân giải 1 link Google Drive do người dùng dán vào
type DriveLinkInfo struct {
	Kind        string  `json:"kind"` // "folder" | "file"
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	DurationSec float64 `json:"duration_sec"`
	SubtitleID  string  `json:"subtitle_id"`
}

var (
	driveLinkPathRe  = regexp.MustCompile(`/(?:folders|file/d|d)/([A-Za-z0-9_-]{10,})`)
	driveLinkQueryRe = regexp.MustCompile(`^[A-Za-z0-9_-]{10,}$`)
)

// ExtractDriveID tách file/folder ID từ các dạng link Google Drive phổ biến:
//
//	https://drive.google.com/drive/folders/<id>?usp=sharing
//	https://drive.google.com/drive/u/0/folders/<id>
//	https://drive.google.com/file/d/<id>/view
//	https://drive.google.com/open?id=<id> | https://drive.google.com/uc?id=<id>
//	hoặc chính ID thô.
func ExtractDriveID(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", fmt.Errorf("link trống")
	}
	if driveLinkQueryRe.MatchString(s) {
		return s, nil
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("không phải link Google Drive hợp lệ")
	}
	if !strings.HasSuffix(u.Host, "google.com") {
		return "", fmt.Errorf("không phải link Google Drive hợp lệ")
	}
	if m := driveLinkPathRe.FindStringSubmatch(u.Path); len(m) == 2 {
		return m[1], nil
	}
	if id := u.Query().Get("id"); driveLinkQueryRe.MatchString(id) {
		return id, nil
	}
	return "", fmt.Errorf("không tìm thấy ID trong link Google Drive")
}

// ResolveDriveLink phân giải link thành thư mục hoặc video (xử lý cả lối tắt shortcut)
func (dm *DriveManager) ResolveDriveLink(link string) (*DriveLinkInfo, error) {
	id, err := ExtractDriveID(link)
	if err != nil {
		return nil, err
	}
	src, err := dm.tokenSource()
	if err != nil {
		return nil, ErrDriveNotLoggedIn
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	svc, err := drive.NewService(ctx, option.WithTokenSource(src))
	if err != nil {
		return nil, fmt.Errorf("không thể khởi tạo Google Drive client: %w", err)
	}

	for hop := 0; hop < 3; hop++ {
		f, err := svc.Files.Get(id).
			SupportsAllDrives(true).
			Fields("id,name,mimeType,videoMediaMetadata(durationMillis),shortcutDetails(targetId)").
			Context(ctx).
			Do()
		if err != nil {
			return nil, fmt.Errorf("không truy cập được link (kiểm tra quyền chia sẻ / tài khoản đã kết nối): %w", err)
		}
		switch {
		case f.MimeType == driveShortcutMime && f.ShortcutDetails != nil && f.ShortcutDetails.TargetId != "":
			id = f.ShortcutDetails.TargetId
			continue
		case f.MimeType == driveFolderMime:
			return &DriveLinkInfo{Kind: "folder", ID: f.Id, Name: f.Name}, nil
		case strings.HasPrefix(f.MimeType, "video/"):
			info := &DriveLinkInfo{Kind: "file", ID: f.Id, Name: f.Name}
			if f.VideoMediaMetadata != nil {
				info.DurationSec = float64(f.VideoMediaMetadata.DurationMillis) / 1000.0
			}
			dm.mu.Lock()
			dm.names[f.Id] = f.Name
			if info.DurationSec > 0 {
				dm.durations[f.Id] = info.DurationSec
			}
			dm.mu.Unlock()
			return info, nil
		default:
			return nil, fmt.Errorf("link này không phải thư mục hoặc video (%s)", f.MimeType)
		}
	}
	return nil, fmt.Errorf("lối tắt lồng quá sâu")
}
