/**
 * Guard rails describing what a mission is allowed to touch. Used to keep
 * autonomous execution within an explicitly approved blast radius.
 */
export interface MissionScopeGuard {
	/** Glob/path patterns the mission may modify. Empty means unrestricted. */
	allowedPaths: string[];
	/** Glob/path patterns the mission must never modify. */
	deniedPaths: string[];
	/** Tool names the mission is allowed to invoke. Empty means unrestricted. */
	allowedTools?: string[];
	/** Whether the mission may spawn sub-missions. */
	allowSubMissions?: boolean;
	/** Free-form notes describing additional scope intent. */
	notes?: string;
}
