export type DoctorSeverity = "info" | "low" | "medium" | "high" | "critical";
export type DoctorStatus = "ok" | "degraded" | "failed";

export interface DoctorFinding {
	id: string;
	severity: DoctorSeverity;
	target?: string;
	message: string;
	hint?: string;
	meta?: Record<string, unknown>;
}

export interface DoctorReportBase {
	status: DoctorStatus;
	findings: DoctorFinding[];
}
