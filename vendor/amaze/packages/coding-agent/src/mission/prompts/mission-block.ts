import { type ActiveMissionPacket, renderActiveMissionPacket } from "../context-packet";

export function renderMissionBlock(packet: ActiveMissionPacket | null | undefined): string {
	return renderActiveMissionPacket(packet);
}
