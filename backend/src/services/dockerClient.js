import Docker from "dockerode";
import fs from "fs";

/**
 * Resolves Docker connection options based on environment variables and platform defaults:
 * 1. process.env.DOCKER_SOCKET_PATH (explicit custom socket path)
 * 2. process.env.DOCKER_HOST (e.g. tcp://127.0.0.1:2375, unix:///var/run/docker.sock, or 127.0.0.1)
 * 3. process.env.DOCKER_PORT (e.g. 2375)
 * 4. Windows default named pipe: //./pipe/docker_engine
 * 5. Unix default socket: /var/run/docker.sock
 */
export function getDockerOptions() {
  if (process.env.DOCKER_SOCKET_PATH) {
    return { socketPath: process.env.DOCKER_SOCKET_PATH };
  }

  if (process.env.DOCKER_HOST) {
    const hostStr = process.env.DOCKER_HOST.trim();
    if (hostStr.startsWith("tcp://") || hostStr.startsWith("http://")) {
      try {
        const url = new URL(hostStr);
        return {
          host: url.hostname,
          port: url.port ? parseInt(url.port, 10) : 2375,
        };
      } catch {
        // Continue to fallback host string parsing
      }
    } else if (hostStr.startsWith("unix://")) {
      return { socketPath: hostStr.replace(/^unix:\/\//, "") };
    } else if (hostStr.startsWith("npipe://")) {
      return { socketPath: hostStr.replace(/^npipe:\/\//, "") };
    } else {
      return {
        host: hostStr,
        port: process.env.DOCKER_PORT ? parseInt(process.env.DOCKER_PORT, 10) : 2375,
      };
    }
  }

  if (process.env.DOCKER_PORT) {
    return {
      host: "127.0.0.1",
      port: parseInt(process.env.DOCKER_PORT, 10),
    };
  }

  // Windows Docker Desktop named pipe
  if (process.platform === "win32") {
    return { socketPath: "//./pipe/docker_engine" };
  }

  // Standard Unix socket on Linux / macOS
  const defaultUnixSocket = "/var/run/docker.sock";
  if (fs.existsSync(defaultUnixSocket)) {
    return { socketPath: defaultUnixSocket };
  }

  return { socketPath: defaultUnixSocket };
}

export function createDockerClient(options = getDockerOptions()) {
  return new Docker(options);
}

const docker = createDockerClient();

export default docker;
