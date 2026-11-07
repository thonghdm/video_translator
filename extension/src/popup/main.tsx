import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { Popup } from "./Popup";

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <Popup />
    </React.StrictMode>
  );
}
