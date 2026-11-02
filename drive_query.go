package main

import (
	"fmt"
	"strings"
)

// escapeDriveQuery thoát ký tự đặc biệt trong giá trị của truy vấn Drive (q=...)
func escapeDriveQuery(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	return strings.ReplaceAll(s, `'`, `\'`)
}

// driveListQuery dựng truy vấn liệt kê MỌI mục con chưa xóa của một thư mục (hoặc "Được chia sẻ với tôi").
//
// Cố ý KHÔNG có điều kiện `name contains '.srt'`: theo tài liệu Drive API, `contains` trên `name`
// chỉ khớp TIỀN TỐ của tên (name contains 'Hello' khớp "HelloWorld", name contains 'World' thì không),
// nên điều kiện đuôi file không bao giờ khớp và mọi phụ đề đi kèm bị bỏ sót → app gọi Whisper dù đã có .srt.
// Việc nhận diện video / thư mục / .srt / .vtt do ListDriveItems lọc ở phía client.
func driveListQuery(folderID string) string {
	if folderID == "shared_with_me" {
		return "sharedWithMe = true and trashed = false"
	}
	return fmt.Sprintf("'%s' in parents and trashed = false", escapeDriveQuery(folderID))
}
