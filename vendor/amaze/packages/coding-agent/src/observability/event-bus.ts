import { TypedEventBus } from "./bus-core";
import type { SessionEvent } from "./event-schema";

export type SessionEventSubscriber = (event: SessionEvent) => void;
export type Unsubscribe = () => void;

export class EventBus extends TypedEventBus<SessionEvent> {}
