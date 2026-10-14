import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/tokens.css";
import "./styles/app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "./App";
import { DataContext, type DataApi } from "./data/api";
import { createLiveData } from "./data/live";
import { createMockData } from "./data/mock";
import { initTheme } from "./lib/theme";

initTheme();

const data: DataApi = import.meta.env.VITE_MOCK === "1" ? createMockData() : createLiveData();

// The service worker dispatches this when a notification is tapped.
window.addEventListener("telepi:navigate", (event) => {
  const url = (event as CustomEvent<{ url?: string }>).detail?.url;
  if (url) void router.navigate(url);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DataContext.Provider value={data}>
      <RouterProvider router={router} />
    </DataContext.Provider>
  </StrictMode>,
);
