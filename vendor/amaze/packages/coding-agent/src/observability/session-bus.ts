import { EventBus } from "./event-bus";

const sessionBuses = new WeakMap<object, EventBus>();

export function getSessionEventBus(session: object): EventBus {
	const existing = sessionBuses.get(session);
	if (existing) return existing;
	const bus = new EventBus();
	sessionBuses.set(session, bus);
	return bus;
}
