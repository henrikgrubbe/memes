import { NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
import { WorkerApiLive } from "./worker-app.js";

NodeRuntime.runMain(Layer.launch(WorkerApiLive));
