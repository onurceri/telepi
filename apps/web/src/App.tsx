import { useEffect, useMemo } from "react";
import { createBrowserRouter, NavLink, Outlet, useLocation } from "react-router-dom";
import { Icon } from "./components/ui";
import { useAppState, useData } from "./data/api";
import { DiffScreen } from "./screens/Diff";
import { NeedsYou } from "./screens/NeedsYou";
import { NewTask } from "./screens/NewTask";
import { Pairing } from "./screens/Pairing";
import { ProjectScreen, ProjectsScreen } from "./screens/Projects";
import { RequestScreen } from "./screens/Request";
import { Settings } from "./screens/Settings";
import { TaskScreen } from "./screens/Task";

function useOpenCount(): number {
  const requests = useAppState((s) => s.requests);
  return useMemo(() => requests.filter((r) => r.state === "open").length, [requests]);
}

function Shell() {
  const connection = useAppState((s) => s.connection);
  const updateReady = useAppState((s) => s.updateReady);
  const data = useData();
  const { pathname } = useLocation();
  const open = useOpenCount();
  // With the on-screen keyboard open, keep the field being typed in visible.
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
      window.setTimeout(() => el.scrollIntoView({ block: "nearest" }), 300);
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);
  const showTabs = !/^\/(tasks|requests)\//.test(pathname);

  if (connection === "unauthenticated") {
    return (
      <div className="app">
        <Pairing />
      </div>
    );
  }

  return (
    <div className={`app ${showTabs ? "has-tabs" : ""}`}>
      {updateReady && (
        <div className="notice update" role="status">
          <span>A new version of telepi is ready</span>
          <button type="button" className="link-btn" onClick={() => data.applyUpdate()}>Update</button>
        </div>
      )}
      <main className="screen" key={pathname}>
        <Outlet />
      </main>
      {showTabs && (
        <nav className="tabs" aria-label="Main">
          <NavLink to="/" end className="tab">
            <span className="tab-ico">
              <Icon name="inbox" />
              {open > 0 && <span key={open} className="n" aria-label={`${open} open`}>{open}</span>}
            </span>
            Needs you
          </NavLink>
          <NavLink to="/projects" className="tab">
            <span className="tab-ico"><Icon name="folder" /></span>
            Projects
          </NavLink>
          <NavLink to="/new" className="tab">
            <span className="tab-ico"><Icon name="plus" /></span>
            New task
          </NavLink>
          <NavLink to="/settings" className="tab">
            <span className="tab-ico"><Icon name="settings" /></span>
            Settings
          </NavLink>
        </nav>
      )}
    </div>
  );
}

export const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: "/", element: <NeedsYou /> },
      { path: "/projects", element: <ProjectsScreen /> },
      { path: "/projects/:id", element: <ProjectScreen /> },
      { path: "/new", element: <NewTask /> },
      { path: "/tasks/:id", element: <TaskScreen /> },
      { path: "/tasks/:id/diff", element: <DiffScreen /> },
      { path: "/requests/:id", element: <RequestScreen /> },
      { path: "/settings", element: <Settings /> },
      { path: "*", element: <NeedsYou /> },
    ],
  },
]);
