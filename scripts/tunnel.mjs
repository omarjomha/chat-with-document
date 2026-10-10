/**
 * Serves a production build through a Cloudflare quick tunnel, so a phone can
 * reach the app from any network.
 *
 * A LAN address only works when the network lets two of its clients talk to
 * each other, which campus and guest Wi-Fi almost never do, and it serves a
 * self-signed certificate that iOS distrusts. That second part is fatal here:
 * the browser hides `getUserMedia` from any origin it does not consider
 * secure, so the microphone never appears. A tunnel dials out from this
 * machine instead, so the phone needs no route back to it -- cellular is fine,
 * which also keeps WebRTC off a network that might block UDP -- and Cloudflare
 * terminates TLS with a certificate iOS already trusts.
 *
 * The tunnel speaks plain HTTP to the local server deliberately: cloudflared
 * validates the origin's certificate, so aiming it at `next dev
 * --experimental-https` would additionally need `--no-tls-verify`.
 *
 * A production build, rather than `next dev`, because HMR over a tunnel is
 * slow and `next build` ignores `allowedDevOrigins` entirely -- one less thing
 * to have configured correctly mid-demo. Pass `--skip-build` to reuse the
 * previous build.
 */

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

const PORT = Number(process.env.PORT) || 3000;
const SERVER_TIMEOUT_MS = 60_000;
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// Resolved rather than joined from the cwd: in a monorepo `next` may not be
// installed at the repo root. Run via node, which sidesteps the .cmd shim that
// spawning node_modules/.bin/next needs on Windows.
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");

const children = [];
let shuttingDown = false;

function killTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode) return;
  if (process.platform === "win32") {
    // kill() orphans Next's worker processes on Windows; taskkill /T gets them.
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child);
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

/**
 * Finds cloudflared, preferring PATH but falling back to the places the
 * installers put it: Cloudflare's Windows package does not add itself to PATH,
 * so a PATH lookup alone reports it missing on a machine where `winget list`
 * shows it installed. Set CLOUDFLARED to point at a specific binary.
 */
function resolveCloudflared() {
  const candidates = [process.env.CLOUDFLARED, "cloudflared"].filter(Boolean);

  if (process.platform === "win32") {
    for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (root) candidates.push(path.join(root, "cloudflared", "cloudflared.exe"));
    }
  } else {
    candidates.push("/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared");
  }

  for (const candidate of candidates) {
    if (!spawnSync(candidate, ["--version"], { stdio: "ignore" }).error) return candidate;
  }
  return null;
}

function cloudflaredOrExit() {
  const found = resolveCloudflared();
  if (found) return found;

  const install =
    process.platform === "win32"
      ? "winget install --id Cloudflare.cloudflared"
      : "brew install cloudflared";
  console.error(
    `\ncloudflared was not found on PATH or in the usual install locations.\n\n  ${install}\n\n` +
      `If it is already installed elsewhere, point CLOUDFLARED at it.\n\n` +
      `Or demo over the LAN with \`npm run dev:https\`, which works only on a\n` +
      `network that permits client-to-client traffic (a phone hotspot, or home\n` +
      `Wi-Fi) and will warn about its self-signed certificate.\n`,
  );
  process.exit(1);
}

function build() {
  const result = spawnSync(process.execPath, [nextBin, "build"], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error("\nBuild failed; not starting the tunnel.\n");
    process.exit(result.status ?? 1);
  }
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (shuttingDown) return;
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Server did not listen on ${port} within ${timeoutMs}ms`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

function startServer() {
  const server = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    stdio: "inherit",
  });
  children.push(server);
  server.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`\nProduction server exited (${code}).\n`);
      shutdown(code ?? 1);
    }
  });
  return server;
}

function startTunnel() {
  const tunnel = spawn(cloudflared, ["tunnel", "--url", `http://localhost:${PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(tunnel);

  let announced = false;
  const scan = (chunk) => {
    const text = String(chunk);
    const match = !announced && text.match(QUICK_TUNNEL_URL);
    if (match) {
      announced = true;
      const line = "-".repeat(match[0].length + 4);
      console.log(`\n${line}\n  ${match[0]}\n${line}\n\nOpen that on the phone. Ctrl+C to stop.\n`);
    }
    // cloudflared is noisy, so only its failures are worth relaying.
    if (/\berr(or)?\b/i.test(text)) process.stderr.write(text);
  };

  tunnel.stdout.on("data", scan);
  tunnel.stderr.on("data", scan);
  tunnel.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`\ncloudflared exited (${code}).\n`);
      shutdown(code ?? 1);
    }
  });
}

const cloudflared = cloudflaredOrExit();
if (!process.argv.includes("--skip-build")) build();
startServer();
try {
  await waitForPort(PORT, SERVER_TIMEOUT_MS);
} catch (error) {
  console.error(`\n${error.message}\n`);
  shutdown(1);
}
startTunnel();
