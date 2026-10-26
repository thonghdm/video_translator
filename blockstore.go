package main

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// CacheMeta lưu thông tin kiểm tra tính hợp lệ của cache
type CacheMeta struct {
	Version      string  `json:"version"`
	BlockSec     float64 `json:"block_sec"`
	OverlapSec   float64 `json:"overlap_sec"`
	WhisperModel string  `json:"whisper_model"`
	LlamaModel   string  `json:"llama_model"`
	DurationSec  float64 `json:"duration_sec"`
}

// BlockStore quản lý cache theo block cả trong RAM và trên đĩa cứng
type BlockStore struct {
	mu        sync.RWMutex
	cacheDir  string
	metaPath  string
	blocksDir string
	meta      CacheMeta
	itemsMap  map[int][]SubtitleItem // blockIdx -> items
}

// ComputeVideoHash tính mã SHA-1 định danh video dựa trên đường dẫn + kích thước + mtime
func ComputeVideoHash(videoPath string) (string, int64, int64, error) {
	// Video Google Drive: định danh bằng SHA-1 của fileId (không có file local để stat)
	if IsDrivePath(videoPath) {
		sum := sha1.Sum([]byte(DriveFileIDFromPath(videoPath)))
		return hex.EncodeToString(sum[:]), 0, 0, nil
	}

	fi, err := os.Stat(videoPath)
	if err != nil {
		return "", 0, 0, fmt.Errorf("không thể đọc thông tin video: %w", err)
	}

	size := fi.Size()
	mtime := fi.ModTime().UnixNano()
	raw := fmt.Sprintf("%s|%d|%d", videoPath, size, mtime)

	h := sha1.New()
	h.Write([]byte(raw))
	hashStr := hex.EncodeToString(h.Sum(nil))

	return hashStr, size, mtime, nil
}

// NewBlockStore khởi tạo BlockStore cho video đang mở
func NewBlockStore(videoPath string, meta CacheMeta) (*BlockStore, error) {
	hashStr, _, _, err := ComputeVideoHash(videoPath)
	if err != nil {
		return nil, err
	}

	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		localAppData = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
	}

	cacheDir := filepath.Join(localAppData, "SubTrans", "cache", hashStr)
	blocksDir := filepath.Join(cacheDir, "blocks")
	metaPath := filepath.Join(cacheDir, "meta.json")

	_ = os.MkdirAll(blocksDir, 0755)

	bs := &BlockStore{
		cacheDir:  cacheDir,
		metaPath:  metaPath,
		blocksDir: blocksDir,
		meta:      meta,
		itemsMap:  make(map[int][]SubtitleItem),
	}

	// Kiểm tra xem meta trên đĩa có khớp không; nếu khác thì xóa cache cũ
	if !bs.isMetaValid() {
		_ = os.RemoveAll(blocksDir)
		_ = os.MkdirAll(blocksDir, 0755)
		_ = bs.saveMeta()
	} else {
		// Nạp các block có sẵn từ đĩa vào bộ nhớ RAM
		bs.loadAllFromDisk()
	}

	return bs, nil
}

func (bs *BlockStore) isMetaValid() bool {
	data, err := os.ReadFile(bs.metaPath)
	if err != nil {
		return false
	}
	var diskMeta CacheMeta
	if err := json.Unmarshal(data, &diskMeta); err != nil {
		return false
	}
	return diskMeta.BlockSec == bs.meta.BlockSec &&
		diskMeta.OverlapSec == bs.meta.OverlapSec &&
		diskMeta.WhisperModel == bs.meta.WhisperModel &&
		diskMeta.LlamaModel == bs.meta.LlamaModel
}

func (bs *BlockStore) saveMeta() error {
	data, err := json.MarshalIndent(bs.meta, "", "  ")
	if err != nil {
		return err
	}
	tmpFile := bs.metaPath + ".tmp"
	if err := os.WriteFile(tmpFile, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmpFile, bs.metaPath)
}

