import { TypedEventBus } from "../observability/bus-core";
import type { MissionEvent } from "./events";

export type MissionEventSubscriber = (event: MissionEvent) => void;
export type Unsubscribe = () => void;

export class MissionEventBus extends TypedEventBus<MissionEvent> {}
