import { useSyncExternalStore } from "react";

// Hash routes: #/ (tower), #/runs, #/runs/<id>, #/postmortem
export type Route = { page: "tower" } | { page: "runs" } | { page: "run"; id: string } | { page: "postmortem" };

function parse(hash: string): Route {
  const path = hash.replace(/^#/, "");
  const run = path.match(/^\/runs\/([\w-]+)/);
  if (run) return { page: "run", id: run[1]! };
  if (path.startsWith("/runs")) return { page: "runs" };
  if (path.startsWith("/postmortem")) return { page: "postmortem" };
  return { page: "tower" };
}

const subscribe = (fn: () => void) => {
  window.addEventListener("hashchange", fn);
  return () => window.removeEventListener("hashchange", fn);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  return parse(hash);
}

export function navigate(path: string): void {
  location.hash = path;
}
