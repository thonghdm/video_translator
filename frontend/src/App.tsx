import React from 'react';

export const App: React.FC = () => {
  return (
    <div className="flex flex-col h-screen w-screen bg-[#0d0f12] text-[#f1f2f6]">
      <header className="h-12 border-b border-player-border flex items-center px-4 justify-between bg-player-surface">
        <div className="flex items-center space-x-3">
          <span className="font-bold text-amber-400">SubTrans</span>
          <span className="text-xs text-neutral-400">Realtime Offline Video Translator</span>
        </div>
        <div className="text-xs px-2 py-1 bg-neutral-800 rounded text-neutral-300">
          Trạng thái: Sẵn sàng
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-4">
        <div className="text-center p-8 border border-dashed border-neutral-700 rounded-lg max-w-md">
          <h2 className="text-lg font-medium text-neutral-200 mb-2">Chưa mở video nào</h2>
          <p className="text-sm text-neutral-400 mb-4">
            Kéo thả video vào đây hoặc bấm nút Mở video để bắt đầu phát và dịch tự động.
          </p>
          <button className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded shadow transition-colors">
            Mở video (Ctrl+O)
          </button>
        </div>
      </main>
    </div>
  );
};

export default App;
