import React from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { App } from "./App";

function renderApp() {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

if (import.meta.env.MODE === "browser-preview") {
  void import("./browser-preview/installBrowserPreview").then(({ installBrowserPreview }) => {
    installBrowserPreview();
    document.documentElement.dataset.runtime = "browser-preview";
    document.title = "Pannel Handle · Browser Preview";
    renderApp();
  });
} else {
  renderApp();
}
