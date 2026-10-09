import React from "react";
import { createRoot } from "react-dom/client";
import { DesktopMascot } from "./components/app/DesktopMascot";
import "./styles/tokens.css";
import "./mascot.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><DesktopMascot locale="zh-CN" onAction={() => {}} /></React.StrictMode>
);
