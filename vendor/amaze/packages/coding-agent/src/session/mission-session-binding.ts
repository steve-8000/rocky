import type { MissionAutonomyProfile } from "../mission/continuation/policy";
import { MissionControlRuntime } from "../mission/core/mission-control-runtime";
import { getMissionEventBus } from "../mission/runtime";
import { DEFAULT_DB_PATH as DEFAULT_MISSION_DB_PATH, MissionStore } from "../mission/store";

/**
 * Per-session mission-runtime wiring. Encapsulates the MissionStore handle, the
 * MissionControlRuntime built on top of it, and the active-mission-id holder. AgentSession
 * composes this instead of constructing the pieces inline so the wiring can be unit-tested
 * and (eventually) reused by ACP server sessions / replay tools.
 *
 * Note: this is the P8.1 strangler step — AgentSession still mirrors the binding into its
 * existing private fields for byte-stable behavior with the rest of the 9k-line session.
 * Later P8 steps narrow AgentSession's responsibilities further.
 */
export interface MissionSessionBindingOptions {
	dbPath?: string;
	setActiveMissionId?: (id: string | undefined) => void;
	getActiveMissionId?: () => string | undefined;
	/** See {@link MissionControlDeps.autoApproveProposals}. */
	autoApproveProposals?: () => boolean;
	autonomyProfile?: () => MissionAutonomyProfile;
}

export class MissionSessionBinding {
	readonly store: MissionStore;
	readonly runtime: MissionControlRuntime;
	#activeMissionId: string | undefined = undefined;
	readonly #setActiveMissionId: (id: string | undefined) => void;
	readonly #getActiveMissionId: () => string | undefined;

	constructor(opts: MissionSessionBindingOptions = {}) {
		this.#setActiveMissionId =
			opts.setActiveMissionId ??
			(id => {
				this.#activeMissionId = id;
			});
		this.#getActiveMissionId = opts.getActiveMissionId ?? (() => this.#activeMissionId);
		this.store = new MissionStore(opts.dbPath ?? DEFAULT_MISSION_DB_PATH);
		this.runtime = new MissionControlRuntime({
			store: this.store,
			setActiveMissionId: id => {
				this.#setActiveMissionId(id);
			},
			getActiveMissionId: () => this.#getActiveMissionId(),
			...(opts.autoApproveProposals ? { autoApproveProposals: opts.autoApproveProposals } : {}),
			...(opts.autonomyProfile ? { autonomyProfile: opts.autonomyProfile } : {}),
			...(getMissionEventBus() ? { eventBus: getMissionEventBus() } : {}),
		});
	}

	getActiveMissionId(): string | undefined {
		return this.#getActiveMissionId();
	}

	setActiveMissionId(id: string | undefined): void {
		this.#setActiveMissionId(id);
	}

	dispose(): void {
		try {
			this.store.close();
		} catch {
			// close is idempotent in MissionStore
		}
	}
}
