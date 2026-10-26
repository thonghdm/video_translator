package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// Khởi tạo instance ứng dụng
	app := NewApp()

	err := wails.Run(&options.App{
		Title:             "SubTrans - Realtime Offline Video Translator",
		Width:             1200,
		Height:            800,
		MinWidth:          900,
		MinHeight:         600,
		BackgroundColour: &options.RGBA{R: 13, G: 15, B: 18, A: 255},
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup:  app.startup,
		OnShutdown: app.shutdown,
		Bind: []interface{}{
			app,
		},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			BackdropType:         windows.Mica,
			Theme:                windows.Dark,
		},
	})

	if err != nil {
		println("Lỗi khởi chạy SubTrans:", err.Error())
	}
}
