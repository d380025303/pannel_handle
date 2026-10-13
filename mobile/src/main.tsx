import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

function renderApp() { createRoot(document.getElementById("root")!).render(<App />); }

if (import.meta.env.MODE === "browser-preview") {
  void import("./browser-preview/installBrowserPreview").then(({ installBrowserPreview }) => {
    installBrowserPreview();
    document.documentElement.dataset.runtime = "browser-preview";
    document.title = "Pannel Handle Mobile · Browser Preview";
    renderApp();
  });
} else { renderApp(); }
