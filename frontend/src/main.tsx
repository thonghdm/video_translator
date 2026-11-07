import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { enableRenderProbeFromStorage, RenderProbeRoot } from './lib/renderProbe';

// Đo render (mặc định tắt): localStorage.setItem('vt_render_probe','1') rồi reload
enableRenderProbeFromStorage();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <RenderProbeRoot>
      <App />
    </RenderProbeRoot>
  </React.StrictMode>
);
