import React from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { App } from "./App";
import { AgentConversationOverlay } from "./components/agents/AgentConversationOverlay";

const isAgentConversationWindow = new URLSearchParams(window.location.search).get("view") === "agent-conversation";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isAgentConversationWindow ? <AgentConversationOverlay /> : <App />}
  </React.StrictMode>
);
