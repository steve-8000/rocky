//! Rocky autonomous-approval normalization and synthetic `bypass` mode.
//!
//! Ports `generic-acp-agent.ts`:
//! - `ROCKY_AUTONOMOUS_APPROVAL_MODES` (lines 29-35)
//! - `ROCKY_BYPASS_MODE` (lines 41-46)
//! - `isRockyAutonomousApprovalPolicy` (lines 48-50)
//! - `appendRockyBypassMode` (lines 52-57)
//!
//! Most ACP agents (e.g. Amaze) only expose `default`/`plan` over the wire.
//! Rocky handles bypass itself (autonomous permission grants) rather than
//! forwarding an unsupported mode to the provider.

use rocky_agent_domain::AgentMode;

/// Approval-policy aliases that Rocky treats as autonomous (auto-grant).
/// Mirrors `ROCKY_AUTONOMOUS_APPROVAL_MODES` (`generic-acp-agent.ts:29-35`).
pub const ROCKY_AUTONOMOUS_APPROVAL_MODES: &[&str] = &[
    "never",
    "bypass",
    "bypassPermissions",
    "full-access",
    "allow-all",
];

/// Canonical id Rocky advertises for autonomous approval.
/// Mirrors `ROCKY_BYPASS_MODE.id` (`generic-acp-agent.ts:42`).
pub const ROCKY_BYPASS_MODE_ID: &str = "bypass";

/// Returns true if `policy` is one of the autonomous-approval aliases.
/// Mirrors `isRockyAutonomousApprovalPolicy` (`generic-acp-agent.ts:48-50`).
pub fn is_rocky_autonomous_approval(policy: &str) -> bool {
    ROCKY_AUTONOMOUS_APPROVAL_MODES.contains(&policy)
}

/// The synthetic bypass mode Rocky surfaces to clients.
/// Mirrors `ROCKY_BYPASS_MODE` (`generic-acp-agent.ts:41-46`).
pub fn rocky_bypass_mode() -> AgentMode {
    AgentMode {
        id: ROCKY_BYPASS_MODE_ID.to_string(),
        label: "Bypass".to_string(),
        description: Some(
            "Auto-approve all permission requests (handled by Rocky, not the agent)".to_string(),
        ),
    }
}

/// Append the synthetic bypass mode unless the provider already exposes an
/// autonomous mode. Mirrors `appendRockyBypassMode` (`generic-acp-agent.ts:52-57`).
pub fn append_rocky_bypass_mode(mut modes: Vec<AgentMode>) -> Vec<AgentMode> {
    if modes
        .iter()
        .any(|mode| is_rocky_autonomous_approval(&mode.id))
    {
        return modes;
    }
    modes.push(rocky_bypass_mode());
    modes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_all_autonomous_aliases() {
        for alias in ["never", "bypass", "bypassPermissions", "full-access", "allow-all"] {
            assert!(is_rocky_autonomous_approval(alias), "{alias} should be autonomous");
        }
        assert!(!is_rocky_autonomous_approval("default"));
        assert!(!is_rocky_autonomous_approval("plan"));
        assert!(!is_rocky_autonomous_approval(""));
    }

    #[test]
    fn appends_bypass_when_absent() {
        let modes = vec![AgentMode {
            id: "default".to_string(),
            label: "Default".to_string(),
            description: None,
        }];
        let out = append_rocky_bypass_mode(modes);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].id, ROCKY_BYPASS_MODE_ID);
        assert_eq!(out[1].label, "Bypass");
    }

    #[test]
    fn does_not_append_when_autonomous_mode_present() {
        let modes = vec![
            AgentMode {
                id: "default".to_string(),
                label: "Default".to_string(),
                description: None,
            },
            AgentMode {
                id: "bypassPermissions".to_string(),
                label: "Bypass Perms".to_string(),
                description: None,
            },
        ];
        let out = append_rocky_bypass_mode(modes);
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|m| m.id != ROCKY_BYPASS_MODE_ID));
    }
}
