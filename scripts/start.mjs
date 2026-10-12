// `npm start`: run the app and open it in the browser. For anyone — no
// launcher, no watchdog (those are scripts/launch-app.sh, for a Dock icon).
// RCS_NO_OPEN=1 skips opening the browser.
import { execFile } from "node:child_process";

const port = Number(process.env.PORT || 8099);
const url = `http://localhost:${port}`;
await import("../server/index.js");

if (!process.env.RCS_NO_OPEN) {
  setTimeout(() => {
    const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
      : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
    execFile(cmd, args, () => {}); // if it can't open one, the URL is printed above
  }, 800);
}
