import docker from "./dockerClient.js";

export async function getContainerStats(containerName) {
  const container = docker.getContainer(containerName);

  const stats = await container.stats({ stream: false });

  const cpuDelta =
    stats.cpu_stats.cpu_usage.total_usage -
    stats.precpu_stats.cpu_usage.total_usage;

  const systemDelta =
    stats.cpu_stats.system_cpu_usage -
    stats.precpu_stats.system_cpu_usage;

  const cpuPercent =
    systemDelta > 0
      ? (cpuDelta / systemDelta) *
        stats.cpu_stats.online_cpus *
        100
      : 0;

  const memoryUsage = stats.memory_stats.usage;
  const memoryLimit = stats.memory_stats.limit;

  const network = stats.networks
    ? Object.values(stats.networks).reduce(
        (acc, n) => ({
          rx: acc.rx + n.rx_bytes,
          tx: acc.tx + n.tx_bytes
        }),
        { rx: 0, tx: 0 }
      )
    : { rx: 0, tx: 0 };

  return {
    cpu: cpuPercent.toFixed(2),
    memoryUsage,
    memoryLimit,
    network
  };
}