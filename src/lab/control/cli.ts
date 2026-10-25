import {
  answerControlRequest,
  CONTROL_STATE_DIRECTORY,
  createControlServer,
  nextControlRequest,
  type ControlAnswer,
} from "./index.js";

// serve | next <seconds> | answer <id> <base64 JSON answer>
const [mode, first, second] = process.argv.slice(2);
if (mode === "serve")
  createControlServer({ directory: CONTROL_STATE_DIRECTORY }).listen(
    80,
    "0.0.0.0",
  );
else if (mode === "next") {
  const seconds = Number(first);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 60)
    throw new Error("Wait seconds are invalid");
  const request = await nextControlRequest(
    CONTROL_STATE_DIRECTORY,
    seconds * 1_000,
  );
  if (request === null) process.exitCode = 3;
  else process.stdout.write(`${JSON.stringify(request)}\n`);
} else if (mode === "answer" && first !== undefined && second !== undefined)
  answerControlRequest(
    CONTROL_STATE_DIRECTORY,
    first,
    JSON.parse(Buffer.from(second, "base64").toString("utf8")) as ControlAnswer,
  );
else throw new Error("Unknown control mode");
