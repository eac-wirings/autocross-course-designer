// Checks GitHub Releases for a newer signed build and offers to install it.
import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const SKIP_KEY = "acd.skipUpdate";

type State =
  | { s: "idle" }
  | { s: "available"; update: Update }
  | { s: "downloading"; update: Update; got: number; total: number }
  | { s: "error"; msg: string }
  | { s: "uptodate" };

/** Runs a check on launch, and again whenever `manualCheck` changes (Help → Check for updates). */
export function UpdateBanner({ manualCheck }: { manualCheck: number }) {
  const [st, setSt] = useState<State>({ s: "idle" });

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const manual = manualCheck > 0;
    const t = setTimeout(async () => {
      try {
        const u = await check();
        if (cancelled) return;
        if (u && (manual || localStorage.getItem(SKIP_KEY) !== u.version)) setSt({ s: "available", update: u });
        else if (manual) setSt({ s: "uptodate" });
      } catch (e) {
        // Offline or no published release yet: stay quiet unless the user asked.
        if (manual && !cancelled) setSt({ s: "error", msg: String(e) });
      }
    }, manual ? 0 : 3000);
    return () => { cancelled = true; clearTimeout(t); };
  }, [manualCheck]);

  if (st.s === "idle") return null;
  const close = () => setSt({ s: "idle" });

  if (st.s === "uptodate") return <div className="update-banner"><span>You have the latest version.</span><button onClick={close}>OK</button></div>;
  if (st.s === "error") return <div className="update-banner err"><span>Couldn't check for updates: {st.msg}</span><button onClick={close}>OK</button></div>;

  const u = st.update;
  if (st.s === "downloading") {
    const pct = st.total ? Math.round((st.got / st.total) * 100) : 0;
    return <div className="update-banner"><span>Downloading v{u.version}… {st.total ? `${pct}%` : ""} The app restarts when it's done.</span></div>;
  }
  const install = async () => {
    let got = 0, total = 0;
    setSt({ s: "downloading", update: u, got, total });
    try {
      await u.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        if (ev.event === "Progress") got += ev.data.chunkLength;
        setSt({ s: "downloading", update: u, got, total });
      });
      await relaunch();
    } catch (e) {
      setSt({ s: "error", msg: String(e) });
    }
  };
  return (
    <div className="update-banner">
      <span><b>Version {u.version} is available.</b>{u.body ? ` ${u.body.split("\n")[0].slice(0, 140)}` : ""} Your work is saved automatically.</span>
      <button className="primary" onClick={install}>Install and restart</button>
      <button onClick={() => { localStorage.setItem(SKIP_KEY, u.version); close(); }}>Skip this version</button>
      <button onClick={close}>Later</button>
    </div>
  );
}
