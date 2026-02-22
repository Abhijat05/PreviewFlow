import Docker from "dockerode";

const docker = new Docker({
  host: "127.0.0.1",
  port: 2375
});

export default docker;