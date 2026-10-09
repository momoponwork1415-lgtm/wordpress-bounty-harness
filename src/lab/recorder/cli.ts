import { createRecorderServer } from "./index.js";

const upstreamHost = process.env.WBH_UPSTREAM_HOST;
if (upstreamHost === undefined || !/^[a-z0-9][a-z0-9.-]*$/.test(upstreamHost))
  throw new Error("Recorder upstream host is missing");

createRecorderServer({
  upstreamHost,
  upstreamPort: 80,
  capturePath: "/var/lib/wbh/capture.jsonl",
  droppedPath: "/var/lib/wbh/dropped",
}).listen(80, "0.0.0.0");