func (bs *BlockStore) loadAllFromDisk() {
	files, err := os.ReadDir(bs.blocksDir)
	if err != nil {
		return
	}

	for _, f := range files {
		if f.IsDir() || filepath.Ext(f.Name()) != ".json" {
			continue
		}
		var blockIdx int
		if _, err := fmt.Sscanf(f.Name(), "%d.json", &blockIdx); err != nil {
			continue
		}

		filePath := filepath.Join(bs.blocksDir, f.Name())
		data, err := os.ReadFile(filePath)
		if err != nil {
			continue
		}

		var items []SubtitleItem
		if err := json.Unmarshal(data, &items); err != nil {
			// File hỏng -> xóa file hỏng để xử lý lại
			_ = os.Remove(filePath)
			continue
		}

		bs.itemsMap[blockIdx] = items
	}
}

// IsBlockDone kiểm tra block đã hoàn thành cả STT và dịch chưa
func (bs *BlockStore) IsBlockDone(block int) bool {
	bs.mu.RLock()
	defer bs.mu.RUnlock()
	items, exists := bs.itemsMap[block]
	if !exists {
		return false
	}
	// Kiểm tra nếu tất cả items đều đã translated (hoặc rỗng nếu là block im lặng)
	for _, it := range items {
		if !it.Translated && it.TargetText == "" && it.SourceText != "" {
			return false
		}
	}
	return true
}

// GetDoneBlocks trả về danh sách chỉ số các block đã xong
func (bs *BlockStore) GetDoneBlocks() []int {
	bs.mu.RLock()
	defer bs.mu.RUnlock()
	var done []int
	for b, items := range bs.itemsMap {
		allDone := true
		for _, it := range items {
			if !it.Translated && it.TargetText == "" && it.SourceText != "" {
				allDone = false
				break
			}
		}
		if allDone {
			done = append(done, b)
		}
	}
	sort.Ints(done)
	return done
}

// SaveBlock lưu kết quả phụ đề của một block vào RAM và đĩa cứng nguyên tử
func (bs *BlockStore) SaveBlock(block int, items []SubtitleItem) error {
	bs.mu.Lock()
	bs.itemsMap[block] = items
	bs.mu.Unlock()

	data, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return fmt.Errorf("không thể mã hóa JSON block %d: %w", block, err)
	}

	targetPath := filepath.Join(bs.blocksDir, fmt.Sprintf("%d.json", block))
	tmpPath := targetPath + ".tmp"

	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("không thể ghi file tạm block %d: %w", block, err)
	}

	// Rename nguyên tử
	if err := os.Rename(tmpPath, targetPath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("không thể rename file cache block %d: %w", block, err)
	}

	return nil
}

// GetAllItemsSorted trả về toàn bộ phụ đề đã sắp xếp theo start_sec
func (bs *BlockStore) GetAllItemsSorted() []SubtitleItem {
	bs.mu.RLock()
	defer bs.mu.RUnlock()

	var all []SubtitleItem
	for _, items := range bs.itemsMap {
		all = append(all, items...)
	}

	sort.Slice(all, func(i, j int) bool {
		return all[i].StartSec < all[j].StartSec
	})

	return all
}

// HasCachedSubtitles kiểm tra nhanh xem video đã có ít nhất 1 block phụ đề trong cache đĩa chưa
func HasCachedSubtitles(videoPath string) bool {
	hashStr, _, _, err := ComputeVideoHash(videoPath)
	if err != nil {
		return false
	}
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		localAppData = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
	}
	blocksDir := filepath.Join(localAppData, "SubTrans", "cache", hashStr, "blocks")
	entries, err := os.ReadDir(blocksDir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".json" {
			return true
		}
	}
	return false
}

// CleanupOldCaches tự động xóa các thư mục cache của các video đã quá hạn maxAge không sử dụng
func CleanupOldCaches(maxAge time.Duration) {
	if maxAge <= 0 {
		return
	}
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		localAppData = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
	}
	cacheRoot := filepath.Join(localAppData, "SubTrans", "cache")
	entries, err := os.ReadDir(cacheRoot)
	if err != nil {
		return
	}

	cutoff := time.Now().Add(-maxAge)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dirPath := filepath.Join(cacheRoot, entry.Name())
		metaFile := filepath.Join(dirPath, "meta.json")
		if fi, err := os.Stat(metaFile); err == nil {
			if fi.ModTime().Before(cutoff) {
				_ = os.RemoveAll(dirPath)
			}
		} else if fiDir, err := entry.Info(); err == nil {
			if fiDir.ModTime().Before(cutoff) {
				_ = os.RemoveAll(dirPath)
			}
		}
	}
}
